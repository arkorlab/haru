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
 * operation is still running", and (in the SAME statement) STAMPS that
 * operation's `routingCommitted` flag alongside the pointer move. Two
 * races are closed by these being one statement:
 *
 * - fail-first: a concurrent `failOperation` sets `state = failed`
 *   first; the `EXISTS (... state = 'running' FOR UPDATE)` re-check
 *   here then matches zero rows on unblock, so the pointer never moves.
 * - switch-first (the one a plain pointer read cannot cover): the
 *   pointer moves and `routingCommitted` is set together, so a
 *   concurrent `failOperation` guarded on `routingCommitted = false`
 *   (a column of the operation row it locks, re-checked under EPQ)
 *   matches zero rows and its failure never lands on the live-routed
 *   target. A `fleets`-pointer subquery in that guard would keep the
 *   pre-commit snapshot and let the failure through - see the
 *   `routingCommitted` note in the operations schema.
 *
 * The FOR UPDATE stays because the fleets UPDATE alone does not touch
 * the operation row; it is what forces the fail-first re-check.
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
  const pointerUpdate = {
    activeDomainId: newActiveId,
    routeRevision: sql`${fleets.routeRevision} + 1`,
    updatedAt: sql`now()`,
  };
  if (requireRunningOperationId === undefined) {
    // No driving operation (layout-less / test pointer moves): a plain
    // pointer CAS, no routingCommitted stamp.
    const rows = await database
      .update(fleets)
      .set(pointerUpdate)
      .where(and(...conditions))
      .returning({ routeRevision: fleets.routeRevision });
    return rows[0] ?? null;
  }
  const runningOperation = database
    .select({ one: sql`1` })
    .from(operations)
    .where(
      and(
        eq(operations.id, requireRunningOperationId),
        eq(operations.state, "running"),
      ),
    )
    .for("update");
  conditions.push(exists(runningOperation));
  // Move the pointer in a CTE, then stamp routingCommitted on the
  // driving operation in the SAME statement, gated on the pointer move
  // having landed (EXISTS(moved_pointer)). Both commit atomically, so a
  // concurrent failOperation can never observe "pointer moved but
  // routingCommitted still false". The route revision rides back out of
  // the CTE.
  const movedPointer = database.$with("moved_pointer").as(
    database
      .update(fleets)
      .set(pointerUpdate)
      .where(and(...conditions))
      .returning({ routeRevision: fleets.routeRevision }),
  );
  const pointerMoved = database.select({ one: sql`1` }).from(movedPointer);
  const rows = await database
    .with(movedPointer)
    .update(operations)
    .set({ routingCommitted: true, updatedAt: sql`now()` })
    .where(
      and(eq(operations.id, requireRunningOperationId), exists(pointerMoved)),
    )
    .returning({
      routeRevision: sql<number>`(select ${movedPointer.routeRevision} from ${movedPointer})`,
    });
  return rows[0] ?? null;
}
