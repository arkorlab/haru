import { PROMOTABLE_DOMAIN_STATES } from "./domain-state.js";

import type { FleetSnapshot } from "@haru/protocol";

export interface FailoverIntent {
  targetDomainId: string;
  reason: string;
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

  const standby = fleet.domains.find(
    (d) => d.id !== active.id && PROMOTABLE_DOMAIN_STATES.includes(d.state),
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
