import { createDatabase } from "@haru/db";
import { serve } from "@hono/node-server";

import { createApp } from "./app.js";
import { createChatFetch } from "./chat-fetch.js";
import { loadServerEnvironment } from "./environment.js";
import { startReconcileLoop } from "./reconcile-loop.js";

try {
  process.loadEnvFile("../../.env");
} catch {
  // No .env file; rely on the process environment.
}

const environment = loadServerEnvironment(process.env);
const database = createDatabase(environment.DATABASE_URL);

// environment.ts parses HARU_API_TOKEN with blankableString, which maps
// a blank/whitespace value to undefined, so a defined value here is
// already a real, non-empty token.
const isAuthenticated = environment.HARU_API_TOKEN !== undefined;
if (!isAuthenticated) {
  console.warn(
    "HARU_API_TOKEN is not set: the API is UNAUTHENTICATED and will " +
      "bind to 127.0.0.1 only (local development mode).",
  );
}

// Chat traffic gets a dedicated dispatcher (undici's fixed 300s
// headers/body timers disabled) so HARU_CHAT_HEADER_TIMEOUT_MS is
// the exact TTFB bound and quiet SSE streams are never severed.
// Closed in the SIGTERM path below so shutdown does not strand the
// dispatcher's keep-alive sockets.
const chatFetch = createChatFetch();

const app = createApp({
  database,
  chatFetchFn: chatFetch.fetch,
  config: {
    apiToken: environment.HARU_API_TOKEN,
    supervisorToken: environment.HARU_SUPERVISOR_TOKEN,
    defaultFleet: environment.HARU_DEFAULT_FLEET,
    chatHeaderTimeoutMs: environment.HARU_CHAT_HEADER_TIMEOUT_MS,
    snapshotCacheTtlMs: environment.HARU_SNAPSHOT_CACHE_TTL_MS,
    chatMaxBodyBytes: environment.HARU_CHAT_MAX_BODY_BYTES,
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
// drives the same tick on demand (e.g. from cron or tests). The loop
// wiring (the per-fleet in-flight guard) lives in reconcile-loop.ts so
// it is unit-testable without this entrypoint's top-level side effects.
let stopReconcileLoop: (() => void) | undefined;
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
  stopReconcileLoop = startReconcileLoop(
    {
      database,
      fetchFn: fetch,
      now: () => new Date(),
      supervisorToken: environment.HARU_SUPERVISOR_TOKEN,
    },
    {
      fleetReferences,
      intervalMs: environment.HARU_RECONCILE_INTERVAL_MS,
    },
  );
}

// Installing a SIGTERM handler suppresses Node's default
// terminate-on-signal, so the handler must complete the shutdown
// itself: stop scheduling ticks, stop accepting requests, and exit
// once the listener closed. Registered in BOTH modes (with and
// without the reconcile loop): running without the loop is a valid
// production configuration, and a deploy there must also let
// in-flight work finish instead of hard-killing active chat streams.
process.on("SIGTERM", () => {
  // An in-flight tick's writes are re-entrant CASes, safe to abandon;
  // only new ticks must stop.
  stopReconcileLoop?.();
  // Closing the listener lets the process exit naturally once the
  // event loop drains (no process.exit: in-flight work finishes).
  // Node >= 19 also closes idle keep-alive connections on close().
  server.close();
  // Same policy for the chat dispatcher's upstream sockets:
  // Agent.close() lets in-flight chat streams finish, then tears
  // down keep-alive connections instead of leaving them to idle out.
  void chatFetch.close();
});
