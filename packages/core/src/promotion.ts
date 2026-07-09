import { PROMOTABLE_DOMAIN_STATES } from "./domain-state.js";

import type { FleetSnapshot } from "@haru/protocol";

export type PromotionDecision =
  | { type: "already_active"; routeRevision: number }
  | { type: "invalid_target"; reason: string }
  | { type: "create"; targetDomainId: string };

/**
 * Pure decision for a promote request. Promoting the domain that is
 * already active is an idempotent no-op; a target outside the fleet or
 * in a non-promotable state is rejected before any operation row is
 * created.
 */
export function decidePromotion(
  fleet: FleetSnapshot,
  targetDomainId: string,
): PromotionDecision {
  const domain = fleet.domains.find((d) => d.id === targetDomainId);
  if (!domain) {
    return {
      type: "invalid_target",
      reason: `domain ${targetDomainId} does not belong to fleet ${fleet.slug}`,
    };
  }
  if (fleet.activeDomainId === targetDomainId) {
    return { type: "already_active", routeRevision: fleet.routeRevision };
  }
  if (!PROMOTABLE_DOMAIN_STATES.includes(domain.state)) {
    return {
      type: "invalid_target",
      reason: `domain ${domain.slug} is ${domain.state}; only ready or degraded domains can be promoted`,
    };
  }
  return { type: "create", targetDomainId };
}

export type DemotionDecision =
  | { type: "invalid_target"; reason: string }
  | { type: "create"; targetDomainId: string };

/**
 * Pure decision for a demote request. The active domain can never be
 * demoted directly (promote a sibling instead) so the fleet always
 * keeps a routable active pointer.
 */
export function decideDemotion(
  fleet: FleetSnapshot,
  targetDomainId: string,
): DemotionDecision {
  const domain = fleet.domains.find((d) => d.id === targetDomainId);
  if (!domain) {
    return {
      type: "invalid_target",
      reason: `domain ${targetDomainId} does not belong to fleet ${fleet.slug}`,
    };
  }
  if (fleet.activeDomainId === targetDomainId) {
    return {
      type: "invalid_target",
      reason: `domain ${domain.slug} is active; promote another domain first`,
    };
  }
  if (!PROMOTABLE_DOMAIN_STATES.includes(domain.state)) {
    return {
      type: "invalid_target",
      reason: `domain ${domain.slug} is ${domain.state}; only ready or degraded domains can be demoted`,
    };
  }
  return { type: "create", targetDomainId };
}
