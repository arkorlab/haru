import { sql } from "drizzle-orm";
import {
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import type { FleetPolicy } from "@haru/protocol";

export const fleets = pgTable(
  "fleets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: text("slug").notNull().unique(),
    displayName: text("display_name"),
    /**
     * The single authoritative routing pointer. Nullable application
     * level reference (a foreign key here would be circular with
     * domains.fleet_id); the repository layer only ever writes ids read
     * from this fleet's own domains, and moves the pointer exclusively
     * through a compare-and-swap UPDATE.
     */
    activeDomainId: uuid("active_domain_id"),
    /** Bumped on every active-pointer move; consumers order on it. */
    routeRevision: integer("route_revision").notNull().default(1),
    /** Partial FleetPolicy; parsed with defaults on read. */
    policy: jsonb("policy").$type<Partial<FleetPolicy>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // Defense in depth behind the app-layer slugSchema: a slug is a
    // lowercase, DNS-label-safe identifier with interior hyphens only,
    // bounded to 63 chars (POSIX regex mirrors slugSchema, which uses a
    // non-capturing group ERE cannot express).
    check(
      "fleets_slug_valid",
      sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(${t.slug}) <= 63`,
    ),
    // The routing revision only ever increments from its default of 1.
    check("fleets_route_revision_positive", sql`${t.routeRevision} > 0`),
  ],
);
