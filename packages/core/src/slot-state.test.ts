import { slotStateSchema, type SlotState } from "@haru/protocol";
import { describe, expect, it } from "vitest";

import {
  assertSlotTransition,
  canTransitionSlot,
  isValidSlotState,
  validSlotStates,
} from "./slot-state.js";

const ALL: readonly SlotState[] = slotStateSchema.options;

const INFERENCE_ALLOWED: ReadonlySet<string> = new Set([
  "starting>serving",
  "starting>failed",
  "starting>stopped",
  "serving>sleeping",
  "serving>failed",
  "serving>stopped",
  "sleeping>waking",
  "sleeping>failed",
  "sleeping>stopped",
  "waking>probing",
  "waking>failed",
  "waking>stopped",
  "probing>serving",
  "probing>failed",
  "probing>stopped",
  "failed>starting",
  "failed>stopped",
  "stopped>starting",
]);

const TRAINING_ALLOWED: ReadonlySet<string> = new Set([
  "idle>training",
  "idle>failed",
  "idle>stopped",
  "training>stopping",
  "training>failed",
  "training>stopped",
  "stopping>idle",
  "stopping>failed",
  "stopping>stopped",
  "failed>idle",
  "failed>stopped",
  "stopped>idle",
]);

describe("slot state machine", () => {
  it("inference: allows exactly the documented edges (exhaustive)", () => {
    for (const from of ALL) {
      for (const to of ALL) {
        expect(
          canTransitionSlot("inference", from, to),
          `inference ${from} -> ${to}`,
        ).toBe(INFERENCE_ALLOWED.has(`${from}>${to}`));
      }
    }
  });

  it("training: allows exactly the documented edges (exhaustive)", () => {
    for (const from of ALL) {
      for (const to of ALL) {
        expect(
          canTransitionSlot("training", from, to),
          `training ${from} -> ${to}`,
        ).toBe(TRAINING_ALLOWED.has(`${from}>${to}`));
      }
    }
  });

  it("training states are invalid for inference slots and vice versa", () => {
    expect(isValidSlotState("inference", "training")).toBe(false);
    expect(isValidSlotState("inference", "idle")).toBe(false);
    expect(isValidSlotState("training", "serving")).toBe(false);
    expect(isValidSlotState("training", "sleeping")).toBe(false);
    expect(isValidSlotState("inference", "sleeping")).toBe(true);
    expect(isValidSlotState("training", "stopping")).toBe(true);
  });

  it("shared failed/stopped states are valid for both kinds", () => {
    expect(validSlotStates("inference")).toContain("failed");
    expect(validSlotStates("inference")).toContain("stopped");
    expect(validSlotStates("training")).toContain("failed");
    expect(validSlotStates("training")).toContain("stopped");
  });

  it("assertSlotTransition throws on cross-kind edges", () => {
    expect(() => assertSlotTransition("training", "idle", "serving")).toThrow();
    expect(() =>
      assertSlotTransition("inference", "sleeping", "waking"),
    ).not.toThrow();
  });
});
