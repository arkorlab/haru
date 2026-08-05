import { detectDegradedEscalation } from "@haru/core";
import { fleetLayoutSchema } from "@haru/protocol";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  escalateDomainIfFleetIdle,
  markDomainSeen,
  transitionDomain,
} from "./repo/domains.js";
import { applyFleetLayout } from "./repo/layout.js";
import { transitionSlot } from "./repo/slots.js";
import { getFleetSnapshot } from "./repo/snapshots.js";
import { domains, slots } from "./schema/index.js";
import { createTestDatabase, loadExampleFleetLayout } from "./testing/index.js";

import type { HaruDatabase } from "./client.js";
import type { FleetSnapshot } from "@haru/protocol";

/**
 * The viable-standby predicate exists TWICE: as `isViableFailoverTarget`
 * in @haru/core (which `detectDegradedEscalation` consults in memory) and
 * inlined as SQL `EXISTS`/`NOT EXISTS` subqueries inside
 * `escalateDomainIfFleetIdle`, so a concurrent heartbeat cannot strip the
 * standby between the decision and the escalation. Both source files say
 * the two must be kept in sync by hand.
 *
 * Hand-sync is exactly what a test can replace. These cases drive the
 * SAME database state through both and assert they agree, so a change to
 * one side that the other did not follow fails here instead of surfacing
 * as an escalation that sacrifices the active's healthy models for a
 * standby the in-memory decision had already rejected.
 */

const HEARTBEAT_STALE_MS = 30_000;
const DEGRADED_GRACE_MS = 60_000;
// Comfortably past the grace so the escalation's OTHER guards are
// satisfied and only the viability predicate is under test.
const DEGRADED_FOR_MS = DEGRADED_GRACE_MS * 2;

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

const active = () => fleet.domains.find((d) => d.slug === "alpha")!;
const standby = () => fleet.domains.find((d) => d.slug === "beta")!;

/**
 * Read the live state and ask both implementations the same question.
 *
 * The example layout ships `autoFailover: false`, and the SQL helper
 * takes `heartbeatStaleMs` as an argument rather than reading policy, so
 * the policy is overridden on the snapshot to put both sides on
 * identical terms. Domain and slot state - everything the predicate
 * actually judges - comes from the database in both cases.
 */
async function bothVerdicts(now: Date): Promise<{
  inMemory: boolean;
  inSql: boolean;
}> {
  const live = await getFleetSnapshot(database, "default");
  if (!live) throw new Error("snapshot vanished");
  const isInMemory =
    detectDegradedEscalation(
      {
        ...live,
        policy: {
          ...live.policy,
          autoFailover: true,
          degradedGraceMs: DEGRADED_GRACE_MS,
          heartbeatStaleMs: HEARTBEAT_STALE_MS,
        },
      },
      now.getTime(),
    ) !== null;
  // Run the SQL side second: it MUTATES on success, so a true verdict
  // must not be able to influence the in-memory read above.
  const isInSql = await escalateDomainIfFleetIdle(
    database,
    active().id,
    fleet.id,
    now,
    HEARTBEAT_STALE_MS,
  );
  return { inMemory: isInMemory, inSql: isInSql };
}

/**
 * Put the active into the degraded-past-grace state both sides require,
 * and assert it took.
 *
 * The SQL side also guards on the routing pointer and on no operation
 * being in flight, so a fixture change could make it answer `false` for a
 * reason that has nothing to do with viability, and these cases would
 * still "agree" while testing nothing. Pinning the preconditions keeps a
 * green run meaningful.
 */
async function degradeActive(now: Date): Promise<void> {
  const isMoved = await transitionDomain(
    database,
    active().id,
    ["ready"],
    "degraded",
    new Date(now.getTime() - DEGRADED_FOR_MS),
  );
  expect(isMoved).toBe(true);
  const live = await getFleetSnapshot(database, "default");
  expect(live?.activeDomainId).toBe(active().id);
  expect(live?.domains.find((d) => d.id === active().id)?.state).toBe(
    "degraded",
  );
}

describe("viable-standby predicate parity (core vs SQL)", () => {
  it("agrees when the standby is fully viable", async () => {
    const now = new Date();
    await degradeActive(now);
    await markDomainSeen(database, standby().id, now);

    const { inMemory, inSql } = await bothVerdicts(now);
    expect(inSql).toBe(inMemory);
    expect(inMemory).toBe(true);
  });

  it("agrees when the standby has never heartbeated", async () => {
    const now = new Date();
    await degradeActive(now);
    // No markDomainSeen: lastSeenAt stays null. SQL compares
    // `lastSeenAt >= cutoff` (null fails), core checks `!== null`.
    const { inMemory, inSql } = await bothVerdicts(now);
    expect(inSql).toBe(inMemory);
    expect(inMemory).toBe(false);
  });

  it("agrees when the standby's heartbeat is stale", async () => {
    const now = new Date();
    await degradeActive(now);
    await markDomainSeen(
      database,
      standby().id,
      new Date(now.getTime() - HEARTBEAT_STALE_MS - 1000),
    );

    const { inMemory, inSql } = await bothVerdicts(now);
    expect(inSql).toBe(inMemory);
    expect(inMemory).toBe(false);
  });

  it("agrees when the standby is not ready", async () => {
    const now = new Date();
    await degradeActive(now);
    await markDomainSeen(database, standby().id, now);
    // Ready is required, not merely promotable: a degraded standby's
    // lastSeenAt still records the last SUCCESS, so freshness alone
    // would keep treating a just-unreachable supervisor as viable.
    await transitionDomain(database, standby().id, ["ready"], "degraded");

    const { inMemory, inSql } = await bothVerdicts(now);
    expect(inSql).toBe(inMemory);
    expect(inMemory).toBe(false);
  });

  it("agrees when one of the standby's inference slots is failed", async () => {
    const now = new Date();
    await degradeActive(now);
    await markDomainSeen(database, standby().id, now);
    const slot = standby().slots.find((s) => s.kind === "inference")!;
    await transitionSlot(
      database,
      slot.id,
      "inference",
      ["serving", "sleeping"],
      "failed",
    );

    const { inMemory, inSql } = await bothVerdicts(now);
    expect(inSql).toBe(inMemory);
    expect(inMemory).toBe(false);
  });

  it("agrees when the standby has no supervisor to drive", async () => {
    const now = new Date();
    await degradeActive(now);
    await markDomainSeen(database, standby().id, now);
    // No repository helper unbinds a supervisor, and the point is to
    // exercise the stored state both predicates read, so the column is
    // cleared directly.
    await database
      .update(domains)
      .set({ supervisorUrl: null })
      .where(eq(domains.id, standby().id));

    const { inMemory, inSql } = await bothVerdicts(now);
    expect(inSql).toBe(inMemory);
    expect(inMemory).toBe(false);
  });

  it("agrees when the standby has no inference slot at all", async () => {
    const now = new Date();
    await degradeActive(now);
    await markDomainSeen(database, standby().id, now);
    // Same reasoning as above: layout apply is additive, so removing a
    // slot is not something the repository layer offers.
    const standbyId = standby().id;
    const standbyInferenceSlots = and(
      eq(slots.domainId, standbyId),
      eq(slots.kind, "inference"),
    );
    await database.delete(slots).where(standbyInferenceSlots);

    const { inMemory, inSql } = await bothVerdicts(now);
    expect(inSql).toBe(inMemory);
    expect(inMemory).toBe(false);
  });

  /**
   * The one place the two predicates are NOT literally the same test.
   * Core requires an inference slot with at least one bound model (a
   * bindingless target fails the probe step); the SQL only requires an
   * inference slot to exist, and justifies the simplification with "the
   * schema guarantees an inference slot binds >= 1 model".
   *
   * That makes a zod constraint in a THIRD package load-bearing for a
   * SQL predicate two packages away, with nothing connecting them.
   * Relaxing it would silently make the SQL side broader than core's:
   * the escalation would fire on a standby the in-memory decision
   * rejected. Pinned here so that relaxation breaks a test instead.
   */
  it("keeps the schema invariant the SQL predicate leans on", () => {
    const layout = loadExampleFleetLayout() as {
      domains: { slots: { kind: string; models?: unknown[] }[] }[];
    };
    const inference = layout.domains[0]?.slots.find(
      (s) => s.kind === "inference",
    );
    if (!inference) throw new Error("example layout has no inference slot");
    inference.models = [];

    expect(() => fleetLayoutSchema.parse(layout)).toThrow();
  });
});
