import { PROMOTABLE_DOMAIN_STATES } from "./domain-state.js";
import { rankStandbys } from "./route-intent.js";

import type { FleetSnapshot } from "@haru/protocol";

export interface FailoverIntent {
  targetDomainId: string;
  reason: string;
}

export interface DegradedEscalation {
  domainId: string;
  reason: string;
}

/**
 * Decide whether the ACTIVE domain's degraded state has outlasted the
 * policy grace and should escalate to failed (which makes
 * `detectFailover`'s failed trigger fire). Pure: callers supply the
 * clock. Standbys are never escalated: failed would strip their
 * promotability, and a degraded standby already surfaces in route
 * intent eligibility.
 */
export function detectDegradedEscalation(
  fleet: FleetSnapshot,
  nowMs: number,
): DegradedEscalation | null {
  if (!fleet.policy.autoFailover || fleet.activeDomainId === null) {
    return null;
  }
  const active = fleet.domains.find((d) => d.id === fleet.activeDomainId);
  if (active?.state !== "degraded") {
    return null;
  }
  const degradedForMs = nowMs - Date.parse(active.stateUpdatedAt);
  if (degradedForMs <= fleet.policy.degradedGraceMs) {
    return null;
  }
  return {
    domainId: active.id,
    reason: `active domain ${active.slug} degraded for ${String(degradedForMs)}ms (grace ${String(fleet.policy.degradedGraceMs)}ms)`,
  };
}

/**
 * Decide whether the reconciler should auto-promote a standby. Pure:
 * callers supply the clock.
 *
 * Triggers when the active domain has failed outright, or when its
 * supervisor heartbeat is older than `policy.heartbeatStaleMs`. A
 * domain that has never been seen (lastSeenAt null) is not considered
 * stale: a freshly seeded fleet must not fail over before the first
 * reconcile pass.
 */
export function detectFailover(
  fleet: FleetSnapshot,
  nowMs: number,
): FailoverIntent | null {
  if (!fleet.policy.autoFailover) {
    return null;
  }
  if (fleet.activeDomainId === null) {
    return null;
  }
  const active = fleet.domains.find((d) => d.id === fleet.activeDomainId);
  if (!active) {
    return null;
  }

  const isHeartbeatStale =
    active.lastSeenAt !== null &&
    nowMs - Date.parse(active.lastSeenAt) > fleet.policy.heartbeatStaleMs;
  const hasFailed = active.state === "failed";
  if (!isHeartbeatStale && !hasFailed) {
    return null;
  }

  // First promotable standby of the shared ranking (state, heartbeat
  // freshness, slug) so failover and route intent agree on the pick.
  const standby = rankStandbys(fleet).find((d) =>
    PROMOTABLE_DOMAIN_STATES.includes(d.state),
  );
  if (!standby) {
    return null;
  }

  return {
    targetDomainId: standby.id,
    reason: hasFailed
      ? `active domain ${active.slug} is failed`
      : `active domain ${active.slug} heartbeat is stale`,
  };
}
