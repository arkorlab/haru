import {
  MAX_PROBE_PROMPT_CODE_POINTS,
  MAX_PROBE_TOKENS,
  type FleetPolicyPatch,
  type PlacementSpec,
} from "@haru/protocol";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { domainStateEnum } from "./enums.js";

const MAX_PROBE_PROMPT_CODE_POINTS_SQL = sql.raw(
  String(MAX_PROBE_PROMPT_CODE_POINTS),
);
const MAX_PROBE_TOKENS_SQL = sql.raw(String(MAX_PROBE_TOKENS));

/**
 * Fleets and domains live in one schema module because each references
 * the other: domains belong to a fleet, while a fleet's nullable active
 * pointer must identify a domain belonging to that SAME fleet.
 *
 * The callback references are evaluated after module initialisation.
 * The explicit AnyPgColumn return on domains.fleetId breaks the
 * otherwise circular TypeScript inference without weakening the
 * resulting Postgres foreign keys.
 */
export const fleets = pgTable(
  "fleets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: text("slug").notNull().unique(),
    displayName: text("display_name"),
    /**
     * The single authoritative routing pointer. Nullable so a fleet can
     * be headless; the composite foreign key below guarantees a non-null
     * pointer names one of this fleet's own domains.
     */
    activeDomainId: uuid("active_domain_id"),
    /** Bumped on every active-pointer move; consumers order on it. */
    routeRevision: integer("route_revision").notNull().default(1),
    /** Operator-provided policy keys only (a partial); the rest resolve
     * to the CURRENT default on read via resolveFleetPolicy. */
    policy: jsonb("policy").$type<FleetPolicyPatch>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "fleets_active_domain_membership_fk",
      columns: [table.id, table.activeDomainId],
      foreignColumns: [domains.fleetId, domains.id],
    }),
    // Defense in depth behind the app-layer slugSchema: a slug is a
    // lowercase, DNS-label-safe identifier with interior hyphens only,
    // bounded to 63 chars (POSIX regex mirrors slugSchema, which uses a
    // non-capturing group ERE cannot express).
    check(
      "fleets_slug_valid",
      sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(${table.slug}) <= 63`,
    ),
    // The policy is a partial JSON object, so absent keys pass. Check
    // JSON types before extracting/casting values: older malformed
    // rows still surface through snapshot validation, while these
    // guards enforce the newly introduced upper bounds without a cast
    // failure during db:push. PostgreSQL char_length counts Unicode
    // code points, matching JSON Schema maxLength and runtime parsing.
    check(
      "fleets_probe_policy_limits",
      sql`(CASE WHEN jsonb_typeof(${table.policy} #> '{probe,prompt}') = 'string' THEN char_length(${table.policy} #>> '{probe,prompt}') <= ${MAX_PROBE_PROMPT_CODE_POINTS_SQL} ELSE TRUE END) AND (CASE WHEN jsonb_typeof(${table.policy} #> '{probe,maxTokens}') = 'number' THEN (${table.policy} #>> '{probe,maxTokens}')::numeric <= ${MAX_PROBE_TOKENS_SQL} ELSE TRUE END)`,
    ),
    // The routing revision only ever increments from its default of 1.
    check("fleets_route_revision_positive", sql`${table.routeRevision} > 0`),
  ],
);

export const domains = pgTable(
  "domains",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    fleetId: uuid("fleet_id")
      .notNull()
      .references((): AnyPgColumn => fleets.id),
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
  (table) => [
    // Required as the referenced key for every same-fleet composite FK.
    unique("uq_domains_fleet_id").on(table.fleetId, table.id),
    unique("uq_domains_fleet_slug").on(table.fleetId, table.slug),
    index("idx_domains_fleet").on(table.fleetId),
    check(
      "domains_provider_valid",
      sql`${table.provider} IN ('skypilot', 'skyserve', 'static')`,
    ),
    // Defense in depth behind the app-layer slugSchema (see fleets).
    check(
      "domains_slug_valid",
      sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(${table.slug}) <= 63`,
    ),
  ],
);
