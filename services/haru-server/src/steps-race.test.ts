import {
  applyFleetLayout,
  claimOperation,
  createOperation,
  failOperation,
  getFleetSnapshot,
  getOperation,
  switchActive,
  transitionDomainSlots,
} from "@haru/db";
import { createTestDatabase } from "@haru/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reconcileFleet } from "./reconciler/reconciler.js";
import { executeStep } from "./reconciler/steps.js";

import type { HaruDatabase, OperationRow } from "@haru/db";
import type { FleetSnapshot } from "@haru/protocol";

/**
 * Race regressions for the switch_active step: a reconcile tick
 * holding a stale fleet snapshot must converge with a concurrent tick
 * that already moved the pointer, instead of failing a promotion that
 * actually landed.
 */

const THREE_DOMAIN_LAYOUT = {
  slug: "default",
  activeDomainSlug: "alpha",
  domains: ["alpha", "beta", "gamma"].map((slug) => ({
    slug,
    provider: "static",
    placement: {
      cloud: "aws",
      region: "us-east-1",
      accelerator: "TEST-GPU",
    },
    servingBaseUrl: `https://${slug}-serving.test`,
    slots: [
      {
        kind: "inference",
        gpuIndex: 0,
        models: [
          {
            name: "example-chat-small",
            servingUrl: `https://${slug}-serving.test`,
          },
        ],
      },
    ],
  })),
};

let database: HaruDatabase;
let close: () => Promise<void>;
let staleFleet: FleetSnapshot;

beforeEach(async () => {
  ({ db: database, close } = await createTestDatabase());
  await applyFleetLayout(database, THREE_DOMAIN_LAYOUT);
  const snapshot = await getFleetSnapshot(database, "default");
  if (!snapshot) throw new Error("seed failed");
  staleFleet = snapshot;
});

afterEach(async () => {
  await close();
});

const domainId = (slug: string) =>
  staleFleet.domains.find((d) => d.slug === slug)!.id;

async function claimedPromotion(targetSlug: string): Promise<OperationRow> {
  const { operation } = await createOperation(database, {
    fleetId: staleFleet.id,
    kind: "promote",
    targetDomainId: domainId(targetSlug),
  });
  await claimOperation(database, operation.id, "switch_active");
  const claimed = await getOperation(database, operation.id);
  if (!claimed) throw new Error("claim failed");
  return claimed;
}

function contextFor(operation: OperationRow) {
  return {
    database,
    fetchFn: fetch,
    now: () => new Date(),
    // Deliberately stale: loaded before the concurrent pointer move.
    fleet: staleFleet,
    operation,
    supervisorToken: undefined,
  };
}

describe("switch_active under concurrent ticks", () => {
  it("converges to done when a racing tick already moved the pointer to the target", async () => {
    const operation = await claimedPromotion("beta");
    // Concurrent tick wins the CAS for the same target first.
    const moved = await switchActive(
      database,
      staleFleet.id,
      domainId("alpha"),
      domainId("beta"),
    );
    expect(moved).not.toBeNull();

    // Our tick still holds the pre-move snapshot; its CAS must lose,
    // re-read, see the pointer on the target, and report done.
    const outcome = await executeStep(contextFor(operation), "switch_active");
    expect(outcome).toEqual({ status: "done" });
  });

  it("refuses to flip routing for an operation that was already failed", async () => {
    const operation = await claimedPromotion("beta");
    // A concurrent tick timed the step out and failed the operation.
    await failOperation(
      database,
      operation.id,
      { step: "switch_active", code: "step_timeout", message: "timed out" },
      "switch_active",
    );

    // The zombie tick's CAS must not land: the pointer stays on alpha.
    const outcome = await executeStep(contextFor(operation), "switch_active");
    expect(outcome.status).toBe("failed");
    const after = await getFleetSnapshot(database, "default");
    expect(after?.activeDomainId).toBe(domainId("alpha"));
    expect(after?.routeRevision).toBe(staleFleet.routeRevision);
  });

  it("marks the target's already-serving slots failed when switch_active times out", async () => {
    // Probe advances the target's inference slots to serving BEFORE
    // switch_active commits routing, so a promote dying at
    // switch_active must not leave a non-active domain recorded as
    // serving.
    const { operation } = await createOperation(database, {
      fleetId: staleFleet.id,
      kind: "promote",
      targetDomainId: domainId("beta"),
    });
    // Claimed a full minute ago: past the switch_active budget.
    await claimOperation(
      database,
      operation.id,
      "switch_active",
      new Date(Date.now() - 60_000),
    );
    // Walk the legal wake path the promotion would have taken.
    await transitionDomainSlots(
      database,
      domainId("beta"),
      "inference",
      ["sleeping"],
      "waking",
    );
    await transitionDomainSlots(
      database,
      domainId("beta"),
      "inference",
      ["waking"],
      "probing",
    );
    await transitionDomainSlots(
      database,
      domainId("beta"),
      "inference",
      ["probing"],
      "serving",
    );

    const result = await reconcileFleet(
      {
        database,
        fetchFn: fetch,
        now: () => new Date(),
        supervisorToken: undefined,
      },
      "default",
    );
    expect(result?.operation?.state).toBe("failed");
    expect(result?.operation?.error?.code).toBe("step_timeout");

    const after = await getFleetSnapshot(database, "default");
    expect(after?.activeDomainId).toBe(domainId("alpha"));
    const betaSlots = after?.domains
      .find((d) => d.slug === "beta")!
      .slots.filter((s) => s.kind === "inference");
    expect(betaSlots?.every((s) => s.state === "failed")).toBe(true);
  });

  it("leaves a failed demote target's serving slots serving (sleep genuinely did not happen)", async () => {
    const { operation } = await createOperation(database, {
      fleetId: staleFleet.id,
      kind: "demote",
      targetDomainId: domainId("beta"),
    });
    await claimOperation(
      database,
      operation.id,
      "sleep_vllm",
      new Date(Date.now() - 600_000),
    );
    // Walk the legal wake path the promotion would have taken.
    await transitionDomainSlots(
      database,
      domainId("beta"),
      "inference",
      ["sleeping"],
      "waking",
    );
    await transitionDomainSlots(
      database,
      domainId("beta"),
      "inference",
      ["waking"],
      "probing",
    );
    await transitionDomainSlots(
      database,
      domainId("beta"),
      "inference",
      ["probing"],
      "serving",
    );

    const result = await reconcileFleet(
      {
        database,
        fetchFn: fetch,
        now: () => new Date(),
        supervisorToken: undefined,
      },
      "default",
    );
    expect(result?.operation?.state).toBe("failed");

    const after = await getFleetSnapshot(database, "default");
    const betaSlots = after?.domains
      .find((d) => d.slug === "beta")!
      .slots.filter((s) => s.kind === "inference");
    expect(betaSlots?.every((s) => s.state === "serving")).toBe(true);
  });

  it("still fails cas_lost when the pointer moved somewhere else", async () => {
    const operation = await claimedPromotion("beta");
    // Concurrent move to a DIFFERENT domain: overwriting it would
    // steal routing, so this must stay a hard failure.
    const moved = await switchActive(
      database,
      staleFleet.id,
      domainId("alpha"),
      domainId("gamma"),
    );
    expect(moved).not.toBeNull();

    const outcome = await executeStep(contextFor(operation), "switch_active");
    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" && outcome.code).toBe("cas_lost");
  });
});
