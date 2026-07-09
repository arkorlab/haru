import { InvalidTransitionError } from "./domain-state.js";

import type { SlotKind, SlotState } from "@haru/protocol";

/**
 * Slot state machines, gated by slot kind.
 *
 * Inference: starting -> serving -> sleeping -> waking -> probing ->
 * serving. Sleeping is the standby posture (vLLM level 1 sleep);
 * waking/probing are the promotion path back to serving.
 *
 * Training: idle -> training -> stopping -> idle. Stopping covers the
 * SIGTERM grace window and the SIGKILL escalation; it resolves to idle
 * once the processes exited and VRAM is released.
 */
const INFERENCE_TRANSITIONS: Partial<Record<SlotState, readonly SlotState[]>> =
  {
    starting: ["serving", "failed", "stopped"],
    serving: ["sleeping", "failed", "stopped"],
    sleeping: ["waking", "failed", "stopped"],
    waking: ["probing", "failed", "stopped"],
    probing: ["serving", "failed", "stopped"],
    failed: ["starting", "stopped"],
    stopped: ["starting"],
  };

const TRAINING_TRANSITIONS: Partial<Record<SlotState, readonly SlotState[]>> = {
  idle: ["training", "failed", "stopped"],
  training: ["stopping", "failed", "stopped"],
  stopping: ["idle", "failed", "stopped"],
  failed: ["idle", "stopped"],
  stopped: ["idle"],
};

const TABLES: Record<
  SlotKind,
  Partial<Record<SlotState, readonly SlotState[]>>
> = {
  inference: INFERENCE_TRANSITIONS,
  training: TRAINING_TRANSITIONS,
};

/** Every state that is meaningful for the given slot kind. */
export function validSlotStates(kind: SlotKind): readonly SlotState[] {
  return Object.keys(TABLES[kind]) as SlotState[];
}

export function isValidSlotState(kind: SlotKind, state: SlotState): boolean {
  return TABLES[kind][state] !== undefined;
}

export function canTransitionSlot(
  kind: SlotKind,
  from: SlotState,
  to: SlotState,
): boolean {
  return TABLES[kind][from]?.includes(to) ?? false;
}

export function assertSlotTransition(
  kind: SlotKind,
  from: SlotState,
  to: SlotState,
): void {
  if (!canTransitionSlot(kind, from, to)) {
    throw new InvalidTransitionError(`${kind} slot`, from, to);
  }
}
