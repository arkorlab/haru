import { and, eq, exists, isNull, sql } from "drizzle-orm";

import { fleets, operations } from "../schema/index.js";

import type { HaruDatabase } from "../client.js";

/**
 * Move the active-domain pointer: the promotion commit point. A single
 * compare-and-swap UPDATE; `expectedActiveId` is the pointer value the
 * caller observed. Returns the new route revision, or null when the
 * CAS lost (someone else moved the pointer first), in which case the
 * caller must fail its operation rather than retry blindly.
 *
 * `requireRunningOperationId` extends the CAS with "the driving
 * operation is still running" (same single statement, via EXISTS), so
 * a tick that raced a concurrent timeout-failure cannot flip routing
 * for an operation already recorded as failed.
 */
export async function switchActive(
  database: HaruDatabase,
  fleetId: string,
  expectedActiveId: string | null,
  newActiveId: string,
  requireRunningOperationId?: string,
): Promise<{ routeRevision: number } | null> {
  const conditions = [
    eq(fleets.id, fleetId),
    expectedActiveId === null
      ? isNull(fleets.activeDomainId)
      : eq(fleets.activeDomainId, expectedActiveId),
  ];
  if (requireRunningOperationId !== undefined) {
    const operationRunningCondition = and(
      eq(operations.id, requireRunningOperationId),
      eq(operations.state, "running"),
    );
    // FOR UPDATE locks the operation row inside this statement, which
    // serializes the routing commit against a concurrent
    // failOperation UPDATE on the same row: whichever lands first,
    // the loser re-evaluates and sees the winner's state (a plain
    // EXISTS would read its own statement snapshot and could commit
    // routing for an operation a racing timeout just failed).
    const runningOperation = database
      .select({ one: sql`1` })
      .from(operations)
      .where(operationRunningCondition)
      .for("update");
    conditions.push(exists(runningOperation));
  }
  const rows = await database
    .update(fleets)
    .set({
      activeDomainId: newActiveId,
      routeRevision: sql`${fleets.routeRevision} + 1`,
      updatedAt: sql`now()`,
    })
    .where(and(...conditions))
    .returning({ routeRevision: fleets.routeRevision });
  return rows[0] ?? null;
}
