import { assertDomainTransition } from "@haru/core";
import {
  aliasedTable,
  and,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  ne,
  notExists,
  sql,
} from "drizzle-orm";

import { domains, fleets, operations, slots } from "../schema/index.js";

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

/**
 * Escalate a degraded domain to failed ONLY while, in one statement:
 * the fleet has no in-flight operation, still routes to this domain,
 * AND a viable failover standby exists. Each guard closes a
 * multi-statement race a separate read-then-update would leave open:
 * a promote/demote created in between would occupy the one-in-flight
 * slot right as the active stops routing; a promotion that committed
 * in between would leave this domain a STANDBY (which escalation
 * never touches); and a concurrent heartbeat can strip the standby
 * `detectDegradedEscalation` bet on (e.g. by failing its only
 * inference slot) - escalating then would drop the active's remaining
 * healthy models with only a doomed failover target left. The
 * viability predicate mirrors core's isViableFailoverTarget: ready
 * state, a supervisor URL, at least one inference slot (the schema
 * guarantees an inference slot binds >= 1 model), none of them
 * failed, and a heartbeat no older than the caller's cutoff. A
 * createOperation committing between this statement's snapshot and
 * its commit can still slip through (that window is sub-statement and
 * self-heals: the failed trigger fires as soon as the slot frees),
 * but the multi-statement windows are gone.
 */
export async function escalateDomainIfFleetIdle(
  database: HaruDatabase,
  domainId: string,
  fleetId: string,
  at: Date,
  heartbeatStaleMs: number,
): Promise<boolean> {
  assertDomainTransition("degraded", "failed");
  const pointerAtDomain = database
    .select({ one: sql`1` })
    .from(fleets)
    .where(and(eq(fleets.id, fleetId), eq(fleets.activeDomainId, domainId)));
  const inflightOperation = database
    .select({ one: sql`1` })
    .from(operations)
    .where(
      and(
        eq(operations.fleetId, fleetId),
        inArray(operations.state, ["pending", "running"]),
      ),
    );
  const standby = aliasedTable(domains, "standby");
  const heartbeatCutoff = new Date(at.getTime() - heartbeatStaleMs);
  const standbyInferenceSlot = database
    .select({ one: sql`1` })
    .from(slots)
    .where(and(eq(slots.domainId, standby.id), eq(slots.kind, "inference")));
  const standbyFailedInferenceSlot = database
    .select({ one: sql`1` })
    .from(slots)
    .where(
      and(
        eq(slots.domainId, standby.id),
        eq(slots.kind, "inference"),
        eq(slots.state, "failed"),
      ),
    );
  const viableStandby = database
    .select({ one: sql`1` })
    .from(standby)
    .where(
      and(
        eq(standby.fleetId, fleetId),
        ne(standby.id, domainId),
        eq(standby.state, "ready"),
        isNotNull(standby.supervisorUrl),
        gte(standby.lastSeenAt, heartbeatCutoff),
        exists(standbyInferenceSlot),
        notExists(standbyFailedInferenceSlot),
      ),
    );
  const rows = await database
    .update(domains)
    .set({ state: "failed", stateUpdatedAt: at, updatedAt: sql`now()` })
    .where(
      and(
        eq(domains.id, domainId),
        eq(domains.state, "degraded"),
        exists(pointerAtDomain),
        notExists(inflightOperation),
        exists(viableStandby),
      ),
    )
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
