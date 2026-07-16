import { reconcileFleet } from "./reconciler/reconciler.js";

import type { ReconcilerDependencies } from "./reconciler/reconciler.js";

export interface ReconcileLoopOptions {
  /** Fleet references (slug or id) reconciled every interval. */
  fleetReferences: readonly string[];
  /** setInterval period. */
  intervalMs: number;
  /** Injectable for tests; defaults to the real reconcileFleet. */
  reconcile?: (
    dependencies: ReconcilerDependencies,
    reference: string,
  ) => Promise<unknown>;
  /** Injectable failure sink; defaults to console.error. */
  onError?: (reference: string, error: unknown) => void;
}

/**
 * Start the optional background reconcile loop and return a stop
 * function (clears the interval; an in-flight tick is abandoned, which
 * is safe because every reconcile write is a guarded CAS).
 *
 * Each fleet is reconciled every interval UNLESS its own previous
 * reconcile is still in flight - a PER-FLEET in-flight guard, held until
 * that reconcile SETTLES (not on a timer). Two properties fall out of
 * that:
 *   - a slow or hung fleet never delays the OTHER fleets: there is no
 *     shared mutex, so one stuck fleet cannot throttle every fleet's
 *     reconcile and blow a healthy fleet's degradedGraceMs failover
 *     budget; the fleets run concurrently and independently.
 *   - a fleet does not overlap ITSELF for a given reference string, so
 *     the common case does not redundantly re-issue the supervisor calls
 *     a tick makes. This is a best-effort throttle, NOT a hard
 *     invariant: reconcileFleet is explicitly safe to run concurrently
 *     (every write is a guarded CAS, no transaction spans a supervisor
 *     call), so one fleet CAN still be reconciled concurrently - by the
 *     manual POST /reconcile endpoint, another replica, or the same
 *     fleet listed under both its slug AND its id (the Set/guard key on
 *     the raw reference, not the resolved id) - yielding only duplicate
 *     idempotent supervisor calls, never corrupt state. Releasing the
 *     guard on a watchdog timer would ADD such overlap on every hang,
 *     which is why the guard is held until the work settles instead.
 *
 * reconcileFleet's opening store read has no AbortSignal, so a store
 * "hang mode" outage pauses only the stuck fleet until the DB driver's
 * own transport timeout (~300s on Neon) settles the read; every other
 * fleet keeps reconciling. A tighter, explicit bound is the deferred fix
 * in KNOWN_ISSUES ("outage detection latency ... unbounded").
 */
export function startReconcileLoop(
  dependencies: ReconcilerDependencies,
  options: ReconcileLoopOptions,
): () => void {
  // De-dup identical reference strings so a fleet listed twice is not
  // reconciled twice per tick. Two DIFFERENT reference forms of one fleet
  // (slug + id) are NOT collapsed - that is the harmless CAS-safe
  // redundant-work case documented above, not a correctness concern.
  const fleetReferences = [...new Set(options.fleetReferences)];
  const reconcile = options.reconcile ?? reconcileFleet;
  const onError =
    options.onError ??
    ((reference, error) => {
      console.error(`reconcile ${reference} failed:`, error);
    });

  // Fleets whose reconcile is still running: the per-fleet guard. A
  // fleet is re-reconciled on the next interval only once its own entry
  // clears (on success or failure of the actual work).
  const inFlight = new Set<string>();
  const timer = setInterval(() => {
    for (const reference of fleetReferences) {
      if (inFlight.has(reference)) {
        continue;
      }
      inFlight.add(reference);
      void (async () => {
        try {
          await reconcile(dependencies, reference);
        } catch (error) {
          onError(reference, error);
        } finally {
          inFlight.delete(reference);
        }
      })();
    }
  }, options.intervalMs);

  return () => {
    clearInterval(timer);
  };
}
