import { PROMOTABLE_DOMAIN_STATES } from "./domain-state.js";
import { rankStandbys } from "./route-intent.js";

import type {
  DomainSnapshot,
  FleetPolicy,
  FleetSnapshot,
} from "@haru/protocol";

/**
 * Whether the domain binds at least one inference model. A domain
 * without any can never complete a promotion (nothing to wake or
 * probe, nothing to route to afterwards): decidePromotion rejects
 * such targets and detectFailover never picks them.
 */
export function hasInferenceBindings(domain: DomainSnapshot): boolean {
  // Gate on the slot row's kind (like every other slot predicate);
  // the spec.kind check is the type narrowing for `models`.
  return domain.slots.some(
    (s) =>
      s.kind === "inference" &&
      s.spec.kind === "inference" &&
      s.spec.models.length > 0,
  );
}

/**
 * Whether a standby could plausibly complete a promotion right now:
 * ready state, a supervisor to drive, at least one inference binding
 * to probe (a bindingless target fails the probe step), and a fresh
 * heartbeat (an unreachable supervisor cannot execute a single step).
 * Used to gate the degraded ESCALATION, which sacrifices the active's
 * remaining healthy models on the bet that failover succeeds;
 * detectFailover itself keeps the looser state-based fallback because
 * a stale/failed active serves nothing anyway.
 *
 * Ready is required, not merely promotable: a DEGRADED standby is
 * degraded precisely because its most recent heartbeat failed, while
 * lastSeenAt still records the last SUCCESS - the freshness check
 * alone would keep treating that just-unreachable supervisor as
 * viable for a whole heartbeatStaleMs window.
 *
 * MIRRORED IN SQL: the escalation CAS re-checks this predicate inside
 * its UPDATE statement (escalateDomainIfFleetIdle in @haru/db) so a
 * concurrent heartbeat cannot strip the standby between the in-memory
 * decision and the escalation. Keep the two in sync.
 */
function isViableFailoverTarget(
  domain: DomainSnapshot,
  policy: FleetPolicy,
  nowMs: number,
): boolean {
  if (domain.state !== "ready") {
    return false;
  }
  if (domain.supervisorUrl === null) {
    return false;
  }
  if (!hasInferenceBindings(domain)) {
    return false;
  }
  // A failed inference slot means the heartbeat observed the standby's
  // local vLLM unreachable (or a promotion left it dirty): waking it
  // will stall, so escalating the active on this target's account
  // would trade healthy traffic for a doomed promotion.
  const hasFailedInferenceSlot = domain.slots.some(
    (s) => s.kind === "inference" && s.state === "failed",
  );
  if (hasFailedInferenceSlot) {
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
 *
 * MIRRORED IN SQL: the grace comparison is re-checked inside the
 * escalation CAS (`escalateDomainIfFleetIdle` in @haru/db) against the
 * live `stateUpdatedAt`, so a concurrent reconciler that recovered then
 * re-degraded the active between this tick's snapshot and its CAS cannot
 * escalate on a stale-but-past-grace timestamp. Keep the two in sync.
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
  // promotable-state dud (unreachable) fails the promotion before
  // routing moves and gets re-picked every tick, starving a viable
  // lower-ranked standby indefinitely. When nothing is provably
  // viable, fall back to promotable state (a dead active serves
  // nothing, so any attempt beats none) - but never to a domain whose
  // promotion cannot even be attempted: no inference bindings means
  // nothing to serve, and no supervisor URL fails the very first step
  // (both would be re-picked forever, starving standbys that merely
  // have a stale heartbeat).
  const ranked = rankStandbys(fleet);
  const standby =
    ranked.find((d) => isViableFailoverTarget(d, fleet.policy, nowMs)) ??
    ranked.find(
      (d) =>
        PROMOTABLE_DOMAIN_STATES.includes(d.state) &&
        d.supervisorUrl !== null &&
        hasInferenceBindings(d),
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
