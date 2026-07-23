import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { switchActive } from "./repo/fleets.js";
import { applyFleetLayout } from "./repo/layout.js";
import {
  claimOperation,
  createOperation,
  failOperation,
  failOperationWithPromotionCleanup,
  getOperation,
} from "./repo/operations.js";
import { transitionDomainSlots } from "./repo/slots.js";
import { getFleetSnapshot } from "./repo/snapshots.js";
import { createTestDatabase } from "./testing/index.js";

import type { HaruDatabase } from "./client.js";

/**
 * Regression for the switch_active commit race: switchActive must stamp
 * `routingCommitted` atomically with the pointer move, and the
 * `target_not_routed` fail guard must key off THAT column so a
 * stale-pointer timeout tick cannot fail (and clobber the slots of) an
 * operation that already committed routing.
 *
 * PGlite is single-connection, so this proves the guard's post-commit
 * guarantee deterministically; true lock-contention ordering is covered
 * by the CI Postgres lane running the same suite.
 */

const LAYOUT = {
  slug: "default",
  activeDomainSlug: "alpha",
  domains: ["alpha", "beta"].map((slug) => ({
    slug,
    provider: "static",
    placement: { cloud: "aws", region: "us-east-1", accelerator: "TEST-GPU" },
    supervisorUrl: `https://${slug}-supervisor.test`,
    servingBaseUrl: `https://${slug}-serving.test`,
    slots: [
      {
        kind: "inference",
        gpuIndex: 0,
        models: [{ name: "example-chat", servingUrl: `https://${slug}.test` }],
      },
    ],
  })),
};

let database: HaruDatabase;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db: database, close } = await createTestDatabase());
  await applyFleetLayout(database, LAYOUT);
});

afterEach(async () => {
  await close();
});

async function ids(): Promise<{
  fleetId: string;
  alpha: string;
  beta: string;
  routeRevision: number;
}> {
  const snapshot = await getFleetSnapshot(database, "default");
  if (!snapshot) throw new Error("seed failed");
  return {
    fleetId: snapshot.id,
    alpha: snapshot.domains.find((d) => d.slug === "alpha")!.id,
    beta: snapshot.domains.find((d) => d.slug === "beta")!.id,
    routeRevision: snapshot.routeRevision,
  };
}

async function walkBetaToServing(beta: string): Promise<void> {
  await transitionDomainSlots(
    database,
    beta,
    "inference",
    ["sleeping"],
    "waking",
  );
  await transitionDomainSlots(
    database,
    beta,
    "inference",
    ["waking"],
    "probing",
  );
  await transitionDomainSlots(
    database,
    beta,
    "inference",
    ["probing"],
    "serving",
  );
}

async function betaSlotStates(): Promise<string[]> {
  const after = await getFleetSnapshot(database, "default");
  return (after?.domains.find((d) => d.slug === "beta")?.slots ?? [])
    .filter((s) => s.kind === "inference")
    .map((s) => s.state);
}

describe("routing commit guard", () => {
  it("stamps routingCommitted and bumps the revision atomically with the pointer move", async () => {
    const { fleetId, alpha, beta, routeRevision } = await ids();
    const { operation } = await createOperation(database, {
      fleetId,
      kind: "promote",
      targetDomainId: beta,
    });
    await claimOperation(database, operation.id, "switch_active");

    const moved = await switchActive(
      database,
      fleetId,
      alpha,
      beta,
      operation.id,
    );
    expect(moved?.routeRevision).toBe(routeRevision + 1);

    const after = await getFleetSnapshot(database, "default");
    expect(after?.activeDomainId).toBe(beta);
    const reread = await getOperation(database, operation.id);
    expect(reread?.routingCommitted).toBe(true);
  });

  it("refuses a target_not_routed fail once routing committed, leaving live slots serving", async () => {
    const { fleetId, alpha, beta } = await ids();
    const { operation } = await createOperation(database, {
      fleetId,
      kind: "promote",
      targetDomainId: beta,
    });
    await claimOperation(database, operation.id, "switch_active");
    await walkBetaToServing(beta);
    // Routing commits (pointer + routingCommitted, one statement).
    expect(
      await switchActive(database, fleetId, alpha, beta, operation.id),
    ).not.toBeNull();

    // A stale timeout tick now tries to fail switch_active. The guard
    // must refuse: the operation already routed to the live target.
    const failed = await failOperationWithPromotionCleanup(
      database,
      operation.id,
      { step: "switch_active", code: "step_timeout", message: "stale pointer" },
      "switch_active",
      "target_not_routed",
    );
    expect(failed).toBeNull();

    const after = await getFleetSnapshot(database, "default");
    expect(after?.activeDomainId).toBe(beta);
    expect(await betaSlotStates()).toEqual(["serving"]);
    expect((await getOperation(database, operation.id))?.state).toBe("running");
  });

  it("still lands a target_not_routed fail when routing was never committed", async () => {
    const { fleetId, beta } = await ids();
    const { operation } = await createOperation(database, {
      fleetId,
      kind: "promote",
      targetDomainId: beta,
    });
    await claimOperation(database, operation.id, "switch_active");
    await walkBetaToServing(beta);

    const failed = await failOperationWithPromotionCleanup(
      database,
      operation.id,
      { step: "switch_active", code: "probe_failed", message: "no probe" },
      "switch_active",
      "target_not_routed",
    );
    expect(failed?.state).toBe("failed");
    expect(await betaSlotStates()).toEqual(["failed"]);
  });

  it("keeps commit and a target_not_routed fail mutually exclusive when they race", async () => {
    // The sequential tests above prove the post-commit guarantee. This
    // one fires switchActive and the timeout-fail CONCURRENTLY. On the CI
    // Postgres lane the two statements genuinely contend for the
    // operation row lock: whichever loses blocks, then re-evaluates its
    // guard under READ COMMITTED on unblock - the exact block-then-unblock
    // interleave the routingCommitted-column guard exists for (a
    // fleets-pointer subquery would keep its pre-block snapshot and let a
    // fail land on an already-committed promotion). PGlite serializes the
    // pair, still proving winner/loser semantics. Either way the invariant
    // is the same: NEVER both, and the persisted state matches the winner.
    const { fleetId, alpha, beta } = await ids();
    const { operation } = await createOperation(database, {
      fleetId,
      kind: "promote",
      targetDomainId: beta,
    });
    await claimOperation(database, operation.id, "switch_active");
    await walkBetaToServing(beta);

    const [moved, failed] = await Promise.all([
      switchActive(database, fleetId, alpha, beta, operation.id),
      failOperationWithPromotionCleanup(
        database,
        operation.id,
        { step: "switch_active", code: "step_timeout", message: "stale pointer" },
        "switch_active",
        "target_not_routed",
      ),
    ]);
    const switchWon = moved !== null;
    const failWon = failed !== null;
    // The load-bearing invariant: routing commit and a target_not_routed
    // fail can never both succeed, under any interleaving.
    expect(switchWon && failWon).toBe(false);
    expect(switchWon || failWon).toBe(true);

    const after = await getFleetSnapshot(database, "default");
    const reread = await getOperation(database, operation.id);
    if (switchWon) {
      // Routing committed: the fail refused and the live target still serves.
      expect(after?.activeDomainId).toBe(beta);
      expect(reread?.routingCommitted).toBe(true);
      expect(reread?.state).toBe("running");
      expect(await betaSlotStates()).toEqual(["serving"]);
    } else {
      // Fail landed first: the pointer never moved and cleanup ran.
      expect(after?.activeDomainId).toBe(alpha);
      expect(reread?.state).toBe("failed");
      expect(await betaSlotStates()).toEqual(["failed"]);
    }
  });

  it("plain failOperation with the guard also refuses once routing committed", async () => {
    const { fleetId, alpha, beta } = await ids();
    const { operation } = await createOperation(database, {
      fleetId,
      kind: "promote",
      targetDomainId: beta,
    });
    await claimOperation(database, operation.id, "switch_active");
    await switchActive(database, fleetId, alpha, beta, operation.id);

    const failed = await failOperation(
      database,
      operation.id,
      { step: "switch_active", code: "step_timeout", message: "stale" },
      "switch_active",
      "target_not_routed",
    );
    expect(failed).toBeNull();
  });
});
