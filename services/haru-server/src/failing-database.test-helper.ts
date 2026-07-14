import type { HaruDatabase } from "@haru/db";

interface SelectGate {
  /** 1-based absolute select-access index this gate arms at. */
  at: number;
  reachedGate: () => void;
  decision: Promise<"proceed" | "fail">;
}

/**
 * Wrap a real database handle so a test can take the state store away
 * mid-flight and give it back. Every property access throws while
 * broken, so any repo call (`select`, `update`, ...) rejects the way an
 * unreachable Postgres would.
 *
 * Hand-written rather than mocked: the repo injects every I/O boundary
 * (fetch, exec, spawn, clock) and has no mock library at all, so a
 * throwing HaruDatabase is the DB-shaped sibling of the `failingFetch`
 * lambdas the chat tests already use.
 *
 * Counting caveat: the budgeted helpers count `select` PROPERTY
 * ACCESSES, not executed queries. A plain-slug pointer read is one
 * access, but a UUID-shaped reference can cost TWO (id probe + slug
 * fallback), and the snapshot load's domain-ids subquery BUILDER ticks
 * the counter without ever running as its own query. Budgets are
 * therefore per-reference-shape; the chat tests use the plain slug
 * `default`, where the pointer read really is a single access.
 */
export function breakableDatabase(real: HaruDatabase): {
  database: HaruDatabase;
  /** Fail every query from now on (the store is unreachable). */
  breakIt: () => void;
  /**
   * Let the next `allowedSelects` select accesses through, then fail.
   * With a plain-slug fleet reference, `breakAfterSelects(1)` reproduces
   * "the store answered the pointer read and then went away" - the
   * partial failure that must NOT fail open when the pointer moved.
   */
  breakAfterSelects: (allowedSelects: number) => void;
  /**
   * Suspend the Nth select access from now (1-based) at its await
   * point: the query does not execute until the test decides. This is
   * how interleavings are pinned deterministically - one request is
   * frozen mid-lookup while a concurrent request (or the test itself)
   * changes the world, then resumed to observe what its late result
   * does to the cache. `reached` resolves when the request arrives at
   * the gate; `proceed` runs the real query then; `fail` rejects it
   * instead.
   */
  gateSelect: (access: number) => {
    reached: Promise<void>;
    proceed: () => void;
    fail: () => void;
  };
  heal: () => void;
} {
  let isBroken = false;
  let selectsLeft = Infinity;
  let selectAccesses = 0;
  let pendingGate: SelectGate | undefined;
  // Proxying the real handle keeps the HaruDatabase type: repo calls
  // compile exactly as they do in production, they just reject (or
  // suspend) while the test says so.
  const database = new Proxy(real, {
    get(target, property, receiver) {
      if (isBroken) {
        throw new Error("state store unreachable (test)");
      }
      if (property === "select") {
        if (selectsLeft <= 0) {
          throw new Error("state store unreachable (test)");
        }
        selectsLeft -= 1;
        selectAccesses += 1;
        const gate = pendingGate;
        if (gate?.at === selectAccesses) {
          pendingGate = undefined;
          const select = Reflect.get(target, property, receiver) as (
            ...arguments_: unknown[]
          ) => object;
          return (...arguments_: unknown[]) =>
            gatedBuilder(select.apply(target, arguments_), gate);
        }
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  return {
    database,
    breakIt: () => {
      isBroken = true;
    },
    breakAfterSelects: (allowedSelects: number) => {
      selectsLeft = allowedSelects;
    },
    gateSelect: (access: number) => {
      const reached = Promise.withResolvers<undefined>();
      const decision = Promise.withResolvers<"proceed" | "fail">();
      pendingGate = {
        at: selectAccesses + access,
        reachedGate: () => {
          reached.resolve(undefined);
        },
        decision: decision.promise,
      };
      return {
        reached: reached.promise,
        proceed: () => {
          decision.resolve("proceed");
        },
        fail: () => {
          decision.resolve("fail");
        },
      };
    },
    heal: () => {
      isBroken = false;
      selectsLeft = Infinity;
      pendingGate = undefined;
    },
  };
}

/**
 * Wrap a drizzle select builder so the QUERY (its thenable `then`)
 * waits for the gate's decision. Chained builder methods (`from`,
 * `where`, `limit`, ...) re-wrap their results so the gate survives
 * the whole chain.
 */
function gatedBuilder(builder: object, gate: SelectGate): object {
  return new Proxy(builder, {
    get(target, property) {
      if (property === "then") {
        gate.reachedGate();
        const realThen = Reflect.get(target, property) as (
          resolve: (value: unknown) => void,
          reject: (error: unknown) => void,
        ) => unknown;
        return (
          resolve: (value: unknown) => void,
          reject: (error: unknown) => void,
        ) => {
          void gate.decision.then((choice) => {
            if (choice === "fail") {
              reject(new Error("state store hiccup (test)"));
            } else {
              realThen.call(target, resolve, reject);
            }
          });
        };
      }
      const value = Reflect.get(target, property) as unknown;
      if (typeof value === "function") {
        return (...arguments_: unknown[]) => {
          const result = (value as (...a: unknown[]) => unknown).apply(
            target,
            arguments_,
          );
          return result !== null && typeof result === "object"
            ? gatedBuilder(result, gate)
            : result;
        };
      }
      return value;
    },
  });
}
