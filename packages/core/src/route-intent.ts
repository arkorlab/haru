import type {
  DomainSnapshot,
  FleetSnapshot,
  ModelBinding,
  RouteIntent,
  RouteTarget,
} from "@haru/protocol";

function modelsOf(domain: DomainSnapshot): ModelBinding[] {
  return domain.slots.flatMap((slot) =>
    slot.spec.kind === "inference" ? slot.spec.models : [],
  );
}

function isDomainRoutable(domain: DomainSnapshot): boolean {
  if (domain.state !== "ready" && domain.state !== "degraded") {
    return false;
  }
  const inferenceSlots = domain.slots.filter(
    (slot) => slot.kind === "inference",
  );
  if (inferenceSlots.length === 0) {
    return false;
  }
  return inferenceSlots.every((slot) => slot.state === "serving");
}

function toTarget(
  domain: DomainSnapshot,
  role: "active" | "standby",
): RouteTarget {
  const isEligible =
    role === "active" &&
    domain.servingBaseUrl !== null &&
    isDomainRoutable(domain);
  return {
    domainId: domain.id,
    domainSlug: domain.slug,
    endpointUrl: domain.servingBaseUrl,
    eligible: isEligible,
    weight: role === "active" ? 1 : 0,
    models: modelsOf(domain),
  };
}

/**
 * Build the provider-neutral route intent for a fleet. Pure: callers
 * supply the clock. Consumers (external DNS/proxy reconcilers) act on
 * this; haru itself stays router-vendor-neutral.
 */
export function buildRouteIntent(fleet: FleetSnapshot, now: Date): RouteIntent {
  const active =
    fleet.activeDomainId === null
      ? undefined
      : fleet.domains.find((d) => d.id === fleet.activeDomainId);
  // Two-domain slice: the standby is the first non-active domain.
  const standby = fleet.domains.find((d) => d.id !== fleet.activeDomainId);
  return {
    fleetId: fleet.id,
    fleetSlug: fleet.slug,
    revision: fleet.routeRevision,
    generatedAt: now.toISOString(),
    active: active ? toTarget(active, "active") : null,
    standby: standby ? toTarget(standby, "standby") : null,
  };
}
