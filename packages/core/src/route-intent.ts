import type {
  DomainSnapshot,
  FleetSnapshot,
  ModelBinding,
  RouteIntent,
  RouteModel,
  RouteTarget,
} from "@haru/protocol";

/**
 * Whether a domain's state admits routing traffic to it at all. The
 * single predicate shared by route intent and the chat proxy, so
 * external routing consumers and haru's own ingress agree.
 */
export function isRoutableDomainState(domain: DomainSnapshot): boolean {
  return domain.state === "ready" || domain.state === "degraded";
}

/**
 * Every model binding on the domain with its per-model eligibility:
 * routable domain state AND the binding's slot is serving. A partially
 * degraded domain keeps serving its healthy models.
 */
export function routableModels(domain: DomainSnapshot): RouteModel[] {
  const isStateRoutable = isRoutableDomainState(domain);
  // Gating on the spec discriminant is equivalent to gating on the
  // slot row's `kind`: slotSnapshotSchema enforces `kind === spec.kind`
  // at the read boundary, so the two never disagree here.
  return domain.slots.flatMap((slot) =>
    slot.spec.kind === "inference"
      ? slot.spec.models.map((m) => ({
          name: m.name,
          servingUrl: m.servingUrl,
          eligible: isStateRoutable && slot.state === "serving",
        }))
      : [],
  );
}

/** Resolve one model name to its eligible binding, or null. */
export function findRoutableBinding(
  domain: DomainSnapshot,
  modelName: string,
): ModelBinding | null {
  const model = routableModels(domain).find(
    (m) => m.name === modelName && m.eligible,
  );
  return model ? { name: model.name, servingUrl: model.servingUrl } : null;
}

function stateRank(domain: DomainSnapshot): number {
  if (domain.state === "ready") {
    return 0;
  }
  if (domain.state === "degraded") {
    return 1;
  }
  return 2;
}

/**
 * Rank the non-active domains by promotion preference: healthier state
 * first (ready > degraded > rest), then the most recently seen
 * heartbeat (never-seen last), then slug as a deterministic tiebreak.
 * Auto-failover promotes the first promotable entry of this ranking,
 * and route intent reports the same order.
 */
export function rankStandbys(fleet: FleetSnapshot): DomainSnapshot[] {
  return fleet.domains
    .filter((d) => d.id !== fleet.activeDomainId)
    .toSorted((a, b) => {
      const byState = stateRank(a) - stateRank(b);
      if (byState !== 0) {
        return byState;
      }
      const seenA = a.lastSeenAt === null ? -1 : Date.parse(a.lastSeenAt);
      const seenB = b.lastSeenAt === null ? -1 : Date.parse(b.lastSeenAt);
      if (seenA !== seenB) {
        return seenB - seenA;
      }
      // Codepoint order, NOT localeCompare: the tiebreak must rank the
      // same on every replica regardless of the process's ICU locale
      // (replicas race the one-in-flight-operation index on this pick).
      if (a.slug === b.slug) {
        return 0;
      }
      return a.slug < b.slug ? -1 : 1;
    });
}

function toTarget(
  domain: DomainSnapshot,
  role: "active" | "standby",
): RouteTarget {
  const models = routableModels(domain);
  // Per-model `eligible` is computed role-agnostically, so a just-
  // demoted domain whose slots are still `serving` can report
  // `models[].eligible === true` until sleep_vllm lands. That per-model
  // flag is advisory for a standby; the target-level `eligible`/`weight`
  // below (the contract consumers route on) is hard-forced off/zero.
  const isEligible =
    role === "active" &&
    domain.servingBaseUrl !== null &&
    models.some((m) => m.eligible);
  return {
    domainId: domain.id,
    domainSlug: domain.slug,
    endpointUrl: domain.servingBaseUrl,
    eligible: isEligible,
    weight: role === "active" ? 1 : 0,
    models,
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
  return {
    fleetId: fleet.id,
    fleetSlug: fleet.slug,
    revision: fleet.routeRevision,
    generatedAt: now.toISOString(),
    active: active ? toTarget(active, "active") : null,
    standbys: rankStandbys(fleet).map((d) => toTarget(d, "standby")),
  };
}
