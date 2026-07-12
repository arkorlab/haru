import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { domains } from "./domains.js";
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
    targetDomainId: uuid("target_domain_id")
      .notNull()
      .references(() => domains.id),
    /**
     * The fleet's active pointer at operation-creation time: the "old
     * active" a promote's post-commit demote steps act on. Null means
     * no active existed (headless promote) and the cleanup steps
     * deliberately no-op instead of guessing a domain.
     */
    sourceDomainId: uuid("source_domain_id").references(() => domains.id),
    /** Current OperationStep while running; null before claim/after finish. */
    currentStep: text("current_step"),
    stepStartedAt: timestamp("step_started_at", { withTimezone: true }),
    /**
     * Set true, atomically with the routing-pointer move, by
     * `switchActive` (the promotion commit point). This is the ONLY
     * EPQ-safe signal that a promote already committed routing: the
     * `target_not_routed` fail guard reads THIS column (a column of the
     * operation row it locks), not a correlated `fleets` subquery. Under
     * READ COMMITTED a concurrent `failOperation` blocked on the locked
     * operation row re-checks the row's own columns on unblock but keeps
     * its statement snapshot for subqueries, so a `fleets`-pointer
     * subquery would still read the pre-commit pointer and let the
     * failure land on a live-routed target. Guarding on this column
     * closes that switch-commits-first race.
     */
    routingCommitted: boolean("routing_committed").notNull().default(false),
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
