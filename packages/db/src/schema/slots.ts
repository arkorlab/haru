import { validSlotStates } from "@haru/core";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { domains } from "./domains.js";
import { slotKindEnum, slotStateEnum } from "./enums.js";

import type { SlotSpec } from "@haru/protocol";

function sqlStringList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

// The core state tables remain the source of truth. The CHECK is built
// directly from them so the persisted kind/state pairs cannot drift
// from the transitions enforced by the repository layer.
const INFERENCE_STATES_SQL = sqlStringList(validSlotStates("inference"));
const TRAINING_STATES_SQL = sqlStringList(validSlotStates("training"));

export const slots = pgTable(
  "slots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    domainId: uuid("domain_id")
      .notNull()
      .references(() => domains.id),
    gpuIndex: integer("gpu_index").notNull(),
    kind: slotKindEnum("kind").notNull(),
    state: slotStateEnum("state").notNull(),
    /** InferenceSlotSpec | TrainingSlotSpec, discriminated on `kind`. */
    spec: jsonb("spec").$type<SlotSpec>().notNull(),
    stateUpdatedAt: timestamp("state_updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique("uq_slots_domain_gpu_kind").on(t.domainId, t.gpuIndex, t.kind),
    index("idx_slots_domain").on(t.domainId),
    // A GPU index is a physical device ordinal; never negative.
    check("slots_gpu_index_nonnegative", sql`${t.gpuIndex} >= 0`),
    check(
      "slots_kind_state_valid",
      sql`((${t.kind} = 'inference' AND ${t.state} IN (${sql.raw(INFERENCE_STATES_SQL)})) OR (${t.kind} = 'training' AND ${t.state} IN (${sql.raw(TRAINING_STATES_SQL)})))`,
    ),
  ],
);
