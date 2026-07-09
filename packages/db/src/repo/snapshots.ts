import {
  fleetSnapshotSchema,
  resolveFleetPolicy,
  type FleetSnapshot,
} from "@haru/protocol";
import { eq, inArray } from "drizzle-orm";

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
 */
async function findFleetRow(database: HaruDatabase, reference: string) {
  if (UUID_RE.test(reference)) {
    const byId = await database
      .select()
      .from(fleets)
      .where(eq(fleets.id, reference))
      .limit(1);
    if (byId[0]) {
      return byId[0];
    }
  }
  const bySlug = await database
    .select()
    .from(fleets)
    .where(eq(fleets.slug, reference))
    .limit(1);
  return bySlug[0];
}

/**
 * Narrow routing-pointer lookup for the chat hot path: resolves a
 * fleet reference to its id + current route revision without loading
 * domains/slots. The snapshot cache keys on the id and revalidates on
 * the revision, so pointer moves surface immediately while the heavy
 * snapshot stays cached.
 */
export async function getFleetRouteRevision(
  database: HaruDatabase,
  reference: string,
): Promise<{ id: string; slug: string; routeRevision: number } | null> {
  const fleet = await findFleetRow(database, reference);
  if (!fleet) {
    return null;
  }
  return { id: fleet.id, slug: fleet.slug, routeRevision: fleet.routeRevision };
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
