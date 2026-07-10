import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TrainingRun,
  type ChildHandle,
  type SpawnFunction,
} from "./training.js";

interface FakeChild extends ChildHandle {
  signals: NodeJS.Signals[];
  exit: () => void;
  /** Spawn failure: fires the 'error' listener, never 'exit'. */
  fail: () => void;
}

function fakeChild(pid: number): FakeChild {
  // Per-event listeners: TrainingRun registers BOTH 'exit' and
  // 'error', so a single slot would silently overwrite the first and
  // mask a regression where the two handlers diverge.
  const listeners = new Map<"exit" | "error", () => void>();
  const child: FakeChild = {
    pid,
    signals: [],
    kill(signal) {
      child.signals.push(signal);
      return true;
    },
    once(event, listener) {
      listeners.set(event, listener);
    },
    exit() {
      listeners.get("exit")?.();
    },
    fail() {
      listeners.get("error")?.();
    },
  };
  return child;
}

let children: FakeChild[];
let spawnFunction: SpawnFunction;
let spawnedWith: { command: readonly string[]; checkpointDir: string }[];

beforeEach(() => {
  vi.useFakeTimers();
  children = [];
  spawnedWith = [];
  let pid = 100;
  spawnFunction = (command, options) => {
    spawnedWith.push({ command, checkpointDir: options.checkpointDir });
    pid += 1;
    const child = fakeChild(pid);
    children.push(child);
    return child;
  };
});

afterEach(() => {
  vi.useRealTimers();
});

function run(): TrainingRun {
  return new TrainingRun(
    ["python", "train.py", "--resume"],
    "/checkpoints/run",
    spawnFunction,
  );
}

describe("TrainingRun", () => {
  it("starts once and is idempotent while running", () => {
    const training = run();
    expect(training.state).toBe("idle");
    expect(training.start()).toBe("running");
    expect(training.start()).toBe("running");
    expect(children).toHaveLength(1);
    expect(spawnedWith[0]).toEqual({
      command: ["python", "train.py", "--resume"],
      checkpointDir: "/checkpoints/run",
    });
    expect(training.pids).toEqual([101]);
  });

  it("stop sends SIGTERM, then SIGKILL after the grace period", () => {
    const training = run();
    training.start();
    expect(training.stop(30_000)).toBe("stopping");
    expect(children[0]?.signals).toEqual(["SIGTERM"]);

    // Inside the grace window: no SIGKILL yet.
    vi.advanceTimersByTime(29_999);
    expect(children[0]?.signals).toEqual(["SIGTERM"]);

    // Grace expired: escalate. Failover never waits for a perfect
    // checkpoint.
    vi.advanceTimersByTime(1);
    expect(children[0]?.signals).toEqual(["SIGTERM", "SIGKILL"]);

    children[0]?.exit();
    expect(training.state).toBe("idle");
    expect(training.pids).toEqual([]);
  });

  it("a graceful exit inside the window cancels the SIGKILL timer", () => {
    const training = run();
    training.start();
    training.stop(30_000);
    children[0]?.exit();
    expect(training.state).toBe("idle");
    vi.advanceTimersByTime(60_000);
    expect(children[0]?.signals).toEqual(["SIGTERM"]);
  });

  it("a spawn failure ('error', no 'exit') drops the run back to idle", () => {
    const training = run();
    training.start();
    expect(training.state).toBe("running");
    children[0]?.fail();
    expect(training.state).toBe("idle");
    // The run stays restartable after the failure.
    expect(training.start()).toBe("running");
    expect(children).toHaveLength(2);
  });

  it("stop is idempotent when idle and while stopping", () => {
    const training = run();
    expect(training.stop(1000)).toBe("idle");
    training.start();
    training.stop(1000);
    expect(training.stop(1000)).toBe("stopping");
    expect(children[0]?.signals).toEqual(["SIGTERM"]);
  });

  it("can restart after a stop (checkpoint/resume oriented)", () => {
    const training = run();
    training.start();
    training.stop(1000);
    children[0]?.exit();
    expect(training.start()).toBe("running");
    expect(children).toHaveLength(2);
  });
});
