import {
  detectDegradedEscalation,
  detectFailover,
  firstStep,
  isBestEffortStep,
  nextStep,
  stepTimeoutMs,
} from "@haru/core";
import {
  advanceStep,
  appendEvent,
  claimOperation,
  completeOperation,
  createOperation,
  failOperation,
  getFleetSnapshot,
  getInFlightOperation,
  getOperation,
  markDomainSeen,
  toOperationSnapshot,
  transitionDomain,
  transitionDomainSlots,
} from "@haru/db";
import { operationStepSchema } from "@haru/protocol";

import { SupervisorError, supervisorClient } from "../supervisor-client.js";

import { executeStep, type StepOutcome } from "./steps.js";

import type { HaruDatabase, OperationRow } from "@haru/db";
import type {
  DomainSnapshot,
  FleetSnapshot,
  OperationSnapshot,
  OperationStep,
} from "@haru/protocol";

/** Timeout for one heartbeat status call during a reconcile tick. */
const HEARTBEAT_TIMEOUT_MS = 5000;

export interface ReconcilerDependencies {
  database: HaruDatabase;
  fetchFn: typeof fetch;
  now: () => Date;
  supervisorToken: string | undefined;
  /** Called after a winning switch_active CAS (cache invalidation). */
  onRouteChange?: (fleetId: string) => void;
}

export interface ReconcileResult {
  fleetId: string;
  operation: OperationSnapshot | null;
}

/**
 * Poll one domain's supervisor: heartbeat + coarse state sync.
 * Returns whether a domain-state CAS landed (the caller reloads the
 * snapshot only then). Patches the in-memory `lastSeenAt` so staleness
 * math stays correct on non-reloading ticks.
 */
async function pollOneDomain(
  dependencies: ReconcilerDependencies,
  fleet: FleetSnapshot,
  domain: DomainSnapshot,
): Promise<boolean> {
  if (domain.supervisorUrl === null) {
    return false;
  }
  const options = {
    fetchFn: dependencies.fetchFn,
    baseUrl: domain.supervisorUrl,
    token: dependencies.supervisorToken,
    timeoutMs: HEARTBEAT_TIMEOUT_MS,
  };
  const isActiveDomain = domain.id === fleet.activeDomainId;
  const at = dependencies.now();
  try {
    const status = await supervisorClient.status(options);
    await markDomainSeen(dependencies.database, domain.id, at);
    domain.lastSeenAt = at.toISOString();
    if (domain.state === "provisioning") {
      return await transitionDomain(
        dependencies.database,
        domain.id,
        ["provisioning"],
        "ready",
        at,
      );
    }
    if (domain.state === "failed") {
      // A reachable supervisor on a failed domain (typically escalated
      // away from during failover) rejoins as degraded; the branches
      // below recover it to ready on later ticks.
      return await transitionDomain(
        dependencies.database,
        domain.id,
        ["failed"],
        "degraded",
        at,
      );
    }
    if (isActiveDomain && domain.state === "ready" && !status.ready) {
      // The active domain's supervisor is reachable but its models
      // are not serving (crashed/asleep): reflect that in the domain
      // state so route-intent consumers can react, and start the
      // degraded-escalation clock.
      const didDegrade = await transitionDomain(
        dependencies.database,
        domain.id,
        ["ready"],
        "degraded",
        at,
      );
      if (didDegrade) {
        await appendEvent(dependencies.database, {
          fleetId: fleet.id,
          domainId: domain.id,
          type: "domain.not_ready",
          payload: { ready: status.ready },
        });
      }
      return didDegrade;
    }
    if (domain.state === "degraded") {
      // Recovery is role-aware: a standby's models sleep by design,
      // so its supervisor being reachable is recovery; the active
      // domain must actually report ready.
      const hasRecovered = isActiveDomain ? status.ready : true;
      if (hasRecovered) {
        return await transitionDomain(
          dependencies.database,
          domain.id,
          ["degraded"],
          "ready",
          at,
        );
      }
    }
    return false;
  } catch (error) {
    if (!(error instanceof SupervisorError)) {
      throw error;
    }
    if (domain.state === "ready") {
      const didDegrade = await transitionDomain(
        dependencies.database,
        domain.id,
        ["ready"],
        "degraded",
        at,
      );
      if (didDegrade) {
        await appendEvent(dependencies.database, {
          fleetId: fleet.id,
          domainId: domain.id,
          type: "domain.heartbeat.failed",
          payload: { message: error.message },
        });
      }
      return didDegrade;
    }
    return false;
  }
}

/**
 * Poll every domain's supervisor concurrently (an unreachable domain
 * costs one heartbeat timeout, not one per domain in sequence).
 * Returns whether any domain-state CAS landed.
 */
async function pollHeartbeats(
  dependencies: ReconcilerDependencies,
  fleet: FleetSnapshot,
): Promise<{ stateChanged: boolean }> {
  const settled = await Promise.allSettled(
    fleet.domains.map((domain) => pollOneDomain(dependencies, fleet, domain)),
  );
  // Non-SupervisorError rejections are programming errors: surface the
  // first one after every domain had its poll.
  const firstRejection = settled.find((r) => r.status === "rejected");
  if (firstRejection) {
    throw firstRejection.reason;
  }
  return {
    stateChanged: settled.some((r) => r.status === "fulfilled" && r.value),
  };
}

/**
 * Mark a failed promotion's target inference slots failed so a later
 * promote starts from a clean state. "serving" is included because the
 * probe step advances slots to serving BEFORE switch_active commits
 * routing: a promote failing at switch_active leaves an awake but
 * non-active domain, and its recorded state must demand a fresh
 * wake+probe cycle before it is trusted again. Demotes are excluded:
 * their target's serving slots reflect a sleep that genuinely did not
 * happen. Narrower than the table's predecessors of failed on purpose
 * (sleeping slots were never touched by the promotion).
 */
async function markFailedPromotionSlots(
  database: HaruDatabase,
  operation: OperationRow,
): Promise<void> {
  if (operation.kind !== "promote") {
    return;
  }
  await transitionDomainSlots(
    database,
    operation.targetDomainId,
    "inference",
    ["waking", "probing", "serving"],
    "failed",
  );
}

/**
 * How one nudge resolved. Executor outcomes and step timeouts both
 * map into this, so there is exactly one CAS-then-audit path.
 */
type StepResolution =
  | { kind: "advance" }
  | { kind: "advance_degrade_source" }
  | { kind: "fail"; code: string; message: string }
  | { kind: "pending" };

function outcomeToResolution(outcome: StepOutcome): StepResolution {
  switch (outcome.status) {
    case "done": {
      return { kind: "advance" };
    }
    case "pending": {
      return { kind: "pending" };
    }
    case "failed": {
      return { kind: "fail", code: outcome.code, message: outcome.message };
    }
  }
}

/**
 * Apply a resolution to the operation. The advance/complete/fail CAS
 * decides the winner between racing ticks: only the tick whose CAS
 * lands performs cleanup and writes audit events, so racing ticks (or
 * a timeout racing a concurrent success) cannot double-log, degrade
 * twice, or contradict the operation's recorded outcome. Returns the
 * updated row, the unchanged row for pending, or null when the CAS
 * lost (caller re-reads).
 */
async function applyStepResolution(
  dependencies: ReconcilerDependencies,
  fleet: FleetSnapshot,
  operation: OperationRow,
  step: OperationStep,
  resolution: StepResolution,
): Promise<OperationRow | null> {
  switch (resolution.kind) {
    case "pending": {
      // Budgets are wall-clock and executors are re-entrant: a pending
      // nudge writes nothing and the next tick simply retries.
      return operation;
    }
    case "fail": {
      const failedRow = await failOperation(
        dependencies.database,
        operation.id,
        { step, code: resolution.code, message: resolution.message },
        step,
      );
      if (!failedRow) {
        return null;
      }
      await markFailedPromotionSlots(dependencies.database, operation);
      await appendEvent(dependencies.database, {
        fleetId: fleet.id,
        operationId: operation.id,
        type: "operation.failed",
        payload: { step, code: resolution.code, message: resolution.message },
      });
      return failedRow;
    }
    case "advance":
    case "advance_degrade_source": {
      const next = nextStep(operation.kind, step);
      const advancedRow = await (next === null
        ? completeOperation(dependencies.database, operation.id, step)
        : advanceStep(
            dependencies.database,
            operation.id,
            step,
            next,
            dependencies.now(),
          ));
      if (!advancedRow) {
        return null;
      }
      if (resolution.kind === "advance_degrade_source") {
        // Post-commit cleanup of the old active domain timed out:
        // degrade it and move on. The old active being unhealthy is
        // typically why the failover happened; never fail the
        // operation for it.
        const oldDomain =
          operation.sourceDomainId === null
            ? fleet.domains.find((d) => d.id !== operation.targetDomainId)
            : fleet.domains.find((d) => d.id === operation.sourceDomainId);
        if (oldDomain) {
          await transitionDomain(
            dependencies.database,
            oldDomain.id,
            ["ready"],
            "degraded",
            dependencies.now(),
          );
        }
        await appendEvent(dependencies.database, {
          fleetId: fleet.id,
          operationId: operation.id,
          type: "operation.step.timeout_best_effort",
          payload: { step },
        });
      }
      await appendEvent(dependencies.database, {
        fleetId: fleet.id,
        operationId: operation.id,
        type: "operation.step.done",
        payload: { step, next },
      });
      return advancedRow;
    }
  }
}

/** Advance the fleet's in-flight operation by at most one step nudge. */
async function advanceInFlightOperation(
  dependencies: ReconcilerDependencies,
  fleet: FleetSnapshot,
): Promise<OperationRow | null> {
  const inflight = await getInFlightOperation(dependencies.database, fleet.id);
  if (!inflight) {
    return null;
  }
  let operation = inflight;
  if (operation.state === "pending") {
    const claimed = await claimOperation(
      dependencies.database,
      operation.id,
      firstStep(operation.kind),
      dependencies.now(),
    );
    // On a lost claim a concurrent tick owns the row; one re-read.
    operation =
      claimed ??
      (await getOperation(dependencies.database, operation.id)) ??
      operation;
  }
  if (
    operation.state !== "running" ||
    operation.currentStep === null ||
    operation.stepStartedAt === null
  ) {
    return operation;
  }
  const step = operationStepSchema.parse(operation.currentStep);

  const elapsedMs =
    dependencies.now().getTime() - operation.stepStartedAt.getTime();
  let resolution: StepResolution;
  if (elapsedMs > stepTimeoutMs(fleet.policy, step)) {
    resolution = isBestEffortStep(step)
      ? { kind: "advance_degrade_source" }
      : {
          kind: "fail",
          code: "step_timeout",
          message: `step ${step} exceeded its timeout`,
        };
  } else {
    resolution = outcomeToResolution(
      await executeStep(
        {
          database: dependencies.database,
          fetchFn: dependencies.fetchFn,
          now: dependencies.now,
          fleet,
          operation,
          supervisorToken: dependencies.supervisorToken,
          onRouteChange: dependencies.onRouteChange,
        },
        step,
      ),
    );
  }

  const applied = await applyStepResolution(
    dependencies,
    fleet,
    operation,
    step,
    resolution,
  );
  if (applied) {
    return applied;
  }
  // CAS lost: a concurrent tick moved the operation; re-read for the
  // caller's return value.
  return getOperation(dependencies.database, operation.id);
}

/**
 * One reconcile tick: heartbeat poll, degraded escalation,
 * auto-failover detection, and one nudge of the in-flight operation.
 * Safe to run concurrently: every write is a guarded compare-and-swap,
 * so racing ticks cannot double apply a transition. No DB transaction
 * spans a supervisor call.
 */
export async function reconcileFleet(
  dependencies: ReconcilerDependencies,
  fleetReference: string,
): Promise<ReconcileResult | null> {
  const initial = await getFleetSnapshot(dependencies.database, fleetReference);
  if (!initial) {
    return null;
  }

  const { stateChanged } = await pollHeartbeats(dependencies, initial);

  // Reload only when heartbeat handling actually moved a domain state;
  // steady-state ticks reuse the initial snapshot (lastSeenAt was
  // patched in memory).
  let fleet = initial;
  if (stateChanged) {
    const reloaded = await getFleetSnapshot(dependencies.database, initial.id);
    if (!reloaded) {
      return null;
    }
    fleet = reloaded;
  }

  const escalation = detectDegradedEscalation(
    fleet,
    dependencies.now().getTime(),
  );
  if (escalation) {
    const didEscalate = await transitionDomain(
      dependencies.database,
      escalation.domainId,
      ["degraded"],
      "failed",
      dependencies.now(),
    );
    if (didEscalate) {
      await appendEvent(dependencies.database, {
        fleetId: fleet.id,
        domainId: escalation.domainId,
        type: "domain.degraded.escalated",
        payload: {
          reason: escalation.reason,
          degradedGraceMs: fleet.policy.degradedGraceMs,
        },
      });
      // Patch the in-memory snapshot so detectFailover sees the failed
      // active in this same tick (no extra reload).
      const escalated = fleet.domains.find((d) => d.id === escalation.domainId);
      if (escalated) {
        escalated.state = "failed";
      }
    }
  }

  const failover = detectFailover(fleet, dependencies.now().getTime());
  if (failover) {
    const existing = await getInFlightOperation(
      dependencies.database,
      fleet.id,
    );
    if (!existing) {
      const created = await createOperation(dependencies.database, {
        fleetId: fleet.id,
        kind: "promote",
        targetDomainId: failover.targetDomainId,
        sourceDomainId: fleet.activeDomainId,
      });
      if (created.created) {
        await appendEvent(dependencies.database, {
          fleetId: fleet.id,
          operationId: created.operation.id,
          type: "operation.auto_failover",
          payload: { reason: failover.reason },
        });
      }
    }
  }

  const operation = await advanceInFlightOperation(dependencies, fleet);
  return {
    fleetId: fleet.id,
    operation: operation ? toOperationSnapshot(operation) : null,
  };
}
