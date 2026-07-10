import { applyFleetLayout, getFleetSnapshot } from "@haru/db";
import { createTestDatabase } from "@haru/db/testing";
import { routeIntentSchema } from "@haru/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import {
  buildFakeFetch,
  fakeSupervisorState,
  testLayout,
  ALPHA_SUPERVISOR,
  BETA_SUPERVISOR,
} from "./fake-supervisor.test-helper.js";

import type { FakeSupervisorState } from "./fake-supervisor.test-helper.js";
import type { HaruDatabase } from "@haru/db";
import type { FleetSnapshot } from "@haru/protocol";

let database: HaruDatabase;
let close: () => Promise<void>;
let fleet: FleetSnapshot;
let alphaSupervisor: FakeSupervisorState;
let betaSupervisor: FakeSupervisorState;

async function seed(policy: Record<string, unknown> = {}) {
  await applyFleetLayout(database, testLayout(policy));
  const snapshot = await getFleetSnapshot(database, "default");
  if (!snapshot) throw new Error("seed failed");
  fleet = snapshot;
}

beforeEach(async () => {
  ({ db: database, close } = await createTestDatabase());
  // Alpha serves (awake, training idle); beta is the sleeping standby
  // running preemptible LoRA training.
  alphaSupervisor = fakeSupervisorState({ sleeping: false });
  betaSupervisor = fakeSupervisorState({ training: "running" });
});

afterEach(async () => {
  await close();
});

function makeApp(now?: () => Date) {
  return createApp({
    database,
    now,
    config: { supervisorToken: "supervisor-secret" },
    fetchFn: buildFakeFetch({
      supervisors: {
        [ALPHA_SUPERVISOR]: alphaSupervisor,
        [BETA_SUPERVISOR]: betaSupervisor,
      },
    }),
  });
}

const beta = () => fleet.domains.find((d) => d.slug === "beta")!;

async function reconcileOnce(
  app: ReturnType<typeof makeApp>,
): Promise<Record<string, unknown>> {
  const response = await app.request("/v1/fleets/default/reconcile", {
    method: "POST",
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

async function reconcileUntilSettled(
  app: ReturnType<typeof makeApp>,
  maxTicks = 12,
): Promise<Record<string, unknown>> {
  let last: Record<string, unknown> = {};
  for (let tick = 0; tick < maxTicks; tick += 1) {
    const response = await app.request("/v1/fleets/default/reconcile", {
      method: "POST",
    });
    expect(response.status).toBe(200);
    last = (await response.json()) as Record<string, unknown>;
    const operation = last.operation as { state?: string } | null;
    if (
      operation === null ||
      operation.state === "succeeded" ||
      operation.state === "failed"
    ) {
      return last;
    }
  }
  return last;
}

describe("full promotion flow", () => {
  it("promotes the standby through every step and flips routing", async () => {
    await seed();
    const app = makeApp();

    const promote = await app.request("/v1/fleets/default/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetDomainId: beta().id }),
    });
    expect(promote.status).toBe(202);

    const result = await reconcileUntilSettled(app);
    const operation = result.operation as { state: string };
    expect(operation.state).toBe("succeeded");

    // Training on the standby was stopped, vLLM woken, probed.
    expect(betaSupervisor.calls).toContain("POST /v1/training/stop");
    expect(betaSupervisor.calls).toContain("POST /v1/vllm/wake");
    expect(betaSupervisor.calls).toContain("POST /v1/probe");
    expect(betaSupervisor.training).toBe("idle");
    expect(betaSupervisor.sleeping).toBe(false);

    // The old active went to sleep and picked up training.
    expect(alphaSupervisor.calls).toContain("POST /v1/vllm/sleep");
    expect(alphaSupervisor.calls).toContain("POST /v1/training/start");
    expect(alphaSupervisor.sleeping).toBe(true);
    expect(alphaSupervisor.training).toBe("running");

    // Routing flipped: beta active + eligible, revision bumped.
    const intentResponse = await app.request("/v1/fleets/default/route-intent");
    const intent = routeIntentSchema.parse(await intentResponse.json());
    expect(intent.active?.domainSlug).toBe("beta");
    expect(intent.active?.eligible).toBe(true);
    // Seed set the pointer at revision 2; the promotion bumps to 3.
    expect(intent.revision).toBe(3);

    // DB slot states mirror the physical states.
    const after = await getFleetSnapshot(database, "default");
    const betaAfter = after?.domains.find((d) => d.slug === "beta");
    const alphaAfter = after?.domains.find((d) => d.slug === "alpha");
    expect(
      betaAfter?.slots
        .filter((s) => s.kind === "inference")
        .every((s) => s.state === "serving"),
    ).toBe(true);
    expect(
      alphaAfter?.slots
        .filter((s) => s.kind === "inference")
        .every((s) => s.state === "sleeping"),
    ).toBe(true);
    expect(
      alphaAfter?.slots
        .filter((s) => s.kind === "training")
        .every((s) => s.state === "training"),
    ).toBe(true);
  });

  it("a failed probe fails the operation and never moves routing", async () => {
    await seed();
    betaSupervisor.probeOk = false;
    const app = makeApp();

    await app.request("/v1/fleets/default/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetDomainId: beta().id }),
    });

    const result = await reconcileUntilSettled(app);
    const operation = result.operation as {
      state: string;
      error: { code: string } | null;
    };
    expect(operation.state).toBe("failed");
    expect(operation.error?.code).toBe("probe_failed");

    // Routing safety: alpha is still active on revision 1.
    const intentResponse = await app.request("/v1/fleets/default/route-intent");
    const intent = routeIntentSchema.parse(await intentResponse.json());
    expect(intent.active?.domainSlug).toBe("alpha");
    expect(intent.revision).toBe(2);

    // The half-woken standby inference slots are marked failed.
    const after = await getFleetSnapshot(database, "default");
    const betaAfter = after?.domains.find((d) => d.slug === "beta");
    expect(
      betaAfter?.slots
        .filter((s) => s.kind === "inference")
        .every((s) => s.state === "failed"),
    ).toBe(true);
  });

  it("fails the promotion when the supervisor probes only a subset of the layout's models", async () => {
    await seed();
    // Config drift: the supervisor reports a successful probe, but for
    // a model set that does not cover the layout's routing keys.
    betaSupervisor.probeResults = [
      { model: "some-other-model", ok: true, latencyMs: 5 },
    ];
    const app = makeApp();

    await app.request("/v1/fleets/default/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetDomainId: beta().id }),
    });

    const result = await reconcileUntilSettled(app);
    const operation = result.operation as {
      state: string;
      error: { code: string; message: string } | null;
    };
    expect(operation.state).toBe("failed");
    expect(operation.error?.code).toBe("probe_failed");
    expect(operation.error?.message).toContain("example-chat-small");

    // Routing safety: alpha stays active.
    const intentResponse = await app.request("/v1/fleets/default/route-intent");
    const intent = routeIntentSchema.parse(await intentResponse.json());
    expect(intent.active?.domainSlug).toBe("alpha");
  });

  it("passes the policy probe budget through to the supervisor probe call", async () => {
    await seed({ probeTimeoutMs: 12_345 });
    const app = makeApp();

    await app.request("/v1/fleets/default/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetDomainId: beta().id }),
    });
    const result = await reconcileUntilSettled(app);
    expect((result.operation as { state: string }).state).toBe("succeeded");
    expect(betaSupervisor.lastProbeBody).toMatchObject({ timeoutMs: 12_345 });
  });

  it("re-promoting after success is an idempotent no-op", async () => {
    await seed();
    const app = makeApp();
    await app.request("/v1/fleets/default/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetDomainId: beta().id }),
    });
    await reconcileUntilSettled(app);

    const again = await app.request("/v1/fleets/default/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetDomainId: beta().id }),
    });
    expect(again.status).toBe(200);
    expect((await again.json()).status).toBe("already_active");
  });

  it("auto-failover promotes the standby when the active goes stale", async () => {
    // Step timers compare the injected clock against stepStartedAt
    // written by the database's now(), so this test keeps the real
    // clock and shrinks the policy timeouts instead: the best-effort
    // demote steps against the dead alpha must time out quickly.
    await seed({
      autoFailover: true,
      heartbeatStaleMs: 50,
      sleepTimeoutMs: 1,
      startTrainingTimeoutMs: 1,
    });
    const app = makeApp();

    // First tick: alpha heartbeat lands (lastSeenAt set).
    await app.request("/v1/fleets/default/reconcile", { method: "POST" });

    // Alpha dies; wait past the staleness threshold.
    alphaSupervisor.reachable = false;
    await new Promise((resolve) => setTimeout(resolve, 100));

    const result = await reconcileUntilSettled(app);
    const operation = result.operation as {
      state: string;
      targetDomainId: string;
    } | null;
    expect(operation?.state).toBe("succeeded");
    expect(operation?.targetDomainId).toBe(beta().id);

    const intentResponse = await app.request("/v1/fleets/default/route-intent");
    const intent = routeIntentSchema.parse(await intentResponse.json());
    expect(intent.active?.domainSlug).toBe("beta");

    // Alpha was unreachable: the best-effort demote steps degraded it
    // rather than failing the operation.
    const after = await getFleetSnapshot(database, "default");
    expect(after?.domains.find((d) => d.slug === "alpha")?.state).toBe(
      "degraded",
    );
  });

  it("escalates a reachable-but-dead active to failed and auto-fails-over", async () => {
    await seed({ autoFailover: true, degradedGraceMs: 100 });
    // Alpha's supervisor answers every call, but its models are down:
    // heartbeat staleness never fires, so only the degraded
    // escalation path can promote away from it.
    alphaSupervisor.sleeping = true;
    const app = makeApp();

    // First tick: active ready + !status.ready -> degraded.
    await reconcileOnce(app);
    const degraded = await getFleetSnapshot(database, "default");
    expect(degraded?.domains.find((d) => d.slug === "alpha")?.state).toBe(
      "degraded",
    );
    expect(degraded?.activeDomainId).toBe(
      degraded?.domains.find((d) => d.slug === "alpha")?.id,
    );

    // Past the grace, the escalation flips alpha to failed and the
    // auto-failover promote fires in the same tick.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const result = await reconcileUntilSettled(app);
    const operation = result.operation as {
      state: string;
      targetDomainId: string;
    };
    expect(operation.state).toBe("succeeded");
    expect(operation.targetDomainId).toBe(beta().id);

    const intentResponse = await app.request("/v1/fleets/default/route-intent");
    const intent = routeIntentSchema.parse(await intentResponse.json());
    expect(intent.active?.domainSlug).toBe("beta");

    // The escalated old active rejoins via failed -> degraded (and
    // recovers as a standby) because its supervisor keeps answering.
    await reconcileOnce(app);
    await reconcileOnce(app);
    const after = await getFleetSnapshot(database, "default");
    expect(["degraded", "ready"]).toContain(
      after?.domains.find((d) => d.slug === "alpha")?.state,
    );
  });

  it("defers escalation while another operation holds the in-flight slot", async () => {
    await seed({ autoFailover: true, degradedGraceMs: 100 });
    // Active alpha is reachable but its models are down.
    alphaSupervisor.sleeping = true;
    // Beta starts awake so a demote has work to do; making it
    // unreachable right after the request pins the demote in flight.
    betaSupervisor.sleeping = false;
    betaSupervisor.training = "idle";
    const app = makeApp();

    await reconcileOnce(app);
    betaSupervisor.reachable = false;
    const demote = await app.request("/v1/fleets/default/demote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetDomainId: beta().id }),
    });
    expect(demote.status).toBe(202);

    // Past the grace, but the demote still holds the one-in-flight
    // slot: the active must NOT be flipped to failed (that would 503
    // its healthy traffic with no failover able to start).
    await new Promise((resolve) => setTimeout(resolve, 150));
    const tick = await reconcileOnce(app);
    expect((tick.operation as { kind: string }).kind).toBe("demote");
    const snapshot = await getFleetSnapshot(database, "default");
    expect(snapshot?.domains.find((d) => d.slug === "alpha")?.state).toBe(
      "degraded",
    );
  });

  it("a headless promote never touches other domains as a guessed old active", async () => {
    // No activeDomainSlug: the fleet starts with a null pointer, so
    // the promote records no source domain and the post-commit
    // cleanup steps must no-op instead of demoting a bystander.
    const layout = testLayout() as { activeDomainSlug?: string };
    delete layout.activeDomainSlug;
    await applyFleetLayout(database, layout);
    const snapshot = await getFleetSnapshot(database, "default");
    if (!snapshot) throw new Error("seed failed");
    fleet = snapshot;
    // With a null pointer the layout seeds every domain sleeping.
    betaSupervisor.training = "running";
    const app = makeApp();

    const promote = await app.request("/v1/fleets/default/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetDomainId: beta().id }),
    });
    expect(promote.status).toBe(202);
    const result = await reconcileUntilSettled(app);
    expect((result.operation as { state: string }).state).toBe("succeeded");

    const after = await getFleetSnapshot(database, "default");
    expect(after?.activeDomainId).toBe(beta().id);
    // Alpha was never active: no sleep or training handoff hit it.
    expect(alphaSupervisor.calls).not.toContain("POST /v1/vllm/sleep");
    expect(alphaSupervisor.calls).not.toContain("POST /v1/training/start");
  });

  it("polls domain heartbeats concurrently", async () => {
    await seed();
    let inFlight = 0;
    let maxInFlight = 0;
    const base = buildFakeFetch({
      supervisors: {
        [ALPHA_SUPERVISOR]: alphaSupervisor,
        [BETA_SUPERVISOR]: betaSupervisor,
      },
    });
    const gated: typeof fetch = async (input, init) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return await base(input, init);
      } finally {
        inFlight -= 1;
      }
    };
    const app = createApp({
      database,
      config: { supervisorToken: "supervisor-secret" },
      fetchFn: gated,
    });
    await reconcileOnce(app);
    // Both domains' status polls were in flight at the same time.
    expect(maxInFlight).toBe(2);
  });

  it("demote puts a standby to sleep and starts training", async () => {
    await seed();
    // Beta starts sleeping+training in the layout; wake it first so the
    // demote has something to do.
    betaSupervisor.sleeping = false;
    betaSupervisor.training = "idle";
    const app = makeApp();

    const demote = await app.request("/v1/fleets/default/demote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetDomainId: beta().id }),
    });
    expect(demote.status).toBe(202);

    const result = await reconcileUntilSettled(app);
    expect((result.operation as { state: string }).state).toBe("succeeded");
    expect(betaSupervisor.sleeping).toBe(true);
    expect(betaSupervisor.training).toBe("running");
  });

  it("a demote whose training never starts stays pending until the step budget fails it", async () => {
    await seed({ startTrainingTimeoutMs: 60_000 });
    betaSupervisor.sleeping = false;
    betaSupervisor.training = "idle";
    // /v1/training/start answers 200 but the run never leaves idle
    // (e.g. the training command fails to spawn).
    betaSupervisor.trainingStartIgnored = true;
    // Injected clock: step budgets compare stepStartedAt (written with
    // this same clock) against now(), so advancing the variable is a
    // deterministic time warp with no real sleeps or CI-load flakes.
    let nowMs = Date.now();
    const app = makeApp(() => new Date(nowMs));

    await app.request("/v1/fleets/default/demote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetDomainId: beta().id }),
    });

    // Inside the budget the step must be PENDING, not a false success:
    // the start call went out but the status poll still reports idle.
    for (let tick = 0; tick < 4; tick += 1) {
      await app.request("/v1/fleets/default/reconcile", { method: "POST" });
    }
    expect(betaSupervisor.calls).toContain("POST /v1/training/start");
    const inflight = await reconcileOnce(app);
    expect((inflight.operation as { state: string }).state).toBe("running");

    // Past the budget the operation fails instead of reporting a
    // demote that never actually started training.
    nowMs += 60_001;
    const result = await reconcileUntilSettled(app);
    const operation = result.operation as {
      state: string;
      error: { code: string } | null;
    };
    expect(operation.state).toBe("failed");
    expect(operation.error?.code).toBe("step_timeout");

    // The DB never recorded training slots as running.
    const after = await getFleetSnapshot(database, "default");
    const betaAfter = after?.domains.find((d) => d.slug === "beta");
    expect(
      betaAfter?.slots
        .filter((s) => s.kind === "training")
        .every((s) => s.state === "idle"),
    ).toBe(true);
  });
});
