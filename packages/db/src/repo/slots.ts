import { and, eq, inArray, sql } from "drizzle-orm";

import { slots } from "../schema/index.js";

import type { HaruDatabase } from "../client.js";
import type { SlotKind, SlotState } from "@haru/protocol";

/** Guarded single-slot state transition (compare-and-swap). */
export async function transitionSlot(
  database: HaruDatabase,
  slotId: string,
  from: readonly SlotState[],
  to: SlotState,
): Promise<boolean> {
  const rows = await database
    .update(slots)
    .set({ state: to, stateUpdatedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(slots.id, slotId), inArray(slots.state, [...from])))
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
