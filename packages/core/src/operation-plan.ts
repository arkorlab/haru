import {
  demoteStepSchema,
  promoteStepSchema,
  type FleetPolicy,
  type OperationKind,
  type OperationStep,
} from "@haru/protocol";

/** Ordered promote steps (zod enum options preserve declaration order). */
export const PROMOTE_STEPS: readonly OperationStep[] =
  promoteStepSchema.options;

/** Ordered demote steps. */
export const DEMOTE_STEPS: readonly OperationStep[] = demoteStepSchema.options;

export function stepsFor(kind: OperationKind): readonly OperationStep[] {
  return kind === "promote" ? PROMOTE_STEPS : DEMOTE_STEPS;
}

export function firstStep(kind: OperationKind): OperationStep {
  const step = stepsFor(kind)[0];
  if (step === undefined) {
    throw new Error(`operation kind ${kind} has no steps`);
  }
  return step;
}

/** Next step after `current`, or null when `current` is the last one. */
export function nextStep(
  kind: OperationKind,
  current: OperationStep,
): OperationStep | null {
  const steps = stepsFor(kind);
  const index = steps.indexOf(current);
  if (index === -1) {
    throw new Error(`step ${current} is not part of a ${kind} operation`);
  }
  return steps[index + 1] ?? null;
}

/** Per-step timeout, resolved from the fleet policy. */
export function stepTimeoutMs(
  policy: FleetPolicy,
  step: OperationStep,
): number {
  switch (step) {
    case "stop_training":
      return policy.stopTrainingTimeoutMs;
    case "verify_gpu":
      return policy.verifyGpuTimeoutMs;
    case "wake_vllm":
      return policy.wakeTimeoutMs;
    case "probe":
      return policy.probeTimeoutMs;
    case "switch_active":
      return policy.switchActiveTimeoutMs;
    case "demote_old_sleep":
    case "sleep_vllm":
      return policy.sleepTimeoutMs;
    case "demote_old_train":
    case "start_training":
      return policy.startTrainingTimeoutMs;
  }
}

/**
 * Best-effort steps run after the routing commit point
 * (`switch_active`). Their failure degrades the old active domain but
 * never fails the operation: the old active being unhealthy is
 * typically the very reason the failover happened.
 */
export function isBestEffortStep(step: OperationStep): boolean {
  return step === "demote_old_sleep" || step === "demote_old_train";
}
