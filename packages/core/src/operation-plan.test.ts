import { fleetPolicySchema } from "@haru/protocol";
import { describe, expect, it } from "vitest";

import {
  DEMOTE_STEPS,
  firstStep,
  isBestEffortStep,
  nextStep,
  PROMOTE_STEPS,
  stepsFor,
  stepTimeoutMs,
} from "./operation-plan.js";

describe("operation plan", () => {
  it("promote steps are ordered with switch_active as the commit point", () => {
    expect(PROMOTE_STEPS).toEqual([
      "stop_training",
      "verify_gpu",
      "wake_vllm",
      "probe",
      "switch_active",
      "demote_old_sleep",
      "demote_old_train",
    ]);
    expect(
      PROMOTE_STEPS.indexOf("probe") < PROMOTE_STEPS.indexOf("switch_active"),
    ).toBe(true);
  });

  it("demote steps sleep first, then start training", () => {
    expect(DEMOTE_STEPS).toEqual(["sleep_vllm", "start_training"]);
  });

  it("firstStep and nextStep walk the sequence to null", () => {
    expect(firstStep("promote")).toBe("stop_training");
    expect(firstStep("demote")).toBe("sleep_vllm");
    let step = firstStep("promote");
    const walked = [step];
    for (;;) {
      const next = nextStep("promote", step);
      if (next === null) break;
      walked.push(next);
      step = next;
    }
    expect(walked).toEqual([...PROMOTE_STEPS]);
    expect(nextStep("demote", "start_training")).toBeNull();
  });

  it("nextStep rejects a step from the wrong operation kind", () => {
    expect(() => nextStep("demote", "wake_vllm")).toThrow();
  });

  it("resolves a timeout for every step of both plans", () => {
    const policy = fleetPolicySchema.parse({});
    for (const kind of ["promote", "demote"] as const) {
      for (const step of stepsFor(kind)) {
        expect(stepTimeoutMs(policy, step)).toBeGreaterThan(0);
      }
    }
    expect(stepTimeoutMs(policy, "wake_vllm")).toBe(policy.wakeTimeoutMs);
    expect(stepTimeoutMs(policy, "stop_training")).toBe(
      policy.stopTrainingTimeoutMs,
    );
  });

  it("only the post-commit cleanup steps are best-effort", () => {
    const bestEffort = [...PROMOTE_STEPS, ...DEMOTE_STEPS].filter((s) =>
      isBestEffortStep(s),
    );
    expect(bestEffort).toEqual(["demote_old_sleep", "demote_old_train"]);
  });
});
