import { statesWithEdgeTo } from "@haru/core";
import {
  getFleetSnapshot,
  switchActive as switchActivePointer,
  transitionDomainSlots,
} from "@haru/db";

import {
  isSupervisorAuthError,
  SupervisorError,
  supervisorClient,
} from "../supervisor-client.js";

import type { SupervisorClientOptions } from "../supervisor-client.js";
import type { HaruDatabase, OperationRow } from "@haru/db";
import type {
  DomainSnapshot,
  FleetSnapshot,
  OperationStep,
  SlotState,
} from "@haru/protocol";

/**
 * Fraction of a GPU's memory that may still be in use after training
 * stopped for verify_gpu to pass. vLLM level 1 sleep keeps the CUDA
 * context (a few hundred MiB) plus the sleeping server processes
 * resident, so zero usage is never observable.
 */
const GPU_FREE_THRESHOLD_RATIO = 0.25;

/**
 * Per-call timeout for one nudge-style supervisor HTTP request inside
 * a step. Long operations (wake, probe) are NOT bounded by this: wake
 * converges via status polls, and the probe call gets the policy's
 * probe budget (its result only arrives in the response body, so
 * aborting early would discard a successful probe).
 */
const STEP_CALL_TIMEOUT_MS = 10_000;

export interface StepContext {
  database: HaruDatabase;
  fetchFn: typeof fetch;
  now: () => Date;
  /** Snapshot loaded at the start of the reconcile tick. */
  fleet: FleetSnapshot;
  operation: OperationRow;
  supervisorToken: string | undefined;
  /** Called after a winning switch_active CAS (cache invalidation). */
  onRouteChange?: (fleetId: string) => void;
}

export type StepOutcome =
  | { status: "done" }
  | { status: "pending" }
  | { status: "failed"; code: string; message: string };

const DONE: StepOutcome = { status: "done" };
const PENDING: StepOutcome = { status: "pending" };

function targetDomain(context: StepContext): DomainSnapshot | undefined {
  return context.fleet.domains.find(
    (d) => d.id === context.operation.targetDomainId,
  );
}

/**
 * The domain a promote's post-commit cleanup steps act on: the active
 * pointer recorded when the operation was created. The first-non-target
 * fallback only covers legacy rows without a source pointer (and is
 * only unambiguous in two-domain fleets).
 */
function sourceDomain(context: StepContext): DomainSnapshot | undefined {
  const sourceId = context.operation.sourceDomainId;
  if (sourceId !== null) {
    return context.fleet.domains.find((d) => d.id === sourceId);
  }
  return context.fleet.domains.find(
    (d) => d.id !== context.operation.targetDomainId,
  );
}

function failed(code: string, message: string): StepOutcome {
  return { status: "failed", code, message };
}

/**
 * Map a supervisor call failure onto a step outcome. Transient
 * failures (network, timeout, drifted schema) stay PENDING and are
 * retried until the step budget expires; 401/403 are permanent
 * configuration errors and fail immediately with a cause that points
 * at the token, not at a timeout.
 */
function supervisorFailure(error: unknown): StepOutcome {
  if (isSupervisorAuthError(error)) {
    return failed(
      "supervisor_unauthorized",
      `supervisor rejected the token: ${(error as SupervisorError).message}`,
    );
  }
  if (error instanceof SupervisorError) {
    return PENDING;
  }
  throw error;
}

interface WithSupervisorConfig {
  /**
   * target: the domain being promoted/demoted; a missing domain or
   * supervisor URL fails the step. source: best-effort post-commit
   * cleanup on the old active; anything missing or failing (auth
   * included: the old active may be torn down) resolves via the
   * best-effort timeout instead of failing the operation.
   */
  role: "target" | "source";
  /** Overrides the per-nudge client timeout (probe budget). */
  timeoutMs?: number;
  /** Early DONE before a supervisor URL is even required. */
  isNoop?: (domain: DomainSnapshot) => boolean;
}

/**
 * Shared executor preamble: resolve the step's domain, build the
 * supervisor client options, and map call failures per role. Executors
 * are just bodies.
 */
async function withSupervisor(
  context: StepContext,
  config: WithSupervisorConfig,
  body: (
    domain: DomainSnapshot,
    options: SupervisorClientOptions,
  ) => Promise<StepOutcome>,
): Promise<StepOutcome> {
  const domain =
    config.role === "target" ? targetDomain(context) : sourceDomain(context);
  if (!domain) {
    return config.role === "target"
      ? failed("domain_missing", "target domain not found in fleet")
      : DONE;
  }
  if (config.isNoop?.(domain)) {
    return DONE;
  }
  if (domain.supervisorUrl === null) {
    return config.role === "target"
      ? failed("no_supervisor", `domain ${domain.slug} has no supervisor URL`)
      : DONE;
  }
  const options: SupervisorClientOptions = {
    fetchFn: context.fetchFn,
    baseUrl: domain.supervisorUrl,
    token: context.supervisorToken,
    timeoutMs: config.timeoutMs ?? STEP_CALL_TIMEOUT_MS,
  };
  try {
    return await body(domain, options);
  } catch (error) {
    if (config.role === "source") {
      if (error instanceof SupervisorError) {
        return PENDING;
      }
      throw error;
    }
    return supervisorFailure(error);
  }
}

const hasNoTrainingSlots = (domain: DomainSnapshot): boolean =>
  domain.slots.every((s) => s.kind !== "training");

/** Whether any slot of the kind sits in one of the given states, per
 * the tick's snapshot. Skips 0-row mirror UPDATEs on retry nudges. */
function hasSlotIn(
  domain: DomainSnapshot,
  kind: "inference" | "training",
  states: readonly SlotState[],
): boolean {
  return domain.slots.some((s) => s.kind === kind && states.includes(s.state));
}

async function stopTraining(context: StepContext): Promise<StepOutcome> {
  return withSupervisor(
    context,
    { role: "target", isNoop: hasNoTrainingSlots },
    async (domain, options) => {
      // Mirror intent in the DB first; guarded by the snapshot so
      // retry nudges do not re-issue a 0-row UPDATE every tick.
      const stoppable = statesWithEdgeTo("training", "stopping");
      if (hasSlotIn(domain, "training", stoppable)) {
        await transitionDomainSlots(
          context.database,
          domain.id,
          "training",
          stoppable,
          "stopping",
        );
      }
      // Idempotent on the supervisor side: stopping stopped training is
      // a no-op. Checkpointing is best-effort inside the grace window;
      // the supervisor escalates SIGTERM -> SIGKILL itself.
      await supervisorClient.stopTraining(
        options,
        context.fleet.policy.trainingStopGraceMs,
      );
      const status = await supervisorClient.status(options);
      const trainingSlots = status.slots.filter((s) => s.kind === "training");
      // Guard the vacuous case: the fleet layout says this domain HAS
      // training slots, so a supervisor reporting none is config drift,
      // not success. Stay pending until the step budget surfaces it.
      const isAllIdle =
        trainingSlots.length > 0 &&
        trainingSlots.every((s) => s.training?.state === "idle");
      if (!isAllIdle) {
        return PENDING;
      }
      // Deliberately narrower than the table's full predecessor set of
      // idle: failed/stopped slots are not proven idle by this stop.
      await transitionDomainSlots(
        context.database,
        domain.id,
        "training",
        ["stopping", "training"],
        "idle",
      );
      return DONE;
    },
  );
}

async function verifyGpu(context: StepContext): Promise<StepOutcome> {
  return withSupervisor(context, { role: "target" }, async (_, options) => {
    const memory = await supervisorClient.gpuMemory(options);
    const isReleased =
      memory.gpus.length > 0 &&
      memory.gpus.every(
        (gpu) => gpu.usedMiB / gpu.totalMiB <= GPU_FREE_THRESHOLD_RATIO,
      );
    return isReleased ? DONE : PENDING;
  });
}

async function wakeVllm(context: StepContext): Promise<StepOutcome> {
  return withSupervisor(
    context,
    { role: "target" },
    async (domain, options) => {
      const wakeable = statesWithEdgeTo("inference", "waking");
      if (hasSlotIn(domain, "inference", wakeable)) {
        await transitionDomainSlots(
          context.database,
          domain.id,
          "inference",
          wakeable,
          "waking",
        );
      }
      // Idempotent: waking an awake vLLM is a no-op on the supervisor.
      // The wake call itself may exceed the client timeout for large
      // models; that is fine because completion is observed via the
      // status poll below on later nudges.
      await supervisorClient.wake(options);
      const status = await supervisorClient.status(options);
      const models = status.slots
        .filter((s) => s.kind === "inference")
        .flatMap((s) => s.models ?? []);
      const isAllAwake =
        models.length > 0 && models.every((m) => m.sleeping === false);
      if (!isAllAwake) {
        return PENDING;
      }
      await transitionDomainSlots(
        context.database,
        domain.id,
        "inference",
        statesWithEdgeTo("inference", "probing"),
        "probing",
      );
      return DONE;
    },
  );
}

async function probe(context: StepContext): Promise<StepOutcome> {
  // The probe endpoint is synchronous (it runs real completions), so
  // its client timeout must cover the whole probe budget: aborting at
  // the nudge timeout would discard a slow-but-successful probe and
  // re-queue a fresh completion on the cold GPU every tick.
  return withSupervisor(
    context,
    { role: "target", timeoutMs: context.fleet.policy.probeTimeoutMs },
    async (domain, options) => {
      // Every model binding the fleet layout routes to this domain must
      // be proven, not just the models the supervisor happens to be
      // configured with: a drifted supervisor probing a subset must not
      // let switch_active route traffic to an unprobed (or absent)
      // model.
      const expectedModels = new Set(
        domain.slots.flatMap((slot) =>
          slot.spec.kind === "inference"
            ? slot.spec.models.map((m) => m.name)
            : [],
        ),
      );
      if (expectedModels.size === 0) {
        return failed(
          "probe_failed",
          "target domain has no inference model bindings to probe",
        );
      }
      const result = await supervisorClient.probe(
        options,
        context.fleet.policy.probe.prompt,
        context.fleet.policy.probe.maxTokens,
        context.fleet.policy.probeTimeoutMs,
      );
      const okModels = new Set(
        result.results.filter((r) => r.ok).map((r) => r.model),
      );
      const missing = [...expectedModels.difference(okModels)];
      if (!result.ok || missing.length > 0) {
        const failures = [
          ...result.results
            .filter((r) => !r.ok)
            .map((r) => `${r.model}: ${r.error ?? "failed"}`),
          ...(missing.length > 0
            ? [
                `not probed by the supervisor (config drift?): ${missing.join(", ")}`,
              ]
            : []),
        ].join("; ");
        // Routing safety: the fleet pointer has not moved yet, so a
        // failed probe leaves the old active domain serving traffic.
        return failed(
          "probe_failed",
          `synthetic inference failed: ${failures}`,
        );
      }
      // Narrower than the table's predecessors of serving: only slots
      // this promotion drove through the wake path were just probed.
      await transitionDomainSlots(
        context.database,
        domain.id,
        "inference",
        ["probing"],
        "serving",
      );
      return DONE;
    },
  );
}

async function switchActive(context: StepContext): Promise<StepOutcome> {
  // Idempotent re-run: a crash between the CAS and the step advance
  // leaves the pointer already moved.
  if (context.fleet.activeDomainId === context.operation.targetDomainId) {
    return DONE;
  }
  const result = await switchActivePointer(
    context.database,
    context.fleet.id,
    context.fleet.activeDomainId,
    context.operation.targetDomainId,
    // The CAS also requires this operation to still be running, so a
    // tick that raced a concurrent timeout-failure cannot flip routing
    // for an operation already recorded as failed.
    context.operation.id,
  );
  if (result === null) {
    // CAS lost. A concurrent reconcile tick executing this same
    // operation may have already moved the pointer to our target;
    // re-read before declaring failure so racing ticks converge on
    // done instead of failing a promotion that actually landed.
    const fresh = await getFleetSnapshot(context.database, context.fleet.id);
    if (fresh?.activeDomainId === context.operation.targetDomainId) {
      context.onRouteChange?.(context.fleet.id);
      return DONE;
    }
    return failed(
      "cas_lost",
      "active pointer moved concurrently; refusing to overwrite",
    );
  }
  context.onRouteChange?.(context.fleet.id);
  return DONE;
}

async function demoteOldSleep(context: StepContext): Promise<StepOutcome> {
  return withSupervisor(
    context,
    { role: "source" },
    async (domain, options) => {
      // Level 1 sleep: weights offload to CPU RAM, KV cache dropped.
      await supervisorClient.sleep(options);
      await transitionDomainSlots(
        context.database,
        domain.id,
        "inference",
        statesWithEdgeTo("inference", "sleeping"),
        "sleeping",
      );
      return DONE;
    },
  );
}

async function demoteOldTrain(context: StepContext): Promise<StepOutcome> {
  return withSupervisor(
    context,
    { role: "source", isNoop: hasNoTrainingSlots },
    async (domain, options) => {
      await supervisorClient.startTraining(options);
      await transitionDomainSlots(
        context.database,
        domain.id,
        "training",
        statesWithEdgeTo("training", "training"),
        "training",
      );
      return DONE;
    },
  );
}

async function sleepVllm(context: StepContext): Promise<StepOutcome> {
  return withSupervisor(
    context,
    { role: "target" },
    async (domain, options) => {
      await supervisorClient.sleep(options);
      const status = await supervisorClient.status(options);
      const models = status.slots
        .filter((s) => s.kind === "inference")
        .flatMap((s) => s.models ?? []);
      // Same vacuous-truth guard as wake: a supervisor reporting zero
      // models cannot prove anything went to sleep.
      const isAllAsleep =
        models.length > 0 && models.every((m) => m.sleeping === true);
      if (!isAllAsleep) {
        return PENDING;
      }
      // Narrower than the table's predecessors of sleeping: a starting
      // slot belongs to provisioning, which this demote did not verify.
      await transitionDomainSlots(
        context.database,
        domain.id,
        "inference",
        ["serving", "probing", "waking"],
        "sleeping",
      );
      return DONE;
    },
  );
}

async function startTraining(context: StepContext): Promise<StepOutcome> {
  return withSupervisor(
    context,
    { role: "target", isNoop: hasNoTrainingSlots },
    async (domain, options) => {
      await supervisorClient.startTraining(options);
      // /v1/training/start returns before the child process proves
      // healthy (a spawn failure drops the run back to idle via its
      // error handler), so completion is what the status poll reports,
      // not the 200 on the start call. Same vacuous-truth guard as
      // stop_training: zero reported training slots is config drift.
      const status = await supervisorClient.status(options);
      const trainingSlots = status.slots.filter((s) => s.kind === "training");
      const isAllRunning =
        trainingSlots.length > 0 &&
        trainingSlots.every((s) => s.training?.state === "running");
      if (!isAllRunning) {
        return PENDING;
      }
      // Narrower than the table's predecessors of training: a stopping
      // slot mid-cleanup was not proven restarted by this demote step.
      await transitionDomainSlots(
        context.database,
        domain.id,
        "training",
        ["idle"],
        "training",
      );
      return DONE;
    },
  );
}

const EXECUTORS: Record<
  OperationStep,
  (context: StepContext) => Promise<StepOutcome>
> = {
  stop_training: stopTraining,
  verify_gpu: verifyGpu,
  wake_vllm: wakeVllm,
  probe,
  switch_active: switchActive,
  demote_old_sleep: demoteOldSleep,
  demote_old_train: demoteOldTrain,
  sleep_vllm: sleepVllm,
  start_training: startTraining,
};

/** Run one re-entrant nudge of the given step. */
export async function executeStep(
  context: StepContext,
  step: OperationStep,
): Promise<StepOutcome> {
  return EXECUTORS[step](context);
}
