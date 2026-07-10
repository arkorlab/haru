import { createDatabase } from "@haru/db";
import { serve } from "@hono/node-server";

import { createApp } from "./app.js";
import { loadServerEnvironment } from "./environment.js";
import { reconcileFleet } from "./reconciler/reconciler.js";

try {
  process.loadEnvFile("../../.env");
} catch {
  // No .env file; rely on the process environment.
}

const environment = loadServerEnvironment(process.env);
const database = createDatabase(environment.DATABASE_URL);

const isAuthenticated =
  environment.HARU_API_TOKEN !== undefined && environment.HARU_API_TOKEN !== "";
if (!isAuthenticated) {
  console.warn(
    "HARU_API_TOKEN is not set: the API is UNAUTHENTICATED and will " +
      "bind to 127.0.0.1 only (local development mode).",
  );
}

const app = createApp({
  database,
  config: {
    apiToken: environment.HARU_API_TOKEN,
    supervisorToken: environment.HARU_SUPERVISOR_TOKEN,
    defaultFleet: environment.HARU_DEFAULT_FLEET,
    chatHeaderTimeoutMs: environment.HARU_CHAT_HEADER_TIMEOUT_MS,
    snapshotCacheTtlMs: environment.HARU_SNAPSHOT_CACHE_TTL_MS,
  },
});

const server = serve(
  {
    fetch: app.fetch,
    port: environment.PORT,
    // Never expose the unauthenticated surface beyond loopback.
    hostname: isAuthenticated ? "0.0.0.0" : "127.0.0.1",
  },
  (info) => {
    console.log(`haru-server listening on ${info.address}:${info.port}`);
  },
);

// Optional background reconcile loop. POST /v1/fleets/:id/reconcile
// drives the same tick on demand (e.g. from cron or tests).
if (environment.HARU_RECONCILE_INTERVAL_MS !== undefined) {
  const fleetReferences = (
    environment.HARU_RECONCILE_FLEETS ??
    environment.HARU_DEFAULT_FLEET ??
    ""
  )
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (fleetReferences.length === 0) {
    console.warn(
      "HARU_RECONCILE_INTERVAL_MS is set but no fleets are configured; " +
        "set HARU_RECONCILE_FLEETS or HARU_DEFAULT_FLEET",
    );
  }
  const dependencies = {
    database,
    fetchFn: fetch,
    now: () => new Date(),
    supervisorToken: environment.HARU_SUPERVISOR_TOKEN,
  };
  // Skip a tick while the previous one is still running: a slow step
  // (a probe can legitimately take the whole probe budget) must not
  // pile up concurrent loops issuing duplicate GPU work - the DB CAS
  // dedupes state transitions but not the supervisor calls themselves.
  let isTickRunning = false;
  const reconcileTimer = setInterval(() => {
    if (isTickRunning) {
      return;
    }
    isTickRunning = true;
    void (async () => {
      try {
        for (const reference of fleetReferences) {
          try {
            await reconcileFleet(dependencies, reference);
          } catch (error) {
            console.error(`reconcile ${reference} failed:`, error);
          }
        }
      } finally {
        isTickRunning = false;
      }
    })();
  }, environment.HARU_RECONCILE_INTERVAL_MS);
  // Installing a SIGTERM handler suppresses Node's default
  // terminate-on-signal, so the handler must complete the shutdown
  // itself: stop scheduling ticks, stop accepting requests, and exit
  // once the listener closed (an in-flight tick's writes are
  // re-entrant CASes and safe to abandon).
  process.on("SIGTERM", () => {
    clearInterval(reconcileTimer);
    // Closing the listener lets the process exit naturally once the
    // event loop drains (no process.exit: in-flight work finishes).
    // Node >= 19 also closes idle keep-alive connections on close().
    server.close();
  });
}
