import {
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
  ],
);
