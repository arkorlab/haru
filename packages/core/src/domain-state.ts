import type { DomainState } from "@haru/protocol";

/** Thrown when a state transition violates the machine. */
export class InvalidTransitionError extends Error {
  readonly from: string;
  readonly to: string;

  constructor(entity: string, from: string, to: string) {
    super(`invalid ${entity} transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
    this.from = from;
    this.to = to;
  }
}

/**
 * Domain state machine. The DB layer re-enforces this with
 * compare-and-swap updates (`WHERE state IN (...)`); this table is the
 * single place the allowed edges are written down.
 */
const DOMAIN_TRANSITIONS: Record<DomainState, readonly DomainState[]> = {
  // provisioning -> degraded: an ACTIVE domain finishing provisioning
  // with its models down must not surface as ready for a tick (that
  // would also delay the degraded-escalation clock).
  provisioning: ["ready", "degraded", "failed", "stopping"],
  ready: ["degraded", "failed", "stopping"],
  degraded: ["ready", "failed", "stopping"],
  // failed -> degraded: an escalated-away active whose supervisor
  // heartbeats again rejoins as degraded (then recovers to ready via
  // the normal heartbeat path).
  failed: ["provisioning", "degraded", "stopping"],
  stopping: ["stopped"],
  stopped: ["provisioning"],
};

export function canTransitionDomain(
  from: DomainState,
  to: DomainState,
): boolean {
  return DOMAIN_TRANSITIONS[from].includes(to);
}

export function assertDomainTransition(
  from: DomainState,
  to: DomainState,
): void {
  if (!canTransitionDomain(from, to)) {
    throw new InvalidTransitionError("domain", from, to);
  }
}

/** States a domain may be promoted from. */
export const PROMOTABLE_DOMAIN_STATES: readonly DomainState[] = [
  "ready",
  "degraded",
];
