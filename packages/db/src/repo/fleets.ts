import { and, eq, isNull, sql } from "drizzle-orm";

import { fleets } from "../schema/index.js";

import type { HaruDatabase } from "../client.js";

/**
 * Move the active-domain pointer: the promotion commit point. A single
 * compare-and-swap UPDATE; `expectedActiveId` is the pointer value the
 * caller observed. Returns the new route revision, or null when the
 * CAS lost (someone else moved the pointer first), in which case the
 * caller must fail its operation rather than retry blindly.
 */
export async function switchActive(
  database: HaruDatabase,
  fleetId: string,
  expectedActiveId: string | null,
  newActiveId: string,
): Promise<{ routeRevision: number } | null> {
  const rows = await database
    .update(fleets)
    .set({
      activeDomainId: newActiveId,
      routeRevision: sql`${fleets.routeRevision} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(fleets.id, fleetId),
        expectedActiveId === null
          ? isNull(fleets.activeDomainId)
          : eq(fleets.activeDomainId, expectedActiveId),
      ),
    )
    .returning({ routeRevision: fleets.routeRevision });
  return rows[0] ?? null;
}
