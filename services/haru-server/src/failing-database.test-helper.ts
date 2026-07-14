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
  breakIt: () => void;
  heal: () => void;
} {
  let isBroken = false;
  // Proxying the real handle keeps the HaruDatabase type: repo calls
  // compile exactly as they do in production, they just reject while
  // broken.
  const database = new Proxy(real, {
    get(target, property, receiver) {
      if (isBroken) {
        throw new Error("state store unreachable (test)");
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  return {
    database,
    breakIt: () => {
      isBroken = true;
    },
    heal: () => {
      isBroken = false;
    },
  };
}
