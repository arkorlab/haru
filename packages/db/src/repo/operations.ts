import { assertSlotTransition } from "@haru/core";
import {
  operationSnapshotSchema,
  type OperationError,
  type OperationKind,
  type OperationSnapshot,
  type OperationStep,
} from "@haru/protocol";
import { and, eq, exists, inArray, notExists, sql } from "drizzle-orm";

import { domains, fleets, operations, slots } from "../schema/index.js";

import { FAILED_PROMOTION_SLOT_STATES } from "./slots.js";

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
 * `guard: "target_not_routed"` further blocks the failure once the
 * operation has committed routing (`routingCommitted = true`, stamped
 * by switchActive atomically with the pointer move). This closes the
 * switch_active commit race: the routing CAS and the step advance are
 * separate statements, so a timeout tick that read a stale pointer
 * could otherwise land its failure in between - routing on the new
 * active with the operation recorded failed and post-commit cleanup
 * skipped. Guarding on the operation's OWN `routingCommitted` column
 * (not a `fleets` pointer subquery) is what makes the guard reliable:
 * under READ COMMITTED a fail blocked on the locked operation row
 * re-checks that row's columns on unblock (so a just-set
 * routingCommitted is seen), whereas a correlated subquery keeps the
 * pre-commit snapshot. With the guard the failure matches zero rows,
 * the timeout tick re-reads, and both ticks converge on done.
 */
export async function failOperation(
  database: HaruDatabase,
  operationId: string,
  error: OperationError,
  fromStep?: OperationStep,
  guard?: "target_not_routed",
): Promise<OperationRow | null> {
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
        ...(guard === "target_not_routed"
          ? [eq(operations.routingCommitted, false)]
          : []),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * Fail an in-flight operation AND (for promotes whose routing never
 * committed) mark the target's wake-path inference slots failed, in
 * ONE statement via data-modifying CTEs. Atomicity is the point: a
 * separate cleanup statement runs after failOperation released the
 * one-in-flight slot, so a retry promote inserted in that gap (or
 * even inside the cleanup's own snapshot window) could have its
 * freshly-woken slots clobbered. With fail and cleanup in a single
 * statement, a retry can only ever be created strictly after the
 * cleaned slot states are visible. Same `fromStep` /
 * `target_not_routed` semantics as failOperation; the slot CTE
 * additionally no-ops for demotes (their target's serving slots
 * reflect a sleep that genuinely did not happen) and when the routing
 * pointer already sits on the target (those serving slots ARE live
 * traffic).
 */
export async function failOperationWithPromotionCleanup(
  database: HaruDatabase,
  operationId: string,
  error: OperationError,
  fromStep?: OperationStep,
  guard?: "target_not_routed",
): Promise<OperationRow | null> {
  for (const state of FAILED_PROMOTION_SLOT_STATES) {
    assertSlotTransition("inference", state, "failed");
  }
  const failQuery = database
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
        // Same EPQ-safe guard as failOperation: refuse once this
        // operation committed routing. This gates the whole statement -
        // when it matches zero rows the slot cleanup CTE below joins an
        // empty failed_operation and touches nothing.
        ...(guard === "target_not_routed"
          ? [eq(operations.routingCommitted, false)]
          : []),
      ),
    )
    .returning();
  const failedOperation = database.$with("failed_operation").as(failQuery);
  const pointerAtFailedTarget = database
    .select({ one: sql`1` })
    .from(fleets)
    .where(
      and(
        eq(fleets.id, failedOperation.fleetId),
        eq(fleets.activeDomainId, failedOperation.targetDomainId),
      ),
    );
  // The pointer guard above is scoped to the operation's OWN fleet, so
  // a stale/malformed row whose target belongs to another fleet would
  // pass it vacuously and fail THAT fleet's slots; require the target
  // to belong to the operation's fleet before any slot is touched.
  const targetBelongsToFleet = database
    .select({ one: sql`1` })
    .from(domains)
    .where(
      and(
        eq(domains.id, failedOperation.targetDomainId),
        eq(domains.fleetId, failedOperation.fleetId),
      ),
    );
  const cleanupQuery = database
    .update(slots)
    .set({
      state: "failed",
      stateUpdatedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .from(failedOperation)
    .where(
      and(
        eq(failedOperation.kind, "promote"),
        eq(slots.domainId, failedOperation.targetDomainId),
        eq(slots.kind, "inference"),
        inArray(slots.state, [...FAILED_PROMOTION_SLOT_STATES]),
        exists(targetBelongsToFleet),
        notExists(pointerAtFailedTarget),
      ),
    )
    .returning({ id: slots.id });
  const cleanedSlots = database.$with("cleaned_slots").as(cleanupQuery);
  const rows = await database
    .with(failedOperation, cleanedSlots)
    .select()
    .from(failedOperation);
  return rows[0] ?? null;
}
