import { assertSlotTransition } from "@haru/core";
import { and, eq, exists, inArray, notExists, sql } from "drizzle-orm";

import { domains, fleets, operations, slots } from "../schema/index.js";

import type { HaruDatabase } from "../client.js";
import type { SlotKind, SlotState } from "@haru/protocol";

/**
 * Every (from, to) pair must be an edge of the core slot state table:
 * the tables are the single source of truth and this is where they are
 * enforced. A violating from-list is a programming error, so it throws
 * (InvalidTransitionError) instead of silently matching zero rows.
 */
function assertFromList(
  kind: SlotKind,
  from: readonly SlotState[],
  to: SlotState,
): void {
  for (const state of from) {
    assertSlotTransition(kind, state, to);
  }
}

/**
 * Guarded single-slot state transition (compare-and-swap). Used by the
 * reconciler's heartbeat slot-health sync, which moves slots on the
 * active domain individually (one dead GPU must not drag its healthy
 * siblings along).
 */
export async function transitionSlot(
  database: HaruDatabase,
  slotId: string,
  kind: SlotKind,
  from: readonly SlotState[],
  to: SlotState,
): Promise<boolean> {
  assertFromList(kind, from, to);
  const rows = await database
    .update(slots)
    .set({ state: to, stateUpdatedAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(slots.id, slotId),
        eq(slots.kind, kind),
        inArray(slots.state, [...from]),
      ),
    )
    .returning({ id: slots.id });
  return rows.length === 1;
}

/**
 * Guarded bulk transition of every slot of one kind in a domain (e.g.
 * all inference slots sleeping -> waking during promotion). Returns
 * the number of slots that moved; slots outside the `from` set are
 * left untouched.
 */
export async function transitionDomainSlots(
  database: HaruDatabase,
  domainId: string,
  kind: SlotKind,
  from: readonly SlotState[],
  to: SlotState,
): Promise<number> {
  assertFromList(kind, from, to);
  const rows = await database
    .update(slots)
    .set({ state: to, stateUpdatedAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(slots.domainId, domainId),
        eq(slots.kind, kind),
        inArray(slots.state, [...from]),
      ),
    )
    .returning({ id: slots.id });
  return rows.length;
}

/** Slot states a failed promotion can have left its target's inference
 * slots in (the operation's own wake path). Sleeping is excluded: the
 * promotion never touched those slots. */
const FAILED_PROMOTION_SLOT_STATES: readonly SlotState[] = [
  "waking",
  "probing",
  "serving",
];

/**
 * Mark a failed promotion's target inference slots failed, with BOTH
 * safety guards inside the one statement: the fleet's routing pointer
 * must not point at the target (a committed switch_active means those
 * serving slots ARE live traffic), and no operation may be in flight
 * for the fleet (failOperation released the one-in-flight slot BEFORE
 * this cleanup runs, so an immediate retry promote could already be
 * driving these same slots through its own wake path; failing them
 * under it would 404 chat on the new active until the next heartbeat
 * recovers them). Same single-statement rationale as
 * escalateDomainIfFleetIdle: a multi-statement read-then-update would
 * leave a real race window, this leaves only a sub-statement one that
 * the retry's own from-lists and the heartbeat health sync self-heal.
 */
export async function failPromotionTargetSlots(
  database: HaruDatabase,
  fleetId: string,
  targetDomainId: string,
): Promise<number> {
  assertFromList("inference", FAILED_PROMOTION_SLOT_STATES, "failed");
  // The fleet-scoped guards below are only meaningful when the target
  // actually belongs to that fleet: with a mismatched pair both
  // NOT EXISTS checks would vacuously pass and fail ANOTHER fleet's
  // slots.
  const targetBelongsToFleet = database
    .select({ one: sql`1` })
    .from(domains)
    .where(and(eq(domains.id, targetDomainId), eq(domains.fleetId, fleetId)));
  const pointerAtTarget = database
    .select({ one: sql`1` })
    .from(fleets)
    .where(
      and(eq(fleets.id, fleetId), eq(fleets.activeDomainId, targetDomainId)),
    );
  const inflightOperation = database
    .select({ one: sql`1` })
    .from(operations)
    .where(
      and(
        eq(operations.fleetId, fleetId),
        inArray(operations.state, ["pending", "running"]),
      ),
    );
  const rows = await database
    .update(slots)
    .set({ state: "failed", stateUpdatedAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(slots.domainId, targetDomainId),
        eq(slots.kind, "inference"),
        inArray(slots.state, [...FAILED_PROMOTION_SLOT_STATES]),
        exists(targetBelongsToFleet),
        notExists(pointerAtTarget),
        notExists(inflightOperation),
      ),
    )
    .returning({ id: slots.id });
  return rows.length;
}
