import { assertSlotTransition } from "@haru/core";
import { and, eq, inArray, sql } from "drizzle-orm";

import { slots } from "../schema/index.js";

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
