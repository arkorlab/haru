import {
  detectFailover,
  firstStep,
  isBestEffortStep,
  nextStep,
  stepTimeoutMs,
} from "@haru/core";
import {
  advanceStep,
  appendEvent,
  bumpAttempt,
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

import { executeStep } from "./steps.js";

import type { HaruDatabase, OperationRow } from "@haru/db";
import type {
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
}

export interface ReconcileResult {
  fleetId: string;
  operation: OperationSnapshot | null;
}

/** Poll every domain's supervisor once: heartbeat + coarse state sync. */
async function pollHeartbeats(
  dependencies: ReconcilerDependencies,
  fleet: FleetSnapshot,
): Promise<void> {
  for (const domain of fleet.domains) {
    if (domain.supervisorUrl === null) {
      continue;
    }
    const options = {
      fetchFn: dependencies.fetchFn,
      baseUrl: domain.supervisorUrl,
      token: dependencies.supervisorToken,
      timeoutMs: HEARTBEAT_TIMEOUT_MS,
    };
    const isActiveDomain = domain.id === fleet.activeDomainId;
    try {
      const status = await supervisorClient.status(options);
      await markDomainSeen(
        dependencies.database,
        domain.id,
        dependencies.now(),
      );
      if (domain.state === "provisioning") {
        await transitionDomain(
          dependencies.database,
          domain.id,
          ["provisioning"],
          "ready",
        );
      } else if (isActiveDomain && domain.state === "ready" && !status.ready) {
        // The active domain's supervisor is reachable but its models
        // are not serving (crashed/asleep): reflect that in the domain
        // state so route-intent consumers can react. Automatic
        // failover still keys on heartbeat staleness / failed state.
        await transitionDomain(
          dependencies.database,
          domain.id,
          ["ready"],
          "degraded",
        );
        await appendEvent(dependencies.database, {
          fleetId: fleet.id,
          domainId: domain.id,
          type: "domain.not_ready",
          payload: { ready: status.ready },
        });
      } else if (domain.state === "degraded") {
        // Recovery is role-aware: a standby's models sleep by design,
        // so its supervisor being reachable is recovery; the active
        // domain must actually report ready.
        const hasRecovered = isActiveDomain ? status.ready : true;
        if (hasRecovered) {
          await transitionDomain(
            dependencies.database,
            domain.id,
            ["degraded"],
            "ready",
          );
        }
      }
    } catch (error) {
      if (!(error instanceof SupervisorError)) {
        throw error;
      }
      if (domain.state === "ready") {
        await transitionDomain(
          dependencies.database,
          domain.id,
          ["ready"],
          "degraded",
        );
        await appendEvent(dependencies.database, {
          fleetId: fleet.id,
          domainId: domain.id,
          type: "domain.heartbeat.failed",
          payload: { message: error.message },
        });
      }
    }
  }
}

/**
 * Mark a failed promotion's target inference slots failed so a later
 * promote starts from a clean state. "serving" is included because the
 * probe step advances slots to serving BEFORE switch_active commits
 * routing: a promote failing at switch_active leaves an awake but
 * non-active domain, and its recorded state must demand a fresh
 * wake+probe cycle before it is trusted again. Demotes are excluded:
 * their target's serving slots reflect a sleep that genuinely did not
 * happen.
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

/** Handle a step that exceeded its policy timeout. */
async function handleStepTimeout(
  dependencies: ReconcilerDependencies,
  fleet: FleetSnapshot,
  operation: OperationRow,
  step: OperationStep,
): Promise<void> {
  if (isBestEffortStep(step)) {
    // Advance first: the CAS on the current step decides which of two
    // racing timeout ticks owns the timeout. The loser (or a tick
    // racing a concurrent successful completion) must not degrade the
    // old domain or write a duplicate audit event.
    const next = nextStep(operation.kind, step);
    const hasAdvanced = await (next === null
      ? completeOperation(dependencies.database, operation.id, step)
      : advanceStep(
          dependencies.database,
          operation.id,
          step,
          next,
          dependencies.now(),
        ));
    if (!hasAdvanced) {
      return;
    }
    // Post-commit cleanup of the old active domain: degrade it and
    // move on. The old active being unhealthy is typically why the
    // failover happened; never fail the operation for it.
    const oldDomain =
      operation.sourceDomainId === null
        ? fleet.domains.find((d) => d.id !== operation.targetDomainId)
        : fleet.domains.find((d) => d.id === operation.sourceDomainId);
    if (oldDomain) {
      await transitionDomain(
        dependencies.database,
        oldDomain.id,
        ["ready", "degraded"],
        "degraded",
      );
    }
    await appendEvent(dependencies.database, {
      fleetId: fleet.id,
      operationId: operation.id,
      type: "operation.step.timeout_best_effort",
      payload: { step },
    });
    return;
  }
  // Guarded on the current step: a concurrent tick that advanced or
  // completed this step in the meantime makes the fail a no-op.
  const didFail = await failOperation(
    dependencies.database,
    operation.id,
    {
      step,
      code: "step_timeout",
      message: `step ${step} exceeded its timeout`,
    },
    step,
  );
  if (!didFail) {
    return;
  }
  await markFailedPromotionSlots(dependencies.database, operation);
  await appendEvent(dependencies.database, {
    fleetId: fleet.id,
    operationId: operation.id,
    type: "operation.failed",
    payload: { step, code: "step_timeout" },
  });
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
  if (inflight.state === "pending") {
    await claimOperation(
      dependencies.database,
      inflight.id,
      firstStep(inflight.kind),
      dependencies.now(),
    );
  }
  const operation = await getOperation(dependencies.database, inflight.id);
  if (
    operation?.state !== "running" ||
    operation.currentStep === null ||
    operation.stepStartedAt === null
  ) {
    return operation ?? null;
  }
  const step = operationStepSchema.parse(operation.currentStep);

  const elapsedMs =
    dependencies.now().getTime() - operation.stepStartedAt.getTime();
  if (elapsedMs > stepTimeoutMs(fleet.policy, step)) {
    await handleStepTimeout(dependencies, fleet, operation, step);
    return getOperation(dependencies.database, operation.id);
  }

  const outcome = await executeStep(
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

  switch (outcome.status) {
    case "done": {
      const next = nextStep(operation.kind, step);
      // Guarded like the failure path: only the tick whose CAS landed
      // writes the audit event, so racing ticks (or a done racing a
      // concurrent timeout-failure) cannot double-log or contradict
      // the operation's recorded outcome.
      const hasAdvanced = await (next === null
        ? completeOperation(dependencies.database, operation.id, step)
        : advanceStep(
            dependencies.database,
            operation.id,
            step,
            next,
            dependencies.now(),
          ));
      if (hasAdvanced) {
        await appendEvent(dependencies.database, {
          fleetId: fleet.id,
          operationId: operation.id,
          type: "operation.step.done",
          payload: { step, next },
        });
      }
      break;
    }
    case "failed": {
      // Same step guard as the timeout path: only the tick whose fail
      // actually landed performs the cleanup and audit write.
      const didFail = await failOperation(
        dependencies.database,
        operation.id,
        {
          step,
          code: outcome.code,
          message: outcome.message,
        },
        step,
      );
      if (!didFail) {
        break;
      }
      await markFailedPromotionSlots(dependencies.database, operation);
      await appendEvent(dependencies.database, {
        fleetId: fleet.id,
        operationId: operation.id,
        type: "operation.failed",
        payload: { step, code: outcome.code, message: outcome.message },
      });
      break;
    }
    case "pending": {
      await bumpAttempt(dependencies.database, operation.id, step);
      break;
    }
  }
  return getOperation(dependencies.database, operation.id);
}

/**
 * One reconcile tick: heartbeat poll, auto-failover detection, and one
 * nudge of the in-flight operation. Safe to run concurrently: every
 * write is a guarded compare-and-swap, so racing ticks cannot double
 * apply a transition. No DB transaction spans a supervisor call.
 */
export async function reconcileFleet(
  dependencies: ReconcilerDependencies,
  fleetReference: string,
): Promise<ReconcileResult | null> {
  const initial = await getFleetSnapshot(dependencies.database, fleetReference);
  if (!initial) {
    return null;
  }

  await pollHeartbeats(dependencies, initial);

  // Reload: heartbeat handling may have moved domain states.
  const fleet = await getFleetSnapshot(dependencies.database, initial.id);
  if (!fleet) {
    return null;
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
