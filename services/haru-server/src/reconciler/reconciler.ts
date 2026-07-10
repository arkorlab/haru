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
  getFleetRoutePointer,
  getFleetSnapshot,
  getInFlightOperation,
  getOperation,
  escalateDomainIfFleetIdle,
  markDomainSeen,
  toOperationSnapshot,
  transitionDomain,
  transitionDomainSlots,
  transitionSlot,
} from "@haru/db";
import { operationStepSchema } from "@haru/protocol";

import { SupervisorError, supervisorClient } from "../supervisor-client.js";

import { executeStep, resolveSourceDomain, type StepOutcome } from "./steps.js";

import type { HaruDatabase, OperationRow } from "@haru/db";
import type {
  DomainSnapshot,
  FleetSnapshot,
  OperationSnapshot,
  OperationStep,
  SupervisorStatus,
} from "@haru/protocol";

/** Timeout for one heartbeat status call during a reconcile tick. */
const HEARTBEAT_TIMEOUT_MS = 5000;

export interface ReconcilerDependencies {
  database: HaruDatabase;
  fetchFn: typeof fetch;
  now: () => Date;
  supervisorToken: string | undefined;
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
/**
 * Mirror the ACTIVE domain's per-slot inference health from the
 * supervisor status. Heartbeats are the only reconciler of slot state
 * outside operations: without this, a crashed/asleep model keeps its
 * DB slot "serving" and chat + route intent keep routing to a dead
 * server. Per-slot CAS on purpose: one dead GPU must not drag its
 * healthy siblings along. Standbys are exempt (their models sleep by
 * design), and only the serving <-> failed pair is touched: slots on
 * a promotion's wake path belong to the operation's executors.
 */
async function syncActiveInferenceSlots(
  dependencies: ReconcilerDependencies,
  domain: DomainSnapshot,
  status: SupervisorStatus,
): Promise<boolean> {
  let didChangeState = false;
  for (const slot of domain.slots) {
    if (slot.kind !== "inference" || slot.spec.kind !== "inference") {
      continue;
    }
    const reported = status.slots.find(
      (s) => s.kind === "inference" && s.gpuIndex === slot.gpuIndex,
    );
    const reportedSleeping = new Map(
      (reported?.models ?? []).map((m) => [m.name, m.sleeping]),
    );
    // Healthy = every model the LAYOUT binds to this slot is reported
    // awake. A drifted supervisor omitting a configured model proves
    // nothing about it, so the slot must not stay serving.
    const isHealthy = slot.spec.models.every(
      (m) => reportedSleeping.get(m.name) === false,
    );
    if (slot.state === "serving" && !isHealthy) {
      // No ||= shortcuts here: EVERY slot must get its CAS this tick,
      // not just the first one that changed.
      const didFail = await transitionSlot(
        dependencies.database,
        slot.id,
        "inference",
        ["serving"],
        "failed",
      );
      if (didFail) {
        didChangeState = true;
      }
    } else if (slot.state === "failed" && isHealthy) {
      const didRecover = await transitionSlot(
        dependencies.database,
        slot.id,
        "inference",
        ["failed"],
        "serving",
      );
      if (didRecover) {
        didChangeState = true;
      }
    }
  }
  return didChangeState;
}

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
    const didSyncSlots = isActiveDomain
      ? await syncActiveInferenceSlots(dependencies, domain, status)
      : false;
    if (domain.state === "provisioning") {
      // Role-aware like the recovery rung below: an ACTIVE domain
      // finishing provisioning with its models down must surface as
      // degraded (and start the escalation clock), not as ready.
      const to = isActiveDomain && !status.ready ? "degraded" : "ready";
      const didMove = await transitionDomain(
        dependencies.database,
        domain.id,
        ["provisioning"],
        to,
        at,
      );
      return didMove || didSyncSlots;
    }
    if (domain.state === "failed") {
      // Role-aware rejoin: a failed STANDBY (typically escalated away
      // from during failover) rejoins as degraded on reachability and
      // recovers to ready on later ticks. A failed domain that is
      // still the ACTIVE pointer must also report ready, otherwise the
      // rejoin would reset the escalation clock every tick and throttle
      // failover retries to one per grace period.
      const canRejoin = isActiveDomain ? status.ready : true;
      if (!canRejoin) {
        return didSyncSlots;
      }
      const didMove = await transitionDomain(
        dependencies.database,
        domain.id,
        ["failed"],
        "degraded",
        at,
      );
      return didMove || didSyncSlots;
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
      return didDegrade || didSyncSlots;
    }
    if (domain.state === "degraded") {
      // Recovery is role-aware: a standby's models sleep by design,
      // so its supervisor being reachable is recovery; the active
      // domain must actually report ready.
      const hasRecovered = isActiveDomain ? status.ready : true;
      if (hasRecovered) {
        const didMove = await transitionDomain(
          dependencies.database,
          domain.id,
          ["degraded"],
          "ready",
          at,
        );
        return didMove || didSyncSlots;
      }
    }
    return didSyncSlots;
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
  // Fresh pointer read (the tick's snapshot may predate a concurrent
  // CAS): when the promotion's routing commit actually landed, the
  // target IS the active domain and marking its serving slots failed
  // would take down live traffic. Only switch_active moves the
  // pointer, so pointer === target proves the commit.
  const pointer = await getFleetRoutePointer(database, operation.fleetId);
  if (pointer?.activeDomainId === operation.targetDomainId) {
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
 * How one nudge resolved: an executor outcome as-is, or the extra
 * timeout-only variant (advance past a best-effort step, degrading the
 * old domain). One vocabulary, one CAS-then-audit path.
 */
type StepResolution = StepOutcome | { status: "advance_degrade_source" };

/**
 * Resolve a step that exceeded its policy budget. Best-effort steps
 * advance (degrading the old domain); everything else fails - EXCEPT a
 * timed-out switch_active whose routing CAS actually committed (crash
 * or stall between the pointer CAS and the step advance). The timeout
 * short-circuit skips the executor's idempotent re-run check, so this
 * re-reads the pointer: failing that operation would let
 * markFailedPromotionSlots treat the NEW active as a failed promotion
 * target, and converging to done also runs the post-commit cleanup
 * steps the old active still needs.
 *
 * A timed-out demote_old_sleep additionally SKIPS demote_old_train
 * (the operation completes at the sleep step): sleep was never
 * proven, so starting training would contend for VRAM with vLLM
 * servers that may still be awake.
 */
async function resolveStepTimeout(
  dependencies: ReconcilerDependencies,
  fleet: FleetSnapshot,
  operation: OperationRow,
  step: OperationStep,
): Promise<StepResolution> {
  if (isBestEffortStep(step)) {
    return { status: "advance_degrade_source" };
  }
  if (step === "switch_active") {
    const pointer = await getFleetRoutePointer(dependencies.database, fleet.id);
    if (pointer?.activeDomainId === operation.targetDomainId) {
      return { status: "done" };
    }
  }
  return {
    status: "failed",
    code: "step_timeout",
    message: `step ${step} exceeded its timeout`,
  };
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
  switch (resolution.status) {
    case "pending": {
      // Budgets are wall-clock and executors are re-entrant: a pending
      // nudge writes nothing to the operation row and the next tick
      // simply retries.
      return operation;
    }
    case "failed": {
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
    case "done":
    case "advance_degrade_source": {
      const isUnprovenSleep =
        resolution.status === "advance_degrade_source" &&
        step === "demote_old_sleep";
      const next = isUnprovenSleep ? null : nextStep(operation.kind, step);
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
      if (resolution.status === "advance_degrade_source") {
        // Post-commit cleanup of the old active domain timed out:
        // degrade it and move on. The old active being unhealthy is
        // typically why the failover happened; never fail the
        // operation for it.
        const oldDomain = resolveSourceDomain(fleet, operation);
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

/** Advance the fleet's in-flight operation by at most one step nudge.
 * The caller passes the in-flight row it already resolved this tick. */
async function advanceInFlightOperation(
  dependencies: ReconcilerDependencies,
  fleet: FleetSnapshot,
  inflight: OperationRow | null,
): Promise<OperationRow | null> {
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
  const resolution: StepResolution =
    elapsedMs > stepTimeoutMs(fleet.policy, step)
      ? await resolveStepTimeout(dependencies, fleet, operation, step)
      : await executeStep(
          {
            database: dependencies.database,
            fetchFn: dependencies.fetchFn,
            now: dependencies.now,
            fleet,
            operation,
            supervisorToken: dependencies.supervisorToken,
          },
          step,
        );

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

  // Resolve the in-flight operation ONCE per tick. Escalation and
  // auto-failover only act while the one-in-flight slot is free:
  // flipping the active to failed while an unrelated operation blocks
  // the promote would 503 traffic with no failover to show for it.
  let inflight = await getInFlightOperation(dependencies.database, fleet.id);
  if (!inflight) {
    const escalation = detectDegradedEscalation(
      fleet,
      dependencies.now().getTime(),
    );
    if (escalation) {
      // Single-statement CAS: the fleet-idle guard rides INSIDE the
      // update so an operation created after the in-flight check above
      // cannot be raced into a failed-active-with-blocked-failover.
      const didEscalate = await escalateDomainIfFleetIdle(
        dependencies.database,
        escalation.domainId,
        fleet.id,
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
        // Patch the in-memory snapshot so detectFailover sees the
        // failed active in this same tick (no extra reload). Patch
        // BOTH fields the transition wrote, so any same-tick reader
        // of stateUpdatedAt sees a consistent snapshot.
        const escalated = fleet.domains.find(
          (d) => d.id === escalation.domainId,
        );
        if (escalated) {
          escalated.state = "failed";
          escalated.stateUpdatedAt = dependencies.now().toISOString();
        }
      }
    }

    const failover = detectFailover(fleet, dependencies.now().getTime());
    if (failover) {
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
      inflight = created.operation;
    }
  }

  const operation = await advanceInFlightOperation(
    dependencies,
    fleet,
    inflight,
  );
  return {
    fleetId: fleet.id,
    operation: operation ? toOperationSnapshot(operation) : null,
  };
}
