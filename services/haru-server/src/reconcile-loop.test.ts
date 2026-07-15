import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startReconcileLoop } from "./reconcile-loop.js";

import type { ReconcilerDependencies } from "./reconciler/reconciler.js";

// The loop injects `reconcile`, so the dependencies are an opaque
// pass-through here; a stub keeps the signature honest.
const dependencies = {
  database: {},
  fetchFn: fetch,
  now: () => new Date(),
  supervisorToken: undefined,
} as unknown as ReconcilerDependencies;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startReconcileLoop", () => {
  it("reconciles every fleet concurrently within a tick (no head-of-line blocking)", async () => {
    const calls: string[] = [];
    const { promise: slow, resolve: releaseSlow } =
      Promise.withResolvers<undefined>();
    const stop = startReconcileLoop(dependencies, {
      fleetReferences: ["slow", "fast"],
      intervalMs: 1000,
      reconcile: (_dependencies, reference) => {
        calls.push(reference);
        return reference === "slow" ? slow : Promise.resolve();
      },
      onError: () => undefined,
    });

    await vi.advanceTimersByTimeAsync(1000);
    // Both invoked in one tick; "fast" ran while "slow" is still pending.
    expect(calls).toEqual(["slow", "fast"]);

    releaseSlow(undefined);
    await vi.advanceTimersByTimeAsync(0);
    stop();
  });

  it("a hung fleet blocks only itself, never a healthy sibling (per-fleet guard)", async () => {
    const calls: string[] = [];
    const stop = startReconcileLoop(dependencies, {
      fleetReferences: ["stuck", "ok"],
      intervalMs: 1000,
      reconcile: (_dependencies, reference) => {
        calls.push(reference);
        // "stuck" never settles; a shared mutex would let it throttle
        // "ok" too.
        return reference === "stuck"
          ? new Promise<never>(() => undefined)
          : Promise.resolve();
      },
      onError: () => undefined,
    });

    await vi.advanceTimersByTimeAsync(3000);
    // "ok" reconciled once PER interval; "stuck" only once (still in flight).
    expect(calls.filter((r) => r === "ok").length).toBe(3);
    expect(calls.filter((r) => r === "stuck").length).toBe(1);

    stop();
  });

  it("never overlaps a fleet with itself while its reconcile is still in flight", async () => {
    const calls: string[] = [];
    const gates: ((value: undefined) => void)[] = [];
    const stop = startReconcileLoop(dependencies, {
      fleetReferences: ["slow"],
      intervalMs: 1000,
      reconcile: (_dependencies, reference) => {
        calls.push(reference);
        const { promise, resolve } = Promise.withResolvers<undefined>();
        gates.push(resolve);
        return promise;
      },
      onError: () => undefined,
    });

    // The guard is held until the WORK settles (not a timer): across
    // three intervals the still-pending reconcile is never restarted, so
    // a fleet cannot double-issue supervisor calls.
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls).toEqual(["slow"]);

    // Once it settles, the next interval starts a fresh one.
    gates[0]?.(undefined);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toEqual(["slow", "slow"]);

    stop();
  });

  it("isolates a failing fleet and keeps reconciling it and the rest, tick after tick", async () => {
    const calls: string[] = [];
    const errors: string[] = [];
    const stop = startReconcileLoop(dependencies, {
      fleetReferences: ["bad", "good"],
      intervalMs: 1000,
      reconcile: (_dependencies, reference) => {
        calls.push(reference);
        return reference === "bad"
          ? Promise.reject(new Error("boom"))
          : Promise.resolve();
      },
      onError: (reference) => {
        errors.push(reference);
      },
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toEqual(["bad", "good"]);
    expect(errors).toEqual(["bad"]);

    // A rejection frees the slot immediately: both reconcile again next tick.
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toEqual(["bad", "good", "bad", "good"]);
    expect(errors).toEqual(["bad", "bad"]);

    stop();
  });

  it("reconciles a duplicated fleet reference only once per tick", async () => {
    const calls: string[] = [];
    const stop = startReconcileLoop(dependencies, {
      fleetReferences: ["dup", "dup", "other"],
      intervalMs: 1000,
      reconcile: (_dependencies, reference) => {
        calls.push(reference);
        return Promise.resolve();
      },
      onError: () => undefined,
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toEqual(["dup", "other"]);

    stop();
  });

  it("stop() halts the loop and leaves no timers", async () => {
    const calls: string[] = [];
    const stop = startReconcileLoop(dependencies, {
      fleetReferences: ["a"],
      intervalMs: 1000,
      reconcile: (_dependencies, reference) => {
        calls.push(reference);
        return Promise.resolve();
      },
      onError: () => undefined,
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toEqual(["a"]);
    expect(vi.getTimerCount()).toBe(1); // only the interval

    stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toEqual(["a"]); // no further ticks after stop
  });
});
