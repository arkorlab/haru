import {
  switchActive as switchActivePointer,
  transitionDomainSlots,
} from "@haru/db";

import { SupervisorError, supervisorClient } from "../supervisor-client.js";

import type { SupervisorClientOptions } from "../supervisor-client.js";
import type { HaruDatabase, OperationRow } from "@haru/db";
import type {
  DomainSnapshot,
  FleetSnapshot,
  OperationStep,
} from "@haru/protocol";

/**
 * Fraction of a GPU's memory that may still be in use after training
 * stopped for verify_gpu to pass. vLLM level 1 sleep keeps the CUDA
 * context (a few hundred MiB) plus the sleeping server processes
 * resident, so zero usage is never observable.
 */
const GPU_FREE_THRESHOLD_RATIO = 0.25;

/** Per-call timeout for one supervisor HTTP request inside a step. */
const STEP_CALL_TIMEOUT_MS = 10_000;

export interface StepContext {
  database: HaruDatabase;
  fetchFn: typeof fetch;
  now: () => Date;
  /** Snapshot loaded at the start of the reconcile tick. */
  fleet: FleetSnapshot;
  operation: OperationRow;
  supervisorToken: string | undefined;
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

/** The non-target domain (two-domain slice): the old active during a
 * promote's post-commit cleanup steps. */
function otherDomain(context: StepContext): DomainSnapshot | undefined {
  return context.fleet.domains.find(
    (d) => d.id !== context.operation.targetDomainId,
  );
}

function supervisorOptions(
  context: StepContext,
  domain: DomainSnapshot,
): SupervisorClientOptions | null {
  if (domain.supervisorUrl === null) {
    return null;
  }
  return {
    fetchFn: context.fetchFn,
    baseUrl: domain.supervisorUrl,
    token: context.supervisorToken,
    timeoutMs: STEP_CALL_TIMEOUT_MS,
  };
}

function failed(code: string, message: string): StepOutcome {
  return { status: "failed", code, message };
}

async function stopTraining(context: StepContext): Promise<StepOutcome> {
  const domain = targetDomain(context);
  if (!domain) {
    return failed("domain_missing", "target domain not found in fleet");
  }
  const hasTrainingSlots = domain.slots.some((s) => s.kind === "training");
  if (!hasTrainingSlots) {
    return DONE;
  }
  const options = supervisorOptions(context, domain);
  if (!options) {
    return failed(
      "no_supervisor",
      `domain ${domain.slug} has no supervisor URL`,
    );
  }
  // Mirror intent in the DB first; idempotent (zero rows on re-run).
  await transitionDomainSlots(
    context.database,
    domain.id,
    "training",
    ["training"],
    "stopping",
  );
  try {
    // Idempotent on the supervisor side: stopping stopped training is
    // a no-op. Checkpointing is best-effort inside the grace window;
    // the supervisor escalates SIGTERM -> SIGKILL itself.
    await supervisorClient.stopTraining(
      options,
      context.fleet.policy.trainingStopGraceMs,
    );
    const status = await supervisorClient.status(options);
    const trainingSlots = status.slots.filter((s) => s.kind === "training");
    const isAllIdle = trainingSlots.every((s) => s.training?.state === "idle");
    if (!isAllIdle) {
      return PENDING;
    }
    await transitionDomainSlots(
      context.database,
      domain.id,
      "training",
      ["stopping", "training"],
      "idle",
    );
    return DONE;
  } catch (error) {
    if (error instanceof SupervisorError) {
      return PENDING;
    }
    throw error;
  }
}

async function verifyGpu(context: StepContext): Promise<StepOutcome> {
  const domain = targetDomain(context);
  if (!domain) {
    return failed("domain_missing", "target domain not found in fleet");
  }
  const options = supervisorOptions(context, domain);
  if (!options) {
    return failed(
      "no_supervisor",
      `domain ${domain.slug} has no supervisor URL`,
    );
  }
  try {
    const memory = await supervisorClient.gpuMemory(options);
    const isReleased = memory.gpus.every(
      (gpu) => gpu.usedMiB / gpu.totalMiB <= GPU_FREE_THRESHOLD_RATIO,
    );
    return isReleased ? DONE : PENDING;
  } catch (error) {
    if (error instanceof SupervisorError) {
      return PENDING;
    }
    throw error;
  }
}

async function wakeVllm(context: StepContext): Promise<StepOutcome> {
  const domain = targetDomain(context);
  if (!domain) {
    return failed("domain_missing", "target domain not found in fleet");
  }
  const options = supervisorOptions(context, domain);
  if (!options) {
    return failed(
      "no_supervisor",
      `domain ${domain.slug} has no supervisor URL`,
    );
  }
  await transitionDomainSlots(
    context.database,
    domain.id,
    "inference",
    ["sleeping", "failed"],
    "waking",
  );
  try {
    // Idempotent: waking an awake vLLM is a no-op on the supervisor.
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
      ["waking"],
      "probing",
    );
    return DONE;
  } catch (error) {
    if (error instanceof SupervisorError) {
      return PENDING;
    }
    throw error;
  }
}

async function probe(context: StepContext): Promise<StepOutcome> {
  const domain = targetDomain(context);
  if (!domain) {
    return failed("domain_missing", "target domain not found in fleet");
  }
  const options = supervisorOptions(context, domain);
  if (!options) {
    return failed(
      "no_supervisor",
      `domain ${domain.slug} has no supervisor URL`,
    );
  }
  try {
    const result = await supervisorClient.probe(
      options,
      context.fleet.policy.probe.prompt,
      context.fleet.policy.probe.maxTokens,
    );
    if (!result.ok) {
      const failures = result.results
        .filter((r) => !r.ok)
        .map((r) => `${r.model}: ${r.error ?? "failed"}`)
        .join("; ");
      // Routing safety: the fleet pointer has not moved yet, so a
      // failed probe leaves the old active domain serving traffic.
      return failed("probe_failed", `synthetic inference failed: ${failures}`);
    }
    await transitionDomainSlots(
      context.database,
      domain.id,
      "inference",
      ["probing"],
      "serving",
    );
    return DONE;
  } catch (error) {
    if (error instanceof SupervisorError) {
      return PENDING;
    }
    throw error;
  }
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
  );
  if (result === null) {
    return failed(
      "cas_lost",
      "active pointer moved concurrently; refusing to overwrite",
    );
  }
  return DONE;
}

async function demoteOldSleep(context: StepContext): Promise<StepOutcome> {
  const domain = otherDomain(context);
  if (!domain) {
    return DONE;
  }
  const options = supervisorOptions(context, domain);
  if (!options) {
    return DONE;
  }
  try {
    // Level 1 sleep: weights offload to CPU RAM, KV cache dropped.
    await supervisorClient.sleep(options);
    await transitionDomainSlots(
      context.database,
      domain.id,
      "inference",
      ["serving", "probing", "waking", "starting"],
      "sleeping",
    );
    return DONE;
  } catch (error) {
    if (error instanceof SupervisorError) {
      // Best-effort: the reconciler's timeout wrapper converts a
      // never-succeeding best-effort step into done-with-degradation.
      return PENDING;
    }
    throw error;
  }
}

async function demoteOldTrain(context: StepContext): Promise<StepOutcome> {
  const domain = otherDomain(context);
  if (!domain) {
    return DONE;
  }
  const hasTrainingSlots = domain.slots.some((s) => s.kind === "training");
  if (!hasTrainingSlots) {
    return DONE;
  }
  const options = supervisorOptions(context, domain);
  if (!options) {
    return DONE;
  }
  try {
    await supervisorClient.startTraining(options);
    await transitionDomainSlots(
      context.database,
      domain.id,
      "training",
      ["idle", "stopping"],
      "training",
    );
    return DONE;
  } catch (error) {
    if (error instanceof SupervisorError) {
      return PENDING;
    }
    throw error;
  }
}

async function sleepVllm(context: StepContext): Promise<StepOutcome> {
  const domain = targetDomain(context);
  if (!domain) {
    return failed("domain_missing", "target domain not found in fleet");
  }
  const options = supervisorOptions(context, domain);
  if (!options) {
    return failed(
      "no_supervisor",
      `domain ${domain.slug} has no supervisor URL`,
    );
  }
  try {
    await supervisorClient.sleep(options);
    const status = await supervisorClient.status(options);
    const models = status.slots
      .filter((s) => s.kind === "inference")
      .flatMap((s) => s.models ?? []);
    const isAllAsleep = models.every((m) => m.sleeping === true);
    if (!isAllAsleep) {
      return PENDING;
    }
    await transitionDomainSlots(
      context.database,
      domain.id,
      "inference",
      ["serving", "probing", "waking"],
      "sleeping",
    );
    return DONE;
  } catch (error) {
    if (error instanceof SupervisorError) {
      return PENDING;
    }
    throw error;
  }
}

async function startTraining(context: StepContext): Promise<StepOutcome> {
  const domain = targetDomain(context);
  if (!domain) {
    return failed("domain_missing", "target domain not found in fleet");
  }
  const hasTrainingSlots = domain.slots.some((s) => s.kind === "training");
  if (!hasTrainingSlots) {
    return DONE;
  }
  const options = supervisorOptions(context, domain);
  if (!options) {
    return failed(
      "no_supervisor",
      `domain ${domain.slug} has no supervisor URL`,
    );
  }
  try {
    await supervisorClient.startTraining(options);
    await transitionDomainSlots(
      context.database,
      domain.id,
      "training",
      ["idle"],
      "training",
    );
    return DONE;
  } catch (error) {
    if (error instanceof SupervisorError) {
      return PENDING;
    }
    throw error;
  }
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
