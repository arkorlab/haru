import {
  fleetSnapshotSchema,
  resolveFleetPolicy,
  type FleetSnapshot,
} from "@haru/protocol";
import { eq, inArray, or, type SQL } from "drizzle-orm";

import { domains, fleets, slots } from "../schema/index.js";

import type { HaruDatabase } from "../client.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** WHERE clause matching a fleet by slug, or by id when `ref` is a UUID. */
export function fleetReferenceWhere(reference: string): SQL | undefined {
  return UUID_RE.test(reference)
    ? or(eq(fleets.id, reference), eq(fleets.slug, reference))
    : eq(fleets.slug, reference);
}

/**
 * Load the full read model of a fleet (three short SELECTs, no
 * transaction). The result is validated through the protocol schema so
 * malformed jsonb (spec/placement/policy) surfaces here instead of
 * deep inside a consumer.
 */
export async function getFleetSnapshot(
  database: HaruDatabase,
  reference: string,
): Promise<FleetSnapshot | null> {
  const fleetRows = await database
    .select()
    .from(fleets)
    .where(fleetReferenceWhere(reference))
    .limit(1);
  const fleet = fleetRows[0];
  if (!fleet) {
    return null;
  }

  const domainRows = await database
    .select()
    .from(domains)
    .where(eq(domains.fleetId, fleet.id))
    .orderBy(domains.slug);
  const domainIds = domainRows.map((d) => d.id);
  const slotRows =
    domainIds.length === 0
      ? []
      : await database
          .select()
          .from(slots)
          .where(inArray(slots.domainId, domainIds))
          .orderBy(slots.gpuIndex, slots.kind);

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
