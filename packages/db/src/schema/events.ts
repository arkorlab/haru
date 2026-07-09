import {
  bigserial,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Append-only audit trail. Written after (never inside) the
 * compare-and-swap statements it describes, so a lost event is
 * possible on a crash but state integrity never depends on it.
 */
export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    fleetId: uuid("fleet_id").notNull(),
    domainId: uuid("domain_id"),
    slotId: uuid("slot_id"),
    operationId: uuid("operation_id"),
    /** e.g. "operation.step.done", "domain.state.changed". */
    type: text("type").notNull(),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("idx_events_fleet").on(t.fleetId, t.id)],
);
