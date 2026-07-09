import {
  fleetLayoutSchema,
  type FleetLayout,
  type SlotState,
} from "@haru/protocol";
import { and, eq, isNull } from "drizzle-orm";

import { domains, fleets, slots } from "../schema/index.js";

import type { HaruDatabase } from "../client.js";

export interface ApplyLayoutResult {
  fleetId: string;
  createdFleet: boolean;
  domains: { id: string; slug: string }[];
}

function initialSlotState(
  kind: "inference" | "training",
  isActiveDomain: boolean,
): SlotState {
  if (kind === "inference") {
    // Active serves immediately; standby starts in the level 1 sleep
    // posture and is woken by promotion.
    return isActiveDomain ? "serving" : "sleeping";
  }
  return "idle";
}

/**
 * Idempotently materialise a declarative fleet layout: existing rows
 * (matched by slug / gpu-index unique keys) are left untouched, so
 * re-running a seed never duplicates or resets state. All inserts are
 * short single statements; no transaction is required because every
 * row insert is independently idempotent via ON CONFLICT DO NOTHING.
 */
export async function applyFleetLayout(
  database: HaruDatabase,
  layoutInput: unknown,
): Promise<ApplyLayoutResult> {
  const layout: FleetLayout = fleetLayoutSchema.parse(layoutInput);

  const insertedFleets = await database
    .insert(fleets)
    .values({
      slug: layout.slug,
      displayName: layout.displayName,
      policy: layout.policy ?? {},
    })
    .onConflictDoNothing()
    .returning();
  let fleetRow = insertedFleets[0];
  const isCreatedFleet = fleetRow !== undefined;
  if (!fleetRow) {
    const existing = await database
      .select()
      .from(fleets)
      .where(eq(fleets.slug, layout.slug))
      .limit(1);
    fleetRow = existing[0];
  }
  if (!fleetRow) {
    throw new Error(`fleet ${layout.slug} vanished during layout apply`);
  }

  const domainResults: { id: string; slug: string }[] = [];
  for (const domainLayout of layout.domains) {
    const isActiveDomain = domainLayout.slug === layout.activeDomainSlug;
    const insertedDomains = await database
      .insert(domains)
      .values({
        fleetId: fleetRow.id,
        slug: domainLayout.slug,
        provider: domainLayout.provider,
        // Statically provisioned domains are assumed reachable; driver
        // backed ones start in provisioning until a reconcile pass.
        state: domainLayout.provider === "static" ? "ready" : "provisioning",
        placement: domainLayout.placement,
        supervisorUrl: domainLayout.supervisorUrl,
        servingBaseUrl: domainLayout.servingBaseUrl,
      })
      .onConflictDoNothing()
      .returning();
    let domainRow = insertedDomains[0];
    if (!domainRow) {
      const existing = await database
        .select()
        .from(domains)
        .where(
          and(
            eq(domains.fleetId, fleetRow.id),
            eq(domains.slug, domainLayout.slug),
          ),
        )
        .limit(1);
      domainRow = existing[0];
    }
    if (!domainRow) {
      throw new Error(`domain ${domainLayout.slug} vanished during apply`);
    }
    domainResults.push({ id: domainRow.id, slug: domainRow.slug });

    for (const slotLayout of domainLayout.slots) {
      const { gpuIndex, ...spec } = slotLayout;
      await database
        .insert(slots)
        .values({
          domainId: domainRow.id,
          gpuIndex,
          kind: spec.kind,
          state: initialSlotState(spec.kind, isActiveDomain),
          spec,
        })
        .onConflictDoNothing();
    }
  }

  // Point the fleet at its initial active domain only when no pointer
  // exists yet: applying a layout never steals routing from a live
  // fleet (that is what promote is for).
  if (layout.activeDomainSlug !== undefined) {
    const active = domainResults.find(
      (d) => d.slug === layout.activeDomainSlug,
    );
    if (active) {
      await database
        .update(fleets)
        .set({ activeDomainId: active.id })
        .where(and(eq(fleets.id, fleetRow.id), isNull(fleets.activeDomainId)));
    }
  }

  return {
    fleetId: fleetRow.id,
    createdFleet: isCreatedFleet,
    domains: domainResults,
  };
}
