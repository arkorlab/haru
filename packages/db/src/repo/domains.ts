import { and, eq, inArray, sql } from "drizzle-orm";

import { domains } from "../schema/index.js";

import type { HaruDatabase } from "../client.js";
import type { DomainState } from "@haru/protocol";

/**
 * Guarded domain state transition. The `from` list is the set of
 * states the caller believes the domain is in; the UPDATE only lands
 * when that still holds, so two racing reconciler ticks produce
 * exactly one winner. Returns whether this call won.
 */
export async function transitionDomain(
  database: HaruDatabase,
  domainId: string,
  from: readonly DomainState[],
  to: DomainState,
): Promise<boolean> {
  const rows = await database
    .update(domains)
    .set({
      state: to,
      stateUpdatedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(domains.id, domainId), inArray(domains.state, [...from])))
    .returning({ id: domains.id });
  return rows.length === 1;
}

/** Record a successful supervisor heartbeat. */
export async function markDomainSeen(
  database: HaruDatabase,
  domainId: string,
  at: Date,
): Promise<void> {
  await database
    .update(domains)
    .set({ lastSeenAt: at, updatedAt: sql`now()` })
    .where(eq(domains.id, domainId));
}
