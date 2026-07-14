import type { HaruDatabase } from "@haru/db";

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
 */
export function breakableDatabase(real: HaruDatabase): {
  database: HaruDatabase;
  /** Fail every query from now on (the store is unreachable). */
  breakIt: () => void;
  /**
   * Let the next `allowedSelects` SELECTs through, then fail. The chat
   * path issues exactly one SELECT for the routing pointer before the
   * (multi-SELECT) snapshot load, so `breakAfterSelects(1)` reproduces
   * "the store answered the pointer read and then went away" - the
   * partial failure that must NOT fail open when the pointer moved.
   */
  breakAfterSelects: (allowedSelects: number) => void;
  heal: () => void;
} {
  let isBroken = false;
  let selectsLeft = Infinity;
  // Proxying the real handle keeps the HaruDatabase type: repo calls
  // compile exactly as they do in production, they just reject while
  // broken.
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
    heal: () => {
      isBroken = false;
      selectsLeft = Infinity;
    },
  };
}
