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
      } else if (domain.state === "degraded" && status.ready) {
        await transitionDomain(
          dependencies.database,
          domain.id,
          ["degraded"],
          "ready",
        );
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

/** Handle a step that exceeded its policy timeout. */
async function handleStepTimeout(
  dependencies: ReconcilerDependencies,
  fleet: FleetSnapshot,
  operation: OperationRow,
  step: OperationStep,
): Promise<void> {
  if (isBestEffortStep(step)) {
    // Post-commit cleanup of the old active domain: degrade it and
    // move on. The old active being unhealthy is typically why the
    // failover happened; never fail the operation for it.
    const oldDomain = fleet.domains.find(
      (d) => d.id !== operation.targetDomainId,
    );
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
    const next = nextStep(operation.kind, step);
    await (next === null
      ? completeOperation(dependencies.database, operation.id, step)
      : advanceStep(dependencies.database, operation.id, step, next));
    return;
  }
  await failOperation(dependencies.database, operation.id, {
    step,
    code: "step_timeout",
    message: `step ${step} exceeded its timeout`,
  });
  // A failed promotion must leave the target's half-woken inference
  // slots marked failed so a later promote starts from a clean state.
  await transitionDomainSlots(
    dependencies.database,
    operation.targetDomainId,
    "inference",
    ["waking", "probing"],
    "failed",
  );
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
      await (next === null
        ? completeOperation(dependencies.database, operation.id, step)
        : advanceStep(dependencies.database, operation.id, step, next));
      await appendEvent(dependencies.database, {
        fleetId: fleet.id,
        operationId: operation.id,
        type: "operation.step.done",
        payload: { step, next },
      });
      break;
    }
    case "failed": {
      await failOperation(dependencies.database, operation.id, {
        step,
        code: outcome.code,
        message: outcome.message,
      });
      await transitionDomainSlots(
        dependencies.database,
        operation.targetDomainId,
        "inference",
        ["waking", "probing"],
        "failed",
      );
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
