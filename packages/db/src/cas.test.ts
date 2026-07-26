import { fleetLayoutSchema } from "@haru/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { transitionDomain, markDomainSeen } from "./repo/domains.js";
import { switchActive } from "./repo/fleets.js";
import { applyFleetLayout } from "./repo/layout.js";
import { transitionDomainSlots, transitionSlot } from "./repo/slots.js";
import { getFleetSnapshot } from "./repo/snapshots.js";
import { createTestDatabase, loadExampleFleetLayout } from "./testing/index.js";

import type { HaruDatabase } from "./client.js";
import type { FleetSnapshot } from "@haru/protocol";

let database: HaruDatabase;
let close: () => Promise<void>;
let fleet: FleetSnapshot;

beforeEach(async () => {
  ({ db: database, close } = await createTestDatabase());
  await applyFleetLayout(database, loadExampleFleetLayout());
  const snapshot = await getFleetSnapshot(database, "default");
  if (!snapshot) throw new Error("seed failed");
  fleet = snapshot;
});

afterEach(async () => {
  await close();
});

const alpha = () => fleet.domains.find((d) => d.slug === "alpha")!;
const beta = () => fleet.domains.find((d) => d.slug === "beta")!;

// Degrade alpha well before the escalation clock so the in-CAS grace guard
// (stateUpdatedAt < at - degradedGraceMs) is satisfied and each escalation
// test below isolates the guard it names rather than the grace window.
async function degradeAlphaBeforeGrace(): Promise<void> {
  await transitionDomain(
    database,
    alpha().id,
    ["ready"],
    "degraded",
    new Date(Date.now() - 60_000),
  );
}

describe("switchActive", () => {
  it("moves the pointer and bumps the revision when the CAS holds", async () => {
    const result = await switchActive(
      database,
      fleet.id,
      alpha().id,
      beta().id,
    );
    expect(result).toEqual({ routeRevision: fleet.routeRevision + 1 });
    const after = await getFleetSnapshot(database, "default");
    expect(after?.activeDomainId).toBe(beta().id);
  });

  it("loses cleanly when the expected pointer is stale", async () => {
    const result = await switchActive(
      database,
      fleet.id,
      beta().id,
      alpha().id,
    );
    expect(result).toBeNull();
    const after = await getFleetSnapshot(database, "default");
    expect(after?.activeDomainId).toBe(alpha().id);
    expect(after?.routeRevision).toBe(fleet.routeRevision);
  });

  it("requireRunningOperationId gates the pointer commit on the operation state", async () => {
    const { createOperation, claimOperation, failOperation } =
      await import("./repo/operations.js");
    const { operation } = await createOperation(database, {
      fleetId: fleet.id,
      kind: "promote",
      targetDomainId: beta().id,
    });
    // Pending (not yet claimed) does not satisfy the running guard.
    expect(
      await switchActive(
        database,
        fleet.id,
        alpha().id,
        beta().id,
        operation.id,
      ),
    ).toBeNull();
    await claimOperation(database, operation.id, "switch_active");
    expect(
      await switchActive(
        database,
        fleet.id,
        alpha().id,
        beta().id,
        operation.id,
      ),
    ).toEqual({ routeRevision: fleet.routeRevision + 1 });
    // A terminal operation can never commit routing.
    await failOperation(database, operation.id, {
      step: "switch_active",
      code: "test",
      message: "done",
    });
    expect(
      await switchActive(
        database,
        fleet.id,
        beta().id,
        alpha().id,
        operation.id,
      ),
    ).toBeNull();
  });

  it("target_not_routed blocks a failure once routing committed to the target", async () => {
    const {
      createOperation,
      claimOperation,
      completeOperation,
      failOperation,
    } = await import("./repo/operations.js");
    const { operation } = await createOperation(database, {
      fleetId: fleet.id,
      kind: "promote",
      targetDomainId: beta().id,
    });
    await claimOperation(database, operation.id, "switch_active");
    // The executor's routing CAS lands first...
    await switchActive(database, fleet.id, alpha().id, beta().id, operation.id);
    // ...so a racing timeout tick's guarded failure matches zero rows
    // instead of recording a committed promotion as failed.
    expect(
      await failOperation(
        database,
        operation.id,
        { step: "switch_active", code: "step_timeout", message: "raced" },
        "switch_active",
        "target_not_routed",
      ),
    ).toBeNull();
    await completeOperation(database, operation.id, "switch_active");

    // With the pointer elsewhere the same guarded failure lands.
    const second = await createOperation(database, {
      fleetId: fleet.id,
      kind: "promote",
      targetDomainId: alpha().id,
    });
    await claimOperation(database, second.operation.id, "switch_active");
    const failedRow = await failOperation(
      database,
      second.operation.id,
      { step: "switch_active", code: "step_timeout", message: "real" },
      "switch_active",
      "target_not_routed",
    );
    expect(failedRow?.state).toBe("failed");
  });

  it("two concurrent switches produce exactly one winner", async () => {
    const [a, b] = await Promise.all([
      switchActive(database, fleet.id, alpha().id, beta().id),
      switchActive(database, fleet.id, alpha().id, beta().id),
    ]);
    const winners = [a, b].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    const after = await getFleetSnapshot(database, "default");
    expect(after?.routeRevision).toBe(fleet.routeRevision + 1);
  });
});

describe("transitionDomain", () => {
  it("wins only from an expected state", async () => {
    expect(
      await transitionDomain(database, alpha().id, ["ready"], "degraded"),
    ).toBe(true);
    // Second identical transition finds state=degraded and loses.
    expect(
      await transitionDomain(database, alpha().id, ["ready"], "degraded"),
    ).toBe(false);
    expect(
      await transitionDomain(database, alpha().id, ["degraded"], "ready"),
    ).toBe(true);
  });

  it("rejects from-lists that violate the core state table", async () => {
    // ready -> ready is not an edge: the repo layer enforces the core
    // tables at call time instead of silently matching zero rows.
    await expect(
      transitionDomain(database, alpha().id, ["ready", "degraded"], "ready"),
    ).rejects.toThrow(/invalid domain transition/);
  });

  it("escalateDomainIfFleetIdle refuses once the pointer moved off the domain", async () => {
    const { escalateDomainIfFleetIdle } = await import("./repo/domains.js");
    await degradeAlphaBeforeGrace();
    // Beta is otherwise a viable standby, so the POINTER guard is
    // what must refuse here.
    await markDomainSeen(database, beta().id, new Date());
    // A promotion committed between the stale tick's decision and its
    // escalation UPDATE: alpha is a standby now and must stay
    // degraded (failing it would strip a failback target).
    await switchActive(database, fleet.id, alpha().id, beta().id);
    expect(
      await escalateDomainIfFleetIdle(
        database,
        alpha().id,
        fleet.id,
        new Date(),
        { heartbeatStaleMs: 30_000, degradedGraceMs: 30_000 },
      ),
    ).toBe(false);
    const after = await getFleetSnapshot(database, "default");
    expect(after?.domains.find((d) => d.slug === "alpha")?.state).toBe(
      "degraded",
    );
  });

  it("escalateDomainIfFleetIdle requires a viable standby in the same statement", async () => {
    const { escalateDomainIfFleetIdle } = await import("./repo/domains.js");
    await degradeAlphaBeforeGrace();
    // Beta has never heartbeated: no viable standby, no escalation
    // (failing the active would drop its remaining healthy models
    // with nobody able to take over).
    expect(
      await escalateDomainIfFleetIdle(
        database,
        alpha().id,
        fleet.id,
        new Date(),
        { heartbeatStaleMs: 30_000, degradedGraceMs: 30_000 },
      ),
    ).toBe(false);
    await markDomainSeen(database, beta().id, new Date());
    expect(
      await escalateDomainIfFleetIdle(
        database,
        alpha().id,
        fleet.id,
        new Date(),
        { heartbeatStaleMs: 30_000, degradedGraceMs: 30_000 },
      ),
    ).toBe(true);
  });

  it("escalateDomainIfFleetIdle refuses when the standby has a failed inference slot", async () => {
    const { escalateDomainIfFleetIdle } = await import("./repo/domains.js");
    await degradeAlphaBeforeGrace();
    await markDomainSeen(database, beta().id, new Date());
    // A concurrent heartbeat failed the standby's slot between the
    // in-memory viability decision and this UPDATE: waking it would
    // stall, so the escalation must not fire.
    await transitionDomainSlots(
      database,
      beta().id,
      "inference",
      ["sleeping"],
      "failed",
    );
    expect(
      await escalateDomainIfFleetIdle(
        database,
        alpha().id,
        fleet.id,
        new Date(),
        { heartbeatStaleMs: 30_000, degradedGraceMs: 30_000 },
      ),
    ).toBe(false);
  });

  it("escalateDomainIfFleetIdle waits out the grace window inside the CAS", async () => {
    const { escalateDomainIfFleetIdle } = await import("./repo/domains.js");
    // Models the concurrent-reconciler race: another tick recovered then
    // re-degraded the active, so its stateUpdatedAt is FRESH even though a
    // stale tick holds an old snapshot and decided to escalate. Every
    // other guard (pointer at alpha, no in-flight op, viable standby) is
    // satisfied, so ONLY the in-CAS grace guard may hold escalation back.
    const degradedAt = new Date("2026-03-01T00:00:00.000Z");
    await transitionDomain(
      database,
      alpha().id,
      ["ready"],
      "degraded",
      degradedAt,
    );
    // Beta heartbeats fresh relative to both escalation clocks below.
    const seenAt = new Date(degradedAt.getTime() + 15_000);
    const withinGraceAt = new Date(degradedAt.getTime() + 20_000);
    const pastGraceAt = new Date(degradedAt.getTime() + 40_000);
    await markDomainSeen(database, beta().id, seenAt);
    // 20s < 30s grace: the fresh degraded period has not aged out, so the
    // CAS must refuse even though the stale snapshot wanted to escalate.
    expect(
      await escalateDomainIfFleetIdle(
        database,
        alpha().id,
        fleet.id,
        withinGraceAt,
        { heartbeatStaleMs: 30_000, degradedGraceMs: 30_000 },
      ),
    ).toBe(false);
    const held = await getFleetSnapshot(database, "default");
    expect(held?.domains.find((d) => d.slug === "alpha")?.state).toBe(
      "degraded",
    );
    // Once the SAME degraded period passes the grace window, the identical
    // CAS lands.
    expect(
      await escalateDomainIfFleetIdle(
        database,
        alpha().id,
        fleet.id,
        pastGraceAt,
        { heartbeatStaleMs: 30_000, degradedGraceMs: 30_000 },
      ),
    ).toBe(true);
  });

  it("markDomainSeen records the heartbeat", async () => {
    const at = new Date("2026-01-02T03:04:05.000Z");
    await markDomainSeen(database, alpha().id, at);
    const after = await getFleetSnapshot(database, "default");
    expect(after?.domains.find((d) => d.slug === "alpha")?.lastSeenAt).toBe(
      at.toISOString(),
    );
  });
});

describe("slot transitions", () => {
  it("is guarded by the expected state (zero rows once consumed)", async () => {
    expect(
      await transitionDomainSlots(
        database,
        alpha().id,
        "inference",
        ["serving"],
        "sleeping",
      ),
    ).toBe(2);
    expect(
      await transitionDomainSlots(
        database,
        alpha().id,
        "inference",
        ["serving"],
        "sleeping",
      ),
    ).toBe(0);
  });

  it("transitionSlot moves exactly one slot with a CAS guard", async () => {
    const servingSlot = alpha().slots.find(
      (s) => s.kind === "inference" && s.state === "serving",
    )!;
    expect(
      await transitionSlot(
        database,
        servingSlot.id,
        "inference",
        ["serving"],
        "failed",
      ),
    ).toBe(true);
    expect(
      await transitionSlot(
        database,
        servingSlot.id,
        "inference",
        ["serving"],
        "failed",
      ),
    ).toBe(false);
    // The sibling slot was untouched by the single-slot CAS.
    const after = await getFleetSnapshot(database, "default");
    const alphaSlots = after?.domains
      .find((d) => d.slug === "alpha")
      ?.slots.filter((s) => s.kind === "inference");
    expect(
      alphaSlots?.map((s) => s.state).toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(["failed", "serving"]);
  });

  it("rejects from-lists that violate the core slot state table", async () => {
    // sleeping -> serving skips the wake path and is not an edge.
    await expect(
      transitionDomainSlots(
        database,
        beta().id,
        "inference",
        ["sleeping"],
        "serving",
      ),
    ).rejects.toThrow(/invalid inference slot transition/);
  });

  it("transitionDomainSlots moves every matching slot at once", async () => {
    // Beta's two inference slots are sleeping after seed.
    const moved = await transitionDomainSlots(
      database,
      beta().id,
      "inference",
      ["sleeping"],
      "waking",
    );
    expect(moved).toBe(2);
    // Training slots were untouched.
    const after = await getFleetSnapshot(database, "default");
    const betaAfter = after?.domains.find((d) => d.slug === "beta");
    expect(
      betaAfter?.slots
        .filter((s) => s.kind === "training")
        .every((s) => s.state === "idle"),
    ).toBe(true);
    // Second bulk move from the consumed state matches nothing.
    expect(
      await transitionDomainSlots(
        database,
        beta().id,
        "inference",
        ["sleeping"],
        "waking",
      ),
    ).toBe(0);
  });
});

describe("failOperationWithPromotionCleanup", () => {
  // Simulate a promotion that already drove beta's inference slots
  // onto the wake path before failing.
  const wakeBetaSlots = () =>
    transitionDomainSlots(
      database,
      beta().id,
      "inference",
      ["sleeping"],
      "waking",
    );

  const betaInferenceStates = async () => {
    const after = await getFleetSnapshot(database, "default");
    return after?.domains
      .find((d) => d.slug === "beta")
      ?.slots.filter((s) => s.kind === "inference")
      .map((s) => s.state);
  };

  const betaTrainingStates = async () => {
    const after = await getFleetSnapshot(database, "default");
    return after?.domains
      .find((d) => d.slug === "beta")
      ?.slots.filter((s) => s.kind === "training")
      .map((s) => s.state);
  };

  const promoteToBeta = async () => {
    const { createOperation, claimOperation } =
      await import("./repo/operations.js");
    const { operation } = await createOperation(database, {
      fleetId: fleet.id,
      kind: "promote",
      targetDomainId: beta().id,
    });
    await claimOperation(database, operation.id, "probe");
    return operation;
  };

  it("fails the operation AND its wake-path slots in one statement", async () => {
    await wakeBetaSlots();
    const operation = await promoteToBeta();
    const { failOperationWithPromotionCleanup } =
      await import("./repo/operations.js");
    const failedRow = await failOperationWithPromotionCleanup(
      database,
      operation.id,
      { step: "probe", code: "probe_failed", message: "boom" },
      "probe",
    );
    expect(failedRow?.state).toBe("failed");
    expect(await betaInferenceStates()).toEqual(["failed", "failed"]);
    // A post-wake failure never touches training: stop_training already
    // moved these slots to `idle`, so the recovery CTE matches nothing
    // (it fires only on `stopping`). Guards against the CTE resurrecting
    // training on a domain whose inference just went live.
    expect(await betaTrainingStates()).toEqual(["idle", "idle"]);
  });

  it("restores the target's stranded stopping training slots on a stop_training failure", async () => {
    // stop_training mirrors training -> stopping BEFORE its supervisor
    // stop; a 403 / timeout there must not leave them stuck (the
    // heartbeat mirror never touches `stopping`).
    await transitionDomainSlots(
      database,
      beta().id,
      "training",
      ["idle"],
      "training",
    );
    await transitionDomainSlots(
      database,
      beta().id,
      "training",
      ["training"],
      "stopping",
    );
    const {
      createOperation,
      claimOperation,
      failOperationWithPromotionCleanup,
    } = await import("./repo/operations.js");
    const { operation } = await createOperation(database, {
      fleetId: fleet.id,
      kind: "promote",
      targetDomainId: beta().id,
    });
    await claimOperation(database, operation.id, "stop_training");
    const failedRow = await failOperationWithPromotionCleanup(
      database,
      operation.id,
      {
        step: "stop_training",
        code: "supervisor_unauthorized",
        message: "403",
      },
      "stop_training",
    );
    expect(failedRow?.state).toBe("failed");
    // Training back to the pre-stop posture; inference never touched
    // (stop_training runs before the wake path).
    expect(await betaTrainingStates()).toEqual(["training", "training"]);
    expect(await betaInferenceStates()).toEqual(["sleeping", "sleeping"]);
  });

  it("cleans no slots when the fail CAS loses", async () => {
    await wakeBetaSlots();
    const operation = await promoteToBeta();
    const { failOperationWithPromotionCleanup } =
      await import("./repo/operations.js");
    // Guarded on a step the operation is not at: the fail matches
    // zero rows, so the slot CTE (driven by the failed row) must
    // clean nothing either.
    expect(
      await failOperationWithPromotionCleanup(
        database,
        operation.id,
        { step: "wake_vllm", code: "step_timeout", message: "stale" },
        "wake_vllm",
      ),
    ).toBeNull();
    expect(await betaInferenceStates()).toEqual(["waking", "waking"]);
  });

  it("keeps slots serving when the routing pointer committed to the target", async () => {
    await wakeBetaSlots();
    await transitionDomainSlots(
      database,
      beta().id,
      "inference",
      ["waking"],
      "probing",
    );
    await transitionDomainSlots(
      database,
      beta().id,
      "inference",
      ["probing"],
      "serving",
    );
    const operation = await promoteToBeta();
    await switchActive(database, fleet.id, alpha().id, beta().id);
    const { failOperationWithPromotionCleanup } =
      await import("./repo/operations.js");
    // The operation itself may fail (no target_not_routed guard for a
    // non-switch_active step), but the target IS live traffic now:
    // nothing may be marked failed.
    const failedRow = await failOperationWithPromotionCleanup(
      database,
      operation.id,
      { step: "probe", code: "probe_failed", message: "late" },
      "probe",
    );
    expect(failedRow?.state).toBe("failed");
    expect(await betaInferenceStates()).toEqual(["serving", "serving"]);
  });

  it("never cleans another fleet's slots (cross-fleet target guard)", async () => {
    await wakeBetaSlots();
    // A stale/malformed operation in ANOTHER fleet pointing at
    // default's beta: the pointer guard is scoped to the operation's
    // own fleet and would pass vacuously, so the ownership guard must
    // keep beta's slots untouched.
    await applyFleetLayout(database, {
      ...fleetLayoutSchema.parse(loadExampleFleetLayout()),
      slug: "other",
    });
    const other = await getFleetSnapshot(database, "other");
    if (!other) throw new Error("second fleet seed failed");
    const {
      createOperation,
      claimOperation,
      failOperationWithPromotionCleanup,
    } = await import("./repo/operations.js");
    const { operation } = await createOperation(database, {
      fleetId: other.id,
      kind: "promote",
      targetDomainId: beta().id,
    });
    await claimOperation(database, operation.id, "probe");
    const failedRow = await failOperationWithPromotionCleanup(
      database,
      operation.id,
      { step: "probe", code: "probe_failed", message: "cross-fleet" },
      "probe",
    );
    expect(failedRow?.state).toBe("failed");
    expect(await betaInferenceStates()).toEqual(["waking", "waking"]);
  });

  it("never cleans slots for a failed demote", async () => {
    const {
      createOperation,
      claimOperation,
      failOperationWithPromotionCleanup,
    } = await import("./repo/operations.js");
    // A demote target's serving-path slots reflect a sleep that
    // genuinely did not happen; simulate alpha (serving) as target.
    const { operation } = await createOperation(database, {
      fleetId: fleet.id,
      kind: "demote",
      targetDomainId: beta().id,
    });
    await claimOperation(database, operation.id, "sleep_vllm");
    await wakeBetaSlots();
    const failedRow = await failOperationWithPromotionCleanup(
      database,
      operation.id,
      { step: "sleep_vllm", code: "step_timeout", message: "wedged" },
      "sleep_vllm",
    );
    expect(failedRow?.state).toBe("failed");
    expect(await betaInferenceStates()).toEqual(["waking", "waking"]);
  });
});
