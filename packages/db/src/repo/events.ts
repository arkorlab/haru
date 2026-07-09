import { desc, eq } from "drizzle-orm";

import { events } from "../schema/index.js";

import type { HaruDatabase } from "../client.js";

export type EventRow = typeof events.$inferSelect;

export interface AppendEventInput {
  fleetId: string;
  type: string;
  domainId?: string;
  slotId?: string;
  operationId?: string;
  payload?: Record<string, unknown>;
}

/** Append one audit event. Never part of a state-changing statement. */
export async function appendEvent(
  database: HaruDatabase,
  input: AppendEventInput,
): Promise<void> {
  await database.insert(events).values({
    fleetId: input.fleetId,
    type: input.type,
    domainId: input.domainId,
    slotId: input.slotId,
    operationId: input.operationId,
    payload: input.payload ?? {},
  });
}

export async function listEvents(
  database: HaruDatabase,
  fleetId: string,
  limit = 100,
): Promise<EventRow[]> {
  return database
    .select()
    .from(events)
    .where(eq(events.fleetId, fleetId))
    .orderBy(desc(events.id))
    .limit(limit);
}
