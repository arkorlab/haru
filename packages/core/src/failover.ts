import { PROMOTABLE_DOMAIN_STATES } from "./domain-state.js";
import { rankStandbys } from "./route-intent.js";

import type {
  DomainSnapshot,
  FleetPolicy,
  FleetSnapshot,
} from "@haru/protocol";

/**
 * Whether a standby could plausibly complete a promotion right now:
 * promotable state, a supervisor to drive, at least one inference
 * binding to probe (a bindingless target fails the probe step), and a
 * fresh heartbeat (an unreachable supervisor cannot execute a single
 * step). Used to gate the degraded ESCALATION, which sacrifices the
 * active's remaining healthy models on the bet that failover
 * succeeds; detectFailover itself keeps the looser state-only pick
 * because a stale/failed active serves nothing anyway.
 */
function isViableFailoverTarget(
  domain: DomainSnapshot,
  policy: FleetPolicy,
  nowMs: number,
): boolean {
  if (!PROMOTABLE_DOMAIN_STATES.includes(domain.state)) {
    return false;
  }
  if (domain.supervisorUrl === null) {
    return false;
  }
  const hasInferenceBindings = domain.slots.some(
    (s) => s.spec.kind === "inference" && s.spec.models.length > 0,
  );
  if (!hasInferenceBindings) {
    return false;
  }
  return (
    domain.lastSeenAt !== null &&
    nowMs - Date.parse(domain.lastSeenAt) <= policy.heartbeatStaleMs
  );
}

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
  // Only escalate when failover can plausibly SUCCEED: with no viable
  // standby, flipping the active to failed would 503 ALL its traffic
  // (including still-healthy models) for nothing. Degraded keeps
  // serving; escalation waits until a standby is ready to take over.
  const hasViableStandby = rankStandbys(fleet).some((d) =>
    isViableFailoverTarget(d, fleet.policy, nowMs),
  );
  if (!hasViableStandby) {
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

  // Prefer the first VIABLE standby of the shared ranking: picking a
  // promotable-state dud (no supervisor, no bindings, unreachable)
  // fails the promotion before routing moves and gets re-picked every
  // tick, starving a viable lower-ranked standby indefinitely. When
  // nothing is provably viable, fall back to promotable state (a dead
  // active serves nothing, so any attempt beats none).
  const ranked = rankStandbys(fleet);
  const standby =
    ranked.find((d) => isViableFailoverTarget(d, fleet.policy, nowMs)) ??
    ranked.find((d) => PROMOTABLE_DOMAIN_STATES.includes(d.state));
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
