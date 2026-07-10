import { InvalidTransitionError } from "./domain-state.js";

import type { SlotKind, SlotState } from "@haru/protocol";

/**
 * Slot state machines, gated by slot kind. These tables are the single
 * source of truth: the DB repo layer asserts every compare-and-swap's
 * (from, to) pair against them, and the reconciler derives shared
 * from-lists via `statesWithEdgeTo`.
 *
 * Inference: starting -> serving -> sleeping -> waking -> probing ->
 * serving is the promotion path. Recovery/cleanup edges: failed ->
 * waking (wake retry after a failed promotion) and starting | waking |
 * probing -> sleeping (demote cleanup can catch a slot anywhere on the
 * wake path).
 *
 * Training: idle -> training -> stopping -> idle. Stopping covers the
 * SIGTERM grace window and the SIGKILL escalation. training -> idle
 * directly records a stop that completed within one nudge; stopping ->
 * training covers a demote retry restarting training mid-cleanup.
 */
const INFERENCE_TRANSITIONS: Partial<Record<SlotState, readonly SlotState[]>> =
  {
    starting: ["serving", "sleeping", "failed", "stopped"],
    serving: ["sleeping", "failed", "stopped"],
    sleeping: ["waking", "failed", "stopped"],
    waking: ["probing", "sleeping", "failed", "stopped"],
    probing: ["serving", "sleeping", "failed", "stopped"],
    // failed -> serving: heartbeat-observed recovery on the ACTIVE
    // domain (the slot's models report awake again); promotions use
    // the failed -> waking path instead.
    failed: ["serving", "waking", "starting", "stopped"],
    stopped: ["starting"],
  };

const TRAINING_TRANSITIONS: Partial<Record<SlotState, readonly SlotState[]>> = {
  idle: ["training", "failed", "stopped"],
  training: ["stopping", "idle", "failed", "stopped"],
  stopping: ["idle", "training", "failed", "stopped"],
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

/**
 * Every state with an edge into `to`: the full predecessor set. The
 * reconciler uses this to derive compare-and-swap from-lists straight
 * from the table wherever "any state that can reach X" is the intended
 * semantics; deliberately narrower from-lists stay literal at the call
 * site (and are still validated by the repo layer).
 */
export function statesWithEdgeTo(
  kind: SlotKind,
  to: SlotState,
): readonly SlotState[] {
  return (Object.entries(TABLES[kind]) as [SlotState, readonly SlotState[]][])
    .filter(([, targets]) => targets.includes(to))
    .map(([from]) => from);
}
