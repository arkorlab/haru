import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyFleetLayout } from "./repo/layout.js";
import {
  advanceStep,
  claimOperation,
  completeOperation,
  createOperation,
  failOperation,
  getInFlightOperation,
  getOperation,
  toOperationSnapshot,
} from "./repo/operations.js";
import { getFleetSnapshot } from "./repo/snapshots.js";
import { createTestDatabase, loadExampleFleetLayout } from "./testing/index.js";

import type { HaruDatabase } from "./client.js";
import type { FleetSnapshot } from "@haru/protocol";

let database: HaruDatabase;
let close: () => Promise<void>;
let fleet: FleetSnapshot;

beforeEach(async () => {
  ({ db: database, close } = await createTestDatabase());
  await applyFleetLayout(database, loadExampleFleetLayout());
  const snapshot = await getFleetSnapshot(database, "default");
  if (!snapshot) throw new Error("seed failed");
  fleet = snapshot;
});

afterEach(async () => {
  await close();
});

const beta = () => fleet.domains.find((d) => d.slug === "beta")!;

describe("createOperation", () => {
  it("creates a pending operation", async () => {
    const result = await createOperation(database, {
      fleetId: fleet.id,
      kind: "promote",
      targetDomainId: beta().id,
    });
    expect(result.created).toBe(true);
    expect(result.operation.state).toBe("pending");
    expect(result.operation.currentStep).toBeNull();
  });

  it("joins the in-flight operation instead of duplicating", async () => {
    const first = await createOperation(database, {
      fleetId: fleet.id,
      kind: "promote",
      targetDomainId: beta().id,
    });
    const second = await createOperation(database, {
      fleetId: fleet.id,
      kind: "promote",
      targetDomainId: beta().id,
    });
    expect(second.created).toBe(false);
    expect(second.operation.id).toBe(first.operation.id);
  });

  it("concurrent creates yield exactly one winner", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        createOperation(database, {
          fleetId: fleet.id,
          kind: "promote",
          targetDomainId: beta().id,
        }),
      ),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const ids = new Set(results.map((r) => r.operation.id));
    expect(ids.size).toBe(1);
  });

  it("allows a new operation once the previous one finished", async () => {
    const first = await createOperation(database, {
      fleetId: fleet.id,
      kind: "promote",
      targetDomainId: beta().id,
    });
    await claimOperation(database, first.operation.id, "stop_training");
    await failOperation(database, first.operation.id, {
      step: "stop_training",
      code: "test",
      message: "boom",
    });
    const second = await createOperation(database, {
      fleetId: fleet.id,
      kind: "demote",
      targetDomainId: beta().id,
    });
    expect(second.created).toBe(true);
    expect(second.operation.id).not.toBe(first.operation.id);
  });
});

describe("operation lifecycle CAS", () => {
  it("claim moves pending -> running once", async () => {
    const { operation } = await createOperation(database, {
      fleetId: fleet.id,
      kind: "promote",
      targetDomainId: beta().id,
    });
    // The winning claim returns the full claimed row (no re-read).
    const claimed = await claimOperation(
      database,
      operation.id,
      "stop_training",
    );
    expect(claimed?.state).toBe("running");
    expect(claimed?.currentStep).toBe("stop_training");
    expect(claimed?.stepStartedAt).not.toBeNull();
    expect(
      await claimOperation(database, operation.id, "stop_training"),
    ).toBeNull();
  });

  it("advanceStep races produce exactly one winner", async () => {
    const { operation } = await createOperation(database, {
      fleetId: fleet.id,
      kind: "promote",
      targetDomainId: beta().id,
    });
    await claimOperation(database, operation.id, "stop_training");
    const [a, b] = await Promise.all([
      advanceStep(database, operation.id, "stop_training", "verify_gpu"),
      advanceStep(database, operation.id, "stop_training", "verify_gpu"),
    ]);
    const winners = [a, b].filter((row) => row !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.currentStep).toBe("verify_gpu");
    const row = await getOperation(database, operation.id);
    expect(row?.currentStep).toBe("verify_gpu");
  });

  it("complete requires the expected final step", async () => {
    const { operation } = await createOperation(database, {
      fleetId: fleet.id,
      kind: "demote",
      targetDomainId: beta().id,
    });
    await claimOperation(database, operation.id, "sleep_vllm");
    expect(
      await completeOperation(database, operation.id, "start_training"),
    ).toBeNull();
    await advanceStep(database, operation.id, "sleep_vllm", "start_training");
    expect(
      (await completeOperation(database, operation.id, "start_training"))
        ?.state,
    ).toBe("succeeded");
    const row = await getOperation(database, operation.id);
    expect(row?.state).toBe("succeeded");
    expect(row?.finishedAt).not.toBeNull();
    expect(await getInFlightOperation(database, fleet.id)).toBeNull();
  });

  it("failOperation records a structured error", async () => {
    const { operation } = await createOperation(database, {
      fleetId: fleet.id,
      kind: "promote",
      targetDomainId: beta().id,
    });
    await claimOperation(database, operation.id, "stop_training");
    expect(
      (
        await failOperation(database, operation.id, {
          step: "stop_training",
          code: "timeout",
          message: "training did not stop in time",
        })
      )?.state,
    ).toBe("failed");
    const row = await getOperation(database, operation.id);
    expect(row?.state).toBe("failed");
    expect(row?.error?.code).toBe("timeout");
    // Failing an already-finished operation is a no-op.
    expect(
      await failOperation(database, operation.id, {
        step: null,
        code: "again",
        message: "no",
      }),
    ).toBeNull();
  });

  it("failOperation with a step guard no-ops when the step already advanced", async () => {
    const { operation } = await createOperation(database, {
      fleetId: fleet.id,
      kind: "promote",
      targetDomainId: beta().id,
    });
    await claimOperation(database, operation.id, "stop_training");
    await advanceStep(database, operation.id, "stop_training", "verify_gpu");
    // A tick that still believes the operation is on stop_training
    // (e.g. it raced a faster tick) must not be able to fail it.
    expect(
      await failOperation(
        database,
        operation.id,
        { step: "stop_training", code: "step_timeout", message: "stale" },
        "stop_training",
      ),
    ).toBeNull();
    expect((await getOperation(database, operation.id))?.state).toBe("running");
    // The tick that holds the real current step can.
    expect(
      await failOperation(
        database,
        operation.id,
        { step: "verify_gpu", code: "boom", message: "real" },
        "verify_gpu",
      ),
    ).not.toBeNull();
  });

  it("toOperationSnapshot round-trips through the protocol schema", async () => {
    const { operation } = await createOperation(database, {
      fleetId: fleet.id,
      kind: "promote",
      targetDomainId: beta().id,
    });
    const snapshot = toOperationSnapshot(operation);
    expect(snapshot.state).toBe("pending");
    expect(snapshot.createdAt).toMatch(/T.*Z$/);
  });
});
