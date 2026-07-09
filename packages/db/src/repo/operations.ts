import {
  operationSnapshotSchema,
  type OperationError,
  type OperationKind,
  type OperationSnapshot,
  type OperationStep,
} from "@haru/protocol";
import { and, eq, inArray, sql } from "drizzle-orm";

import { operations } from "../schema/index.js";

import type { HaruDatabase } from "../client.js";

export type OperationRow = typeof operations.$inferSelect;

export function toOperationSnapshot(row: OperationRow): OperationSnapshot {
  return operationSnapshotSchema.parse({
    id: row.id,
    fleetId: row.fleetId,
    kind: row.kind,
    state: row.state,
    targetDomainId: row.targetDomainId,
    currentStep: row.currentStep,
    stepStartedAt: row.stepStartedAt?.toISOString() ?? null,
    attempt: row.attempt,
    error: row.error ?? null,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  });
}

export interface CreateOperationResult {
  /** True when this call inserted the operation (it won the race). */
  created: boolean;
  operation: OperationRow;
}

/**
 * Create an operation, or join the fleet's in-flight one. The partial
 * unique index (`one in-flight op per fleet`) turns a concurrent
 * create into a no-op insert; the loser then reads the winner's row.
 * A small retry loop covers the window where the in-flight operation
 * finishes between the failed insert and the read.
 */
export async function createOperation(
  database: HaruDatabase,
  input: {
    fleetId: string;
    kind: OperationKind;
    targetDomainId: string;
  },
): Promise<CreateOperationResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const inserted = await database
      .insert(operations)
      .values({
        fleetId: input.fleetId,
        kind: input.kind,
        targetDomainId: input.targetDomainId,
      })
      .onConflictDoNothing()
      .returning();
    const insertedRow = inserted[0];
    if (insertedRow) {
      return { created: true, operation: insertedRow };
    }
    const inflight = await getInFlightOperation(database, input.fleetId);
    if (inflight) {
      return { created: false, operation: inflight };
    }
    // The in-flight operation finished in between; retry the insert.
  }
  throw new Error(
    `could not create or join an operation for fleet ${input.fleetId}`,
  );
}

export async function getInFlightOperation(
  database: HaruDatabase,
  fleetId: string,
): Promise<OperationRow | null> {
  const rows = await database
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.fleetId, fleetId),
        inArray(operations.state, ["pending", "running"]),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function getOperation(
  database: HaruDatabase,
  operationId: string,
): Promise<OperationRow | null> {
  const rows = await database
    .select()
    .from(operations)
    .where(eq(operations.id, operationId))
    .limit(1);
  return rows[0] ?? null;
}

/** Claim a pending operation for execution (pending -> running). */
export async function claimOperation(
  database: HaruDatabase,
  operationId: string,
  firstStep: OperationStep,
): Promise<boolean> {
  const rows = await database
    .update(operations)
    .set({
      state: "running",
      currentStep: firstStep,
      stepStartedAt: sql`now()`,
      attempt: 0,
      updatedAt: sql`now()`,
    })
    .where(and(eq(operations.id, operationId), eq(operations.state, "pending")))
    .returning({ id: operations.id });
  return rows.length === 1;
}

/**
 * Advance from one step to the next. Guarded on the expected current
 * step so two reconciler ticks racing on the same operation produce
 * exactly one advancement.
 */
export async function advanceStep(
  database: HaruDatabase,
  operationId: string,
  fromStep: OperationStep,
  toStep: OperationStep,
): Promise<boolean> {
  const rows = await database
    .update(operations)
    .set({
      currentStep: toStep,
      stepStartedAt: sql`now()`,
      attempt: 0,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(operations.id, operationId),
        eq(operations.state, "running"),
        eq(operations.currentStep, fromStep),
      ),
    )
    .returning({ id: operations.id });
  return rows.length === 1;
}

/** Record one more reconciler nudge on the current step. */
export async function bumpAttempt(
  database: HaruDatabase,
  operationId: string,
  step: OperationStep,
): Promise<void> {
  await database
    .update(operations)
    .set({ attempt: sql`${operations.attempt} + 1`, updatedAt: sql`now()` })
    .where(
      and(
        eq(operations.id, operationId),
        eq(operations.state, "running"),
        eq(operations.currentStep, step),
      ),
    );
}

/** Finish a running operation from its final step. */
export async function completeOperation(
  database: HaruDatabase,
  operationId: string,
  fromStep: OperationStep,
): Promise<boolean> {
  const rows = await database
    .update(operations)
    .set({
      state: "succeeded",
      currentStep: null,
      finishedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(operations.id, operationId),
        eq(operations.state, "running"),
        eq(operations.currentStep, fromStep),
      ),
    )
    .returning({ id: operations.id });
  return rows.length === 1;
}

/** Fail an in-flight operation with a structured error. */
export async function failOperation(
  database: HaruDatabase,
  operationId: string,
  error: OperationError,
): Promise<boolean> {
  const rows = await database
    .update(operations)
    .set({
      state: "failed",
      error,
      finishedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(operations.id, operationId),
        inArray(operations.state, ["pending", "running"]),
      ),
    )
    .returning({ id: operations.id });
  return rows.length === 1;
}
