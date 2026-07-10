import {
  fleetSnapshotSchema,
  resolveFleetPolicy,
  type FleetSnapshot,
} from "@haru/protocol";
import { eq, inArray, type SQL } from "drizzle-orm";

import { domains, fleets, slots } from "../schema/index.js";

import type { HaruDatabase } from "../client.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve a fleet reference: by id when it is UUID-shaped, falling
 * back to slug. Two separate lookups (never `id = ref OR slug = ref`):
 * the slug charset admits UUID-shaped slugs, and a single OR query
 * would return a planner-picked winner when one fleet's id collides
 * with another fleet's slug. Id wins deterministically instead.
 * Parameterized by column selection so the chat hot path's pointer
 * lookup stays narrow while the snapshot loads the full row.
 */
async function lookupFleetByReference<T>(
  runQuery: (where: SQL) => Promise<T[]>,
  reference: string,
): Promise<T | null> {
  if (UUID_RE.test(reference)) {
    const byId = await runQuery(eq(fleets.id, reference));
    if (byId[0]) {
      return byId[0];
    }
  }
  const bySlug = await runQuery(eq(fleets.slug, reference));
  return bySlug[0] ?? null;
}

async function findFleetRow(database: HaruDatabase, reference: string) {
  return lookupFleetByReference(
    (where) => database.select().from(fleets).where(where).limit(1),
    reference,
  );
}

export interface FleetRoutePointer {
  id: string;
  routeRevision: number;
  activeDomainId: string | null;
}

const ROUTE_POINTER_COLUMNS = {
  id: fleets.id,
  routeRevision: fleets.routeRevision,
  activeDomainId: fleets.activeDomainId,
};

/**
 * Narrow routing-pointer lookup for the chat hot path (and for
 * post-failure cleanup that must know whether a promotion actually
 * committed): resolves a fleet reference to its id + current route
 * revision + active pointer WITHOUT loading domains/slots or the full
 * fleet row. This runs on every chat request, so it selects exactly
 * these three columns. Same id-first/slug-fallback rule as
 * findFleetRow.
 */
export async function getFleetRoutePointer(
  database: HaruDatabase,
  reference: string,
): Promise<FleetRoutePointer | null> {
  return lookupFleetByReference(
    (where) =>
      database.select(ROUTE_POINTER_COLUMNS).from(fleets).where(where).limit(1),
    reference,
  );
}

/**
 * Load the full read model of a fleet (a fleet lookup, then domains
 * and slots in parallel; no transaction). The result is validated
 * through the protocol schema so malformed jsonb (spec/placement/
 * policy) surfaces here instead of deep inside a consumer.
 */
export async function getFleetSnapshot(
  database: HaruDatabase,
  reference: string,
): Promise<FleetSnapshot | null> {
  const fleet = await findFleetRow(database, reference);
  if (!fleet) {
    return null;
  }

  // Slots filter via a domain subquery on the fleet id so both reads
  // can run concurrently instead of waiting for the domain ids.
  const fleetDomainIds = database
    .select({ id: domains.id })
    .from(domains)
    .where(eq(domains.fleetId, fleet.id));
  const domainsQuery = database
    .select()
    .from(domains)
    .where(eq(domains.fleetId, fleet.id))
    .orderBy(domains.slug);
  const slotsQuery = database
    .select()
    .from(slots)
    .where(inArray(slots.domainId, fleetDomainIds))
    .orderBy(slots.gpuIndex, slots.kind);
  const [domainRows, slotRows] = await Promise.all([domainsQuery, slotsQuery]);

  return fleetSnapshotSchema.parse({
    id: fleet.id,
    slug: fleet.slug,
    displayName: fleet.displayName,
    activeDomainId: fleet.activeDomainId,
    routeRevision: fleet.routeRevision,
    policy: resolveFleetPolicy(fleet.policy),
    domains: domainRows.map((d) => ({
      id: d.id,
      fleetId: d.fleetId,
      slug: d.slug,
      state: d.state,
      provider: d.provider,
      placement: d.placement,
      supervisorUrl: d.supervisorUrl,
      servingBaseUrl: d.servingBaseUrl,
      lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
      stateUpdatedAt: d.stateUpdatedAt.toISOString(),
      slots: slotRows
        .filter((s) => s.domainId === d.id)
        .map((s) => ({
          id: s.id,
          domainId: s.domainId,
          gpuIndex: s.gpuIndex,
          kind: s.kind,
          state: s.state,
          spec: s.spec,
        })),
    })),
  });
}
