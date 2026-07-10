import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { operationKindEnum, operationStateEnum } from "./enums.js";
import { fleets } from "./fleets.js";

import type { OperationError } from "@haru/protocol";

export const operations = pgTable(
  "operations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    fleetId: uuid("fleet_id")
      .notNull()
      .references(() => fleets.id),
    kind: operationKindEnum("kind").notNull(),
    state: operationStateEnum("state").notNull().default("pending"),
    targetDomainId: uuid("target_domain_id").notNull(),
    /**
     * The fleet's active pointer at operation-creation time: the "old
     * active" a promote's post-commit demote steps act on. Null means
     * no active existed (headless promote) and the cleanup steps
     * deliberately no-op instead of guessing a domain.
     */
    sourceDomainId: uuid("source_domain_id"),
    /** Current OperationStep while running; null before claim/after finish. */
    currentStep: text("current_step"),
    stepStartedAt: timestamp("step_started_at", { withTimezone: true }),
    error: jsonb("error").$type<OperationError>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    /**
     * At most one in-flight operation per fleet. Concurrent promote or
     * demote requests race on this partial unique index; the loser
     * joins the winner's operation (or receives a conflict).
     */
    uniqueIndex("uq_operations_one_inflight_per_fleet")
      .on(t.fleetId)
      .where(sql`${t.state} IN ('pending', 'running')`),
    index("idx_operations_fleet").on(t.fleetId),
  ],
);
