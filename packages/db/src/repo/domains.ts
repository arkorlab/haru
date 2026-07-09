import { assertDomainTransition } from "@haru/core";
import { and, eq, inArray, sql } from "drizzle-orm";

import { domains } from "../schema/index.js";

import type { HaruDatabase } from "../client.js";
import type { DomainState } from "@haru/protocol";

/**
 * Guarded domain state transition. The `from` list is the set of
 * states the caller believes the domain is in; the UPDATE only lands
 * when that still holds, so two racing reconciler ticks produce
 * exactly one winner. Returns whether this call won.
 *
 * Every (from, to) pair is asserted against the core domain state
 * table (the single source of truth). `at` is the injected app clock,
 * not sql`now()`: the degraded-escalation budget compares
 * stateUpdatedAt against the reconciler's own clock, so mixing in the
 * DB clock would shift it by the host/DB skew.
 */
export async function transitionDomain(
  database: HaruDatabase,
  domainId: string,
  from: readonly DomainState[],
  to: DomainState,
  at: Date = new Date(),
): Promise<boolean> {
  for (const state of from) {
    assertDomainTransition(state, to);
  }
  const rows = await database
    .update(domains)
    .set({
      state: to,
      stateUpdatedAt: at,
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
