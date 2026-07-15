import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { domainStateEnum } from "./enums.js";
import { fleets } from "./fleets.js";

import type { PlacementSpec } from "@haru/protocol";

export const domains = pgTable(
  "domains",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    fleetId: uuid("fleet_id")
      .notNull()
      .references(() => fleets.id),
    slug: text("slug").notNull(),
    state: domainStateEnum("state").notNull().default("provisioning"),
    /** 'skypilot' | 'skyserve' | 'static'; static skips drivers. */
    provider: text("provider").notNull(),
    placement: jsonb("placement").$type<PlacementSpec>().notNull(),
    /** Private control URL of the domain's supervisor. */
    supervisorUrl: text("supervisor_url"),
    /** OpenAI-compatible base URL for routed inference traffic. */
    servingBaseUrl: text("serving_base_url"),
    /** Last successful supervisor heartbeat observed by the reconciler. */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
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
    unique("uq_domains_fleet_slug").on(t.fleetId, t.slug),
    index("idx_domains_fleet").on(t.fleetId),
    check(
      "domains_provider_valid",
      sql`${t.provider} IN ('skypilot', 'skyserve', 'static')`,
    ),
    // Defense in depth behind the app-layer slugSchema (see fleets.ts).
    check(
      "domains_slug_valid",
      sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(${t.slug}) <= 63`,
    ),
  ],
);
