import {
  operationSnapshotSchema,
  type OperationError,
  type OperationKind,
  type OperationSnapshot,
  type OperationStep,
} from "@haru/protocol";
import { and, eq, inArray, notExists, sql } from "drizzle-orm";

import { fleets, operations } from "../schema/index.js";

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
        // Captured INSIDE the insert statement, not from the caller's
        // snapshot: an operation completing between the caller's read
        // and this insert winning the one-in-flight slot could move
        // the pointer, and post-commit cleanup would then act on a
        // stale "old active".
        sourceDomainId: sql`(select ${fleets.activeDomainId} from ${fleets} where ${fleets.id} = ${input.fleetId})`,
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

/**
 * Claim a pending operation for execution (pending -> running).
 * Returns the claimed row (so callers need no re-read), or null when
 * the CAS lost.
 */
export async function claimOperation(
  database: HaruDatabase,
  operationId: string,
  firstStep: OperationStep,
  // App clock, not sql`now()`: the reconciler compares stepStartedAt
  // against its own injected clock, so mixing in the DB clock would
  // shift every step-timeout budget by the host/DB skew.
  at: Date = new Date(),
): Promise<OperationRow | null> {
  const rows = await database
    .update(operations)
    .set({
      state: "running",
      currentStep: firstStep,
      stepStartedAt: at,
      updatedAt: sql`now()`,
    })
    .where(and(eq(operations.id, operationId), eq(operations.state, "pending")))
    .returning();
  return rows[0] ?? null;
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
  /** App clock; see claimOperation. */
  at: Date = new Date(),
): Promise<OperationRow | null> {
  const rows = await database
    .update(operations)
    .set({
      currentStep: toStep,
      stepStartedAt: at,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(operations.id, operationId),
        eq(operations.state, "running"),
        eq(operations.currentStep, fromStep),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/** Finish a running operation from its final step. */
export async function completeOperation(
  database: HaruDatabase,
  operationId: string,
  fromStep: OperationStep,
): Promise<OperationRow | null> {
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
    .returning();
  return rows[0] ?? null;
}

/**
 * Fail an in-flight operation with a structured error. When
 * `fromStep` is given the failure is additionally guarded on the
 * current step, so a reconcile tick that lost a race (another tick
 * already advanced or completed the step) cannot fail an operation
 * for a step that is no longer running.
 *
 * `guard: "target_not_routed"` further blocks the failure while the
 * fleet's routing pointer sits on the operation's target. This closes
 * the switch_active commit race: the routing CAS and the step advance
 * are separate statements, so a timeout tick that read a stale
 * pointer could otherwise land its failure in between - routing on
 * the new active with the operation recorded failed and post-commit
 * cleanup skipped. With the guard the failure matches zero rows, the
 * timeout tick re-reads, and both ticks converge on done. Correlated
 * to the operation row inside the statement, so it needs no extra
 * parameters.
 */
export async function failOperation(
  database: HaruDatabase,
  operationId: string,
  error: OperationError,
  fromStep?: OperationStep,
  guard?: "target_not_routed",
): Promise<OperationRow | null> {
  const targetRouted = database
    .select({ one: sql`1` })
    .from(fleets)
    .where(
      and(
        eq(fleets.id, operations.fleetId),
        eq(fleets.activeDomainId, operations.targetDomainId),
      ),
    );
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
        ...(fromStep === undefined
          ? []
          : [eq(operations.currentStep, fromStep)]),
        ...(guard === "target_not_routed" ? [notExists(targetRouted)] : []),
      ),
    )
    .returning();
  return rows[0] ?? null;
}
