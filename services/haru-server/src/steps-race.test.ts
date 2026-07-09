import {
  applyFleetLayout,
  claimOperation,
  createOperation,
  getFleetSnapshot,
  getOperation,
  switchActive,
} from "@haru/db";
import { createTestDatabase } from "@haru/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
