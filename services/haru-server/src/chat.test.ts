import {
  applyFleetLayout,
  getFleetSnapshot,
  schema,
  switchActive,
  transitionDomainSlots,
} from "@haru/db";
import { createTestDatabase } from "@haru/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { breakableDatabase } from "./failing-database.test-helper.js";
import {
  buildFakeFetch,
  fakeSupervisorState,
  testLayout,
  ALPHA_SERVING,
  ALPHA_SUPERVISOR,
  BETA_SERVING,
  BETA_SUPERVISOR,
} from "./fake-supervisor.test-helper.js";

import type { FakeUpstreamCall } from "./fake-supervisor.test-helper.js";
import type { HaruDatabase } from "@haru/db";
import type { SlotSpec } from "@haru/protocol";

let database: HaruDatabase;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db: database, close } = await createTestDatabase());
  await applyFleetLayout(database, testLayout());
});

afterEach(async () => {
  await close();
});

function chatApp(options: {
  chatCalls?: FakeUpstreamCall[];
  fetchFn?: typeof fetch;
  config?: Record<string, unknown>;
  database?: HaruDatabase;
  now?: () => Date;
}) {
  return createApp({
    database: options.database ?? database,
    now: options.now,
    config: options.config ?? {},
    fetchFn:
      options.fetchFn ??
      buildFakeFetch({
        supervisors: {
          [ALPHA_SUPERVISOR]: fakeSupervisorState({ sleeping: false }),
          [BETA_SUPERVISOR]: fakeSupervisorState(),
        },
        chatCalls: options.chatCalls,
      }),
  });
}

const chatBody = JSON.stringify({
  model: "example-chat-small",
  messages: [{ role: "user", content: "hi" }],
  temperature: 0.3,
  some_vendor_extension: { keep: true },
});

describe("POST /v1/chat/completions", () => {
  it("proxies to the active domain's serving URL byte-identically", async () => {
    const chatCalls: FakeUpstreamCall[] = [];
    const app = chatApp({ chatCalls });
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-haru-fleet": "default",
      },
      body: chatBody,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    // The upstream SSE stream comes back untouched.
    const text = await response.text();
    expect(text).toContain('data: {"choices"');
    expect(text).toContain("data: [DONE]");
    // Forwarded verbatim, including unknown vendor extensions.
    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0]?.url).toBe(`${ALPHA_SERVING}/v1/chat/completions`);
    expect(chatCalls[0]?.body).toBe(chatBody);
  });

  it("413s a request body over the configured size cap", async () => {
    const chatCalls: FakeUpstreamCall[] = [];
    const app = chatApp({ chatCalls, config: { chatMaxBodyBytes: 16 } });
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-haru-fleet": "default",
      },
      body: chatBody, // well over 16 bytes
    });
    expect(response.status).toBe(413);
    const body = await response.json();
    expect(body.error.code).toBe("payload_too_large");
    // Never reached the upstream.
    expect(chatCalls).toHaveLength(0);
  });

  it("falls back to the configured default fleet", async () => {
    const chatCalls: FakeUpstreamCall[] = [];
    const app = chatApp({ chatCalls, config: { defaultFleet: "default" } });
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody,
    });
    expect(response.status).toBe(200);
    expect(chatCalls).toHaveLength(1);
  });

  it("404s when no fleet is specified or the fleet is unknown", async () => {
    const app = chatApp({});
    const noFleet = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody,
    });
    expect(noFleet.status).toBe(404);

    const unknownFleet = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-haru-fleet": "ghost",
      },
      body: chatBody,
    });
    expect(unknownFleet.status).toBe(404);
  });

  it("404s an unserved model and lists what is available", async () => {
    const app = chatApp({});
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-haru-fleet": "default",
      },
      body: JSON.stringify({ model: "unknown-model", messages: [] }),
    });
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("model_not_found");
    expect(body.error.message).toContain("example-chat-small");
  });

  it("400s a body without a model field", async () => {
    const app = chatApp({});
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-haru-fleet": "default",
      },
      body: JSON.stringify({ messages: [] }),
    });
    expect(response.status).toBe(400);
  });

  it("503s when the fleet has no active domain", async () => {
    const layout = testLayout() as { activeDomainSlug?: string; slug: string };
    delete layout.activeDomainSlug;
    layout.slug = "headless";
    await applyFleetLayout(database, layout);
    const app = chatApp({});
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-haru-fleet": "headless",
      },
      body: chatBody,
    });
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("no_active_domain");
  });

  it("504s when upstream headers do not arrive in time", async () => {
    const hangingFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const reason: unknown = init.signal?.reason;
          reject(reason instanceof Error ? reason : new Error("aborted"));
        });
      });
    const app = chatApp({
      fetchFn: hangingFetch,
      config: { chatHeaderTimeoutMs: 20 },
    });
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-haru-fleet": "default",
      },
      body: chatBody,
    });
    expect(response.status).toBe(504);
    expect((await response.json()).error.code).toBe("upstream_timeout");
  });

  it("504s when the transport's own headers timer fires", async () => {
    // The shape undici gives a headers timeout when an embedder wires
    // a PLAIN global fetch (not createChatFetch) with a TTFB bound
    // above undici's 300s: a generic TypeError with a coded cause.
    // Must map to 504 like our own timer, not 502 unreachable.
    const undiciHeadersTimeout: typeof fetch = () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("Headers Timeout Error"), {
          code: "UND_ERR_HEADERS_TIMEOUT",
        }),
      });
    };
    const app = chatApp({ fetchFn: undiciHeadersTimeout });
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-haru-fleet": "default",
      },
      body: chatBody,
    });
    expect(response.status).toBe(504);
    expect((await response.json()).error.code).toBe("upstream_timeout");
  });

  it("uses chatFetchFn for chat traffic when provided", async () => {
    // main.ts wires a dispatcher-backed fetch here; this pins the
    // dependency plumbing so chat cannot silently fall back to the
    // control-plane fetch (whose transport timeouts differ).
    const chatCalls: FakeUpstreamCall[] = [];
    const controlPlaneOnly: typeof fetch = () => {
      throw new Error("chat traffic must not use fetchFn");
    };
    const app = createApp({
      database,
      fetchFn: controlPlaneOnly,
      chatFetchFn: buildFakeFetch({
        supervisors: {
          [ALPHA_SUPERVISOR]: fakeSupervisorState({ sleeping: false }),
          [BETA_SUPERVISOR]: fakeSupervisorState(),
        },
        chatCalls,
      }),
    });
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-haru-fleet": "default",
      },
      body: chatBody,
    });
    expect(response.status).toBe(200);
    expect(chatCalls).toHaveLength(1);
  });

  it("502s when the upstream is unreachable", async () => {
    const failingFetch: typeof fetch = () => {
      throw new TypeError("fetch failed");
    };
    const app = chatApp({ fetchFn: failingFetch });
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-haru-fleet": "default",
      },
      body: chatBody,
    });
    expect(response.status).toBe(502);
    expect((await response.json()).error.code).toBe("upstream_unreachable");
  });

  it("aborts the upstream and answers 499 when the client disconnects pre-headers", async () => {
    let wasUpstreamAborted = false;
    const hangingFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        const abort = () => {
          wasUpstreamAborted = true;
          const reason: unknown = init?.signal?.reason;
          reject(reason instanceof Error ? reason : new Error("aborted"));
        };
        // A signal aborted before fetch was reached never fires the
        // event; without this check a lost timing race would hang the
        // test until its timeout instead of asserting.
        if (init?.signal?.aborted) {
          abort();
          return;
        }
        init?.signal?.addEventListener("abort", abort);
      });
    // Long TTFB budget: only the client signal can cut this request.
    const app = chatApp({
      fetchFn: hangingFetch,
      config: { chatHeaderTimeoutMs: 60_000 },
    });
    const client = new AbortController();
    const pending = app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-haru-fleet": "default",
      },
      body: chatBody,
      signal: client.signal,
    });
    // Let the handler reach the upstream fetch, then walk away.
    await new Promise((resolve) => setTimeout(resolve, 10));
    client.abort();
    const response = await pending;
    expect(response.status).toBe(499);
    expect(wasUpstreamAborted).toBe(true);
  });

  it("stops routing to a dead model after a heartbeat and recovers when it returns", async () => {
    const alphaState = fakeSupervisorState({ sleeping: false });
    // Injected clock: cache expiry is driven by warping nowMs instead
    // of real setTimeout waits (guideline: inject all I/O incl. time).
    let nowMs = Date.now();
    const app = createApp({
      database,
      now: () => new Date(nowMs),
      config: { snapshotCacheTtlMs: 1000 },
      fetchFn: buildFakeFetch({
        supervisors: {
          [ALPHA_SUPERVISOR]: alphaState,
          [BETA_SUPERVISOR]: fakeSupervisorState(),
        },
      }),
    });
    const chat = () =>
      app.request("/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-haru-fleet": "default",
        },
        body: chatBody,
      });
    const reconcile = () =>
      app.request("/v1/fleets/default/reconcile", { method: "POST" });
    const waitTtl = () => {
      nowMs += 1001;
    };

    expect((await chat()).status).toBe(200);

    // The active's model dies (supervisor reachable, model asleep):
    // the heartbeat sync fails the slot and chat stops proxying to a
    // dead server.
    alphaState.sleeping = true;
    await reconcile();
    waitTtl();
    const dead = await chat();
    expect(dead.status).toBe(404);
    expect((await dead.json()).error.code).toBe("model_not_found");
    const degraded = await getFleetSnapshot(database, "default");
    const alphaDomain = degraded?.domains.find((d) => d.slug === "alpha");
    expect(alphaDomain?.state).toBe("degraded");
    expect(
      alphaDomain?.slots
        .filter((s) => s.kind === "inference")
        .every((s) => s.state === "failed"),
    ).toBe(true);

    // The model comes back: the same sync recovers the slot.
    alphaState.sleeping = false;
    await reconcile();
    waitTtl();
    expect((await chat()).status).toBe(200);
  });

  it("routes to the new active immediately after a pointer move (cache revalidation)", async () => {
    const chatCalls: FakeUpstreamCall[] = [];
    const app = chatApp({ chatCalls });
    const request = () =>
      app.request("/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-haru-fleet": "default",
        },
        body: chatBody,
      });

    // First request populates the snapshot cache with alpha active.
    expect((await request()).status).toBe(200);
    expect(chatCalls[0]?.url).toBe(`${ALPHA_SERVING}/v1/chat/completions`);

    // A pointer move from OUTSIDE this process (no in-process
    // invalidation hook fires): direct CAS, then walk beta's slots to
    // serving. The per-request revision check must bust the cache
    // within the TTL.
    const snapshot = await getFleetSnapshot(database, "default");
    const alphaId = snapshot!.domains.find((d) => d.slug === "alpha")!.id;
    const betaId = snapshot!.domains.find((d) => d.slug === "beta")!.id;
    await switchActive(database, snapshot!.id, alphaId, betaId);
    await transitionDomainSlots(
      database,
      betaId,
      "inference",
      ["sleeping"],
      "waking",
    );
    await transitionDomainSlots(
      database,
      betaId,
      "inference",
      ["waking"],
      "probing",
    );
    await transitionDomainSlots(
      database,
      betaId,
      "inference",
      ["probing"],
      "serving",
    );

    expect((await request()).status).toBe(200);
    expect(chatCalls[1]?.url).toBe(`${BETA_SERVING}/v1/chat/completions`);
  });
});

/**
 * Fail-open: the DATA path must survive a state-store outage. The
 * routing pointer cannot move while the database is down (switchActive
 * needs the very CAS that is failing), so the cached routing is still
 * correct, and serving it beats 5xx-ing a healthy inference path
 * because the control database is sick.
 */
describe("POST /v1/chat/completions with an unreachable state store", () => {
  function failOpenApp(options: {
    chatCalls?: FakeUpstreamCall[];
    nowMs?: () => number;
    snapshotCacheTtlMs?: number;
  }) {
    const broken = breakableDatabase(database);
    // Same wiring as chatApp (the fleet posture must not drift between
    // the healthy suite and this one), with the breakable handle and an
    // injectable clock swapped in.
    const app = chatApp({
      chatCalls: options.chatCalls,
      database: broken.database,
      now: options.nowMs ? () => new Date(options.nowMs!()) : undefined,
      config:
        options.snapshotCacheTtlMs === undefined
          ? {}
          : { snapshotCacheTtlMs: options.snapshotCacheTtlMs },
    });
    const chat = (fleetReference = "default") =>
      app.request("/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-haru-fleet": fleetReference,
        },
        body: chatBody,
      });
    return { chat, ...broken };
  }

  it("keeps serving the last known routing, past the cache TTL", async () => {
    const chatCalls: FakeUpstreamCall[] = [];
    let nowMs = Date.now();
    const { chat, breakIt } = failOpenApp({
      chatCalls,
      nowMs: () => nowMs,
      snapshotCacheTtlMs: 1000,
    });

    // Warm the cache while the store is healthy.
    const warm = await chat();
    expect(warm.status).toBe(200);
    expect(warm.headers.get("x-haru-routing")).toBeNull();

    // The state store goes away.
    breakIt();
    const stale = await chat();
    expect(stale.status).toBe(200);
    expect(stale.headers.get("x-haru-routing")).toBe("stale");
    expect(chatCalls[1]?.url).toBe(`${ALPHA_SERVING}/v1/chat/completions`);

    // The cache TTL deliberately does NOT bound the fail-open path:
    // capping it would take a healthy inference path down just because
    // the control database is unwell.
    nowMs += 60_000;
    const wayPastTtl = await chat();
    expect(wayPastTtl.status).toBe(200);
    expect(wayPastTtl.headers.get("x-haru-routing")).toBe("stale");
    expect(chatCalls).toHaveLength(3);
  });

  it("fails closed with 503 state_store_unavailable on a cold cache", async () => {
    const chatCalls: FakeUpstreamCall[] = [];
    const { chat, breakIt } = failOpenApp({ chatCalls });
    // A process that never saw this fleet cannot invent its routing:
    // an outage during a cold start is not survivable, which is why the
    // server must not be restarted mid-outage.
    breakIt();
    const response = await chat();
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("state_store_unavailable");
    // Nothing was proxied: we never guessed an upstream.
    expect(chatCalls).toHaveLength(0);
  });

  it("returns to fresh routing (and sees a missed pointer move) once the store is back", async () => {
    const chatCalls: FakeUpstreamCall[] = [];
    const { chat, breakIt, heal } = failOpenApp({ chatCalls });
    expect((await chat()).status).toBe(200);

    breakIt();
    // A promotion committed by ANOTHER process while this one is blind
    // (the test drives the real handle). The stale path cannot see it.
    const snapshot = await getFleetSnapshot(database, "default");
    const alphaId = snapshot!.domains.find((d) => d.slug === "alpha")!.id;
    const betaId = snapshot!.domains.find((d) => d.slug === "beta")!.id;
    await switchActive(database, snapshot!.id, alphaId, betaId);
    for (const [from, to] of [
      ["sleeping", "waking"],
      ["waking", "probing"],
      ["probing", "serving"],
    ] as const) {
      await transitionDomainSlots(database, betaId, "inference", [from], to);
    }

    const blind = await chat();
    expect(blind.status).toBe(200);
    expect(blind.headers.get("x-haru-routing")).toBe("stale");
    // Still the OLD active: that is the honest consequence of being
    // unable to read the pointer.
    expect(chatCalls[1]?.url).toBe(`${ALPHA_SERVING}/v1/chat/completions`);

    // The store comes back: the per-request revision check picks the
    // move up immediately and the stale marker disappears.
    heal();
    const fresh = await chat();
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get("x-haru-routing")).toBeNull();
    expect(chatCalls[2]?.url).toBe(`${BETA_SERVING}/v1/chat/completions`);
  });

  it("reaches a slug-warmed cache by UUID (and vice versa) during an outage", async () => {
    const chatCalls: FakeUpstreamCall[] = [];
    const { chat, breakIt } = failOpenApp({ chatCalls });
    const fleetId = (await getFleetSnapshot(database, "default"))!.id;

    // Warm through the slug only.
    expect((await chat("default")).status).toBe(200);

    // X-Haru-Fleet accepts slug OR uuid: the other form must resolve to
    // the same cached entry, which is keyed by fleet id.
    breakIt();
    const byUuid = await chat(fleetId);
    expect(byUuid.status).toBe(200);
    expect(byUuid.headers.get("x-haru-routing")).toBe("stale");
    expect(chatCalls[1]?.url).toBe(`${ALPHA_SERVING}/v1/chat/completions`);
  });

  it("fails CLOSED when the pointer moved but the fresh snapshot will not load", async () => {
    const chatCalls: FakeUpstreamCall[] = [];
    const { chat, breakAfterSelects } = failOpenApp({ chatCalls });
    expect((await chat()).status).toBe(200);

    // A promotion commits. The store is still REACHABLE, so the
    // fail-open argument (the pointer cannot move) does not hold: this
    // process has just LEARNED that routing moved.
    const snapshot = await getFleetSnapshot(database, "default");
    const alphaId = snapshot!.domains.find((d) => d.slug === "alpha")!.id;
    const betaId = snapshot!.domains.find((d) => d.slug === "beta")!.id;
    await switchActive(database, snapshot!.id, alphaId, betaId);

    // Pointer read succeeds (revision N+1), snapshot load then fails.
    breakAfterSelects(1);
    const response = await chat();
    expect(response.status).toBe(503);
    expect(
      ((await response.json()) as { error: { code: string } }).error.code,
    ).toBe("state_store_unavailable");
    // Serving the cached route would have sent traffic to the domain the
    // promotion just moved AWAY from, defeating the failover.
    expect(chatCalls).toHaveLength(1);
  });

  it("still serves stale when only the non-routing refresh fails (same revision)", async () => {
    const chatCalls: FakeUpstreamCall[] = [];
    let nowMs = Date.now();
    const { chat, breakAfterSelects } = failOpenApp({
      chatCalls,
      nowMs: () => nowMs,
      snapshotCacheTtlMs: 1000,
    });
    expect((await chat()).status).toBe(200);

    // TTL expiry forces a snapshot reload; the pointer still reads the
    // SAME revision, so the cached ROUTING is provably current and only
    // slot-state freshness is lost. That is the trade the TTL already
    // makes, so serve it.
    nowMs += 1001;
    breakAfterSelects(1);
    const response = await chat();
    expect(response.status).toBe(200);
    expect(response.headers.get("x-haru-routing")).toBe("stale");
    expect(chatCalls[1]?.url).toBe(`${ALPHA_SERVING}/v1/chat/completions`);
  });

  it("quarantines the cache when it learns the pointer moved (no later resurrection)", async () => {
    const chatCalls: FakeUpstreamCall[] = [];
    const { chat, breakAfterSelects, breakIt } = failOpenApp({ chatCalls });
    expect((await chat()).status).toBe(200);

    const snapshot = await getFleetSnapshot(database, "default");
    const alphaId = snapshot!.domains.find((d) => d.slug === "alpha")!.id;
    const betaId = snapshot!.domains.find((d) => d.slug === "beta")!.id;
    await switchActive(database, snapshot!.id, alphaId, betaId);

    // Pointer read sees revision N+1, snapshot load fails: fail closed.
    breakAfterSelects(1);
    expect((await chat()).status).toBe(503);

    // The store now goes away entirely. The entry we already KNOW is
    // superseded must not come back through fail-open: routing there
    // would defeat the promotion we just observed.
    breakIt();
    const afterOutage = await chat();
    expect(afterOutage.status).toBe(503);
    expect(chatCalls).toHaveLength(1);
  });

  it("forgets every alias of a fleet the store reports gone", async () => {
    const chatCalls: FakeUpstreamCall[] = [];
    const { chat, breakIt } = failOpenApp({ chatCalls });
    const fleetId = (await getFleetSnapshot(database, "default"))!.id;
    expect((await chat("default")).status).toBe(200);

    // The fleet is deleted. The healthy request that observes it must
    // drop the snapshot AND every alias, not just the spelling it used.
    await database.delete(schema.slots);
    await database.delete(schema.domains);
    await database.delete(schema.fleets);
    expect((await chat("default")).status).toBe(404);

    // A later outage must not resurrect the deleted fleet through the
    // uuid alias.
    breakIt();
    const byUuid = await chat(fleetId);
    expect(byUuid.status).toBe(503);
    expect(chatCalls).toHaveLength(1);
  });

  it("reaches the cache with an UPPERCASE uuid (the store accepts either case)", async () => {
    const chatCalls: FakeUpstreamCall[] = [];
    const { chat, breakIt } = failOpenApp({ chatCalls });
    const fleetId = (await getFleetSnapshot(database, "default"))!.id;
    expect((await chat("default")).status).toBe(200);

    // Cache keys are the canonical lowercase ids Postgres returns, but
    // a uuid reference is valid in any case: both must resolve.
    breakIt();
    const upper = await chat(fleetId.toUpperCase());
    expect(upper.status).toBe(200);
    expect(upper.headers.get("x-haru-routing")).toBe("stale");
    expect(chatCalls[1]?.url).toBe(`${ALPHA_SERVING}/v1/chat/completions`);
  });

  it("evicts a slug-warmed cache when the deletion is observed through the uuid", async () => {
    const chatCalls: FakeUpstreamCall[] = [];
    const { chat, breakIt } = failOpenApp({ chatCalls });
    const fleetId = (await getFleetSnapshot(database, "default"))!.id;
    expect((await chat("default")).status).toBe(200);

    await database.delete(schema.slots);
    await database.delete(schema.domains);
    await database.delete(schema.fleets);

    // The healthy request that observes the deletion uses the UUID form,
    // which no alias points at (the cache was warmed through the slug):
    // it must still evict the entry, which is keyed BY that uuid.
    expect((await chat(fleetId)).status).toBe(404);

    breakIt();
    const bySlug = await chat("default");
    expect(bySlug.status).toBe(503);
    expect(chatCalls).toHaveLength(1);
  });

  it("does not let an UPPERCASE uuid resolve a lowercase UUID-shaped slug", async () => {
    const chatCalls: FakeUpstreamCall[] = [];
    const { chat } = failOpenApp({ chatCalls });
    // A fleet whose SLUG is a uuid string that is nobody's id.
    const uuidSlug = "0f5c2f5e-9d55-4b5e-8f8e-1c2d3e4f5a6b";
    const slugOwner = testLayout() as { slug: string };
    slugOwner.slug = uuidSlug;
    await applyFleetLayout(database, slugOwner);

    // The store's slug fallback is case-SENSITIVE (slugs are lowercase by
    // schema), so the uppercase spelling names no fleet: it must 404, not
    // route to the lowercase slug's owner.
    const response = await chat(uuidSlug.toUpperCase());
    expect(response.status).toBe(404);
    expect(chatCalls).toHaveLength(0);
    // The lowercase form still resolves.
    expect((await chat(uuidSlug)).status).toBe(200);
  });

  it("keeps the slug owner's cache when an UPPERCASE spelling of its uuid-shaped slug 404s", async () => {
    const chatCalls: FakeUpstreamCall[] = [];
    const { chat, breakIt } = failOpenApp({ chatCalls });
    const uuidSlug = "0f5c2f5e-9d55-4b5e-8f8e-1c2d3e4f5a6b";
    const slugOwner = testLayout() as { slug: string };
    slugOwner.slug = uuidSlug;
    await applyFleetLayout(database, slugOwner);

    // Warm through the exact spelling the store matches.
    expect((await chat(uuidSlug)).status).toBe(200);

    // The uppercase spelling names no fleet (the id probe misses in any
    // case, the slug fallback is case-sensitive). That verdict is about
    // the UPPERCASE string only: it must not evict the live fleet that
    // owns the lowercase slug, or one 404-producing request would strip
    // the fleet's outage protection.
    expect((await chat(uuidSlug.toUpperCase())).status).toBe(404);

    breakIt();
    const stale = await chat(uuidSlug);
    expect(stale.status).toBe(200);
    expect(stale.headers.get("x-haru-routing")).toBe("stale");
    expect(chatCalls).toHaveLength(2);
  });

  it("does not resolve an UPPERCASE spelling of a uuid-shaped slug during an outage", async () => {
    const chatCalls: FakeUpstreamCall[] = [];
    const { chat, breakIt } = failOpenApp({ chatCalls });
    const uuidSlug = "0f5c2f5e-9d55-4b5e-8f8e-1c2d3e4f5a6b";
    const slugOwner = testLayout() as { slug: string };
    slugOwner.slug = uuidSlug;
    await applyFleetLayout(database, slugOwner);
    expect((await chat(uuidSlug)).status).toBe(200);

    // The healthy store 404s this exact spelling (case-sensitive slug
    // match), so fail-open must not invent a resolution for it: serving
    // stale preserves known routing, it does not widen the reference
    // grammar.
    breakIt();
    expect((await chat(uuidSlug.toUpperCase())).status).toBe(503);
    // The spelling the store actually matched still fails open.
    expect((await chat(uuidSlug)).status).toBe(200);
    expect(chatCalls).toHaveLength(2);
  });

  it("forgets the previous fleet when a slug is rebound to a new one", async () => {
    const chatCalls: FakeUpstreamCall[] = [];
    const { chat, breakIt } = failOpenApp({ chatCalls });
    const goneId = (await getFleetSnapshot(database, "default"))!.id;
    expect((await chat("default")).status).toBe(200);

    // The fleet is deleted and a NEW one takes its slug.
    await database.delete(schema.slots);
    await database.delete(schema.domains);
    await database.delete(schema.fleets);
    const replacement = testLayout() as {
      slug: string;
      activeDomainSlug: string;
    };
    replacement.activeDomainSlug = "beta";
    await applyFleetLayout(database, replacement);
    expect((await chat("default")).status).toBe(200);
    expect(chatCalls[1]?.url).toBe(`${BETA_SERVING}/v1/chat/completions`);

    // The old fleet is unreachable by any live reference, but it is still
    // keyed by its id: an outage request for that uuid must not resurrect
    // it through the id-first fast path.
    breakIt();
    expect((await chat(goneId)).status).toBe(503);
    expect(chatCalls).toHaveLength(2);
  });

  it("forgets a fleet whose UUID-SHAPED SLUG the store reports gone", async () => {
    const chatCalls: FakeUpstreamCall[] = [];
    const { chat, breakIt } = failOpenApp({ chatCalls });
    const uuidSlug = "0f5c2f5e-9d55-4b5e-8f8e-1c2d3e4f5a6b";
    const slugOwner = testLayout() as { slug: string };
    slugOwner.slug = uuidSlug;
    await applyFleetLayout(database, slugOwner);
    const fleetId = (await getFleetSnapshot(database, uuidSlug))!.id;

    // Warmed through its ID, so its uuid-shaped slug is never aliased
    // (that would shadow an id owner): only the snapshot knows the slug.
    expect((await chat(fleetId)).status).toBe(200);

    await database.delete(schema.slots);
    await database.delete(schema.domains);
    await database.delete(schema.fleets);

    // The deletion is observed through the SLUG. The entry is keyed by
    // the id, so nothing but the cached snapshot's own slug can connect
    // the two.
    expect((await chat(uuidSlug)).status).toBe(404);

    breakIt();
    expect((await chat(fleetId)).status).toBe(503);
    expect(chatCalls).toHaveLength(1);
  });

  it("quarantines the old id owner when a uuid reference falls through to a slug", async () => {
    const chatCalls: FakeUpstreamCall[] = [];
    const { chat, breakIt } = failOpenApp({ chatCalls });
    const goneId = (await getFleetSnapshot(database, "default"))!.id;
    expect((await chat("default")).status).toBe(200);
    expect(chatCalls[0]?.url).toBe(`${ALPHA_SERVING}/v1/chat/completions`);

    // The id owner is deleted and a DIFFERENT fleet takes that string as
    // its slug (the slug charset admits UUID-shaped slugs). Its active
    // domain is beta, so the two fleets are distinguishable by the
    // upstream they route to.
    await database.delete(schema.slots);
    await database.delete(schema.domains);
    await database.delete(schema.fleets);
    const slugOwner = testLayout() as {
      slug: string;
      activeDomainSlug: string;
    };
    slugOwner.slug = goneId;
    slugOwner.activeDomainSlug = "beta";
    await applyFleetLayout(database, slugOwner);

    // Healthy: the id lookup finds nothing, so the string resolves by
    // slug to the new fleet.
    expect((await chat(goneId)).status).toBe(200);
    expect(chatCalls[1]?.url).toBe(`${BETA_SERVING}/v1/chat/completions`);

    // During an outage the id-first fast path must NOT resurrect the
    // deleted fleet that used to own the id.
    breakIt();
    const stale = await chat(goneId);
    expect(stale.status).toBe(200);
    expect(stale.headers.get("x-haru-routing")).toBe("stale");
    expect(chatCalls[2]?.url).toBe(`${BETA_SERVING}/v1/chat/completions`);
  });

  it("keeps id-first resolution when another fleet's slug is UUID-shaped", async () => {
    const chatCalls: FakeUpstreamCall[] = [];
    const { chat, breakIt, heal } = failOpenApp({ chatCalls });
    const idOwner = (await getFleetSnapshot(database, "default"))!.id;

    // A second fleet whose SLUG is the first fleet's ID (the slug charset
    // admits UUID-shaped slugs), routable to beta so the two fleets are
    // distinguishable by the upstream they proxy to.
    const collidingLayout = testLayout() as {
      slug: string;
      activeDomainSlug: string;
    };
    collidingLayout.slug = idOwner;
    collidingLayout.activeDomainSlug = "beta";
    await applyFleetLayout(database, collidingLayout);
    const collidingId = (await database.select().from(schema.fleets)).find(
      (fleet) => fleet.slug === idOwner,
    )!.id;

    // Warm ONLY the slug owner, through its own id (its slug is shadowed
    // by the id owner in the healthy lookup, so this is the only spelling
    // that reaches it).
    expect((await chat(collidingId)).status).toBe(200);
    expect(chatCalls[0]?.url).toBe(`${BETA_SERVING}/v1/chat/completions`);

    // The string is a fleet ID first, and the id owner was never cached:
    // serving the slug owner instead would route the id owner's traffic
    // to the wrong fleet, so fail-open must have nothing for it.
    breakIt();
    expect((await chat(idOwner)).status).toBe(503);

    // Warm the id owner too: the same outage request now serves IT (the
    // seeded default fleet on alpha), never the slug owner on beta.
    heal();
    expect((await chat(idOwner)).status).toBe(200);
    expect(chatCalls[1]?.url).toBe(`${ALPHA_SERVING}/v1/chat/completions`);
    breakIt();
    const stale = await chat(idOwner);
    expect(stale.status).toBe(200);
    expect(stale.headers.get("x-haru-routing")).toBe("stale");
    expect(chatCalls[2]?.url).toBe(`${ALPHA_SERVING}/v1/chat/completions`);
  });

  it("fails CLOSED on malformed persisted state instead of masking it", async () => {
    const chatCalls: FakeUpstreamCall[] = [];
    let nowMs = Date.now();
    const { chat } = failOpenApp({
      chatCalls,
      nowMs: () => nowMs,
      snapshotCacheTtlMs: 1000,
    });
    expect((await chat()).status).toBe(200);

    // The store is reachable but a slot's spec jsonb is corrupt, which
    // the repo layer deliberately surfaces (fleetSnapshotSchema.parse).
    // Serving stale routing on top would hide a broken fleet forever.
    await database
      .update(schema.slots)
      .set({ spec: { kind: "bogus" } as unknown as SlotSpec });
    nowMs += 1001;
    const response = await chat();
    expect(response.status).toBe(503);
    expect(
      ((await response.json()) as { error: { code: string } }).error.code,
    ).toBe("state_store_unavailable");
    expect(chatCalls).toHaveLength(1);
  });

  it("does not let a failed reload evict the fresh entry a concurrent request cached", async () => {
    const chatCalls: FakeUpstreamCall[] = [];
    const { chat, breakIt, gateSelect } = failOpenApp({ chatCalls });
    expect((await chat()).status).toBe(200);

    // A promotion commits: revision 2, beta serving.
    const snapshot = await getFleetSnapshot(database, "default");
    const alphaId = snapshot!.domains.find((d) => d.slug === "alpha")!.id;
    const betaId = snapshot!.domains.find((d) => d.slug === "beta")!.id;
    await switchActive(database, snapshot!.id, alphaId, betaId);
    for (const [from, to] of [
      ["sleeping", "waking"],
      ["waking", "probing"],
      ["probing", "serving"],
    ] as const) {
      await transitionDomainSlots(database, betaId, "inference", [from], to);
    }

    // Request A reads the moved pointer, then freezes inside its snapshot
    // load (access 1 = pointer read, access 2 = fleet row).
    const gate = gateSelect(2);
    const requestA = chat();
    await gate.reached;

    // Request B completes the full healthy cycle meanwhile and caches the
    // fresh revision-2 snapshot.
    expect((await chat()).status).toBe(200);
    expect(chatCalls[1]?.url).toBe(`${BETA_SERVING}/v1/chat/completions`);

    // A's load now fails. Judging by the entry A saw BEFORE its load
    // would quarantine (and 503 past) B's fresh entry; the entry cached
    // NOW matches the pointer A read, so A must serve it and keep it.
    gate.fail();
    const responseA = await requestA;
    expect(responseA.status).toBe(200);
    expect(responseA.headers.get("x-haru-routing")).toBe("stale");
    expect(chatCalls[2]?.url).toBe(`${BETA_SERVING}/v1/chat/completions`);

    // The fresh entry survived: a full outage still fails open.
    breakIt();
    const outage = await chat();
    expect(outage.status).toBe(200);
    expect(outage.headers.get("x-haru-routing")).toBe("stale");
    expect(chatCalls[3]?.url).toBe(`${BETA_SERVING}/v1/chat/completions`);
  });

  it("does not let a slow reload overwrite a newer revision cached concurrently", async () => {
    const chatCalls: FakeUpstreamCall[] = [];
    let nowMs = Date.now();
    const { chat, breakIt, gateSelect } = failOpenApp({
      chatCalls,
      nowMs: () => nowMs,
      snapshotCacheTtlMs: 1000,
    });
    expect((await chat()).status).toBe(200);

    // TTL expiry forces a reload at the UNMOVED pointer: request A reads
    // the revision-1 fleet row, then freezes before its domain query
    // (accesses: 1 pointer, 2 fleet row, 3 subquery builder, 4 domains).
    nowMs += 1001;
    const gate = gateSelect(4);
    const requestA = chat();
    await gate.reached;

    // A promotion commits (revision 2, beta serving) and request B caches
    // the fresh revision-2 snapshot.
    const snapshot = await getFleetSnapshot(database, "default");
    const alphaId = snapshot!.domains.find((d) => d.slug === "alpha")!.id;
    const betaId = snapshot!.domains.find((d) => d.slug === "beta")!.id;
    await switchActive(database, snapshot!.id, alphaId, betaId);
    for (const [from, to] of [
      ["sleeping", "waking"],
      ["waking", "probing"],
      ["probing", "serving"],
    ] as const) {
      await transitionDomainSlots(database, betaId, "inference", [from], to);
    }
    expect((await chat()).status).toBe(200);
    expect(chatCalls[1]?.url).toBe(`${BETA_SERVING}/v1/chat/completions`);

    // A's stale (revision-1) load completes LAST. Last-completer-wins
    // would put the superseded routing back into the fail-open cache.
    gate.proceed();
    expect((await requestA).status).toBe(200);

    breakIt();
    const outage = await chat();
    expect(outage.status).toBe(200);
    expect(outage.headers.get("x-haru-routing")).toBe("stale");
    // The newer revision won: outage traffic follows the promotion.
    expect(chatCalls[3]?.url).toBe(`${BETA_SERVING}/v1/chat/completions`);
  });

  it("does not re-publish a snapshot loaded before the fleet was forgotten", async () => {
    const chatCalls: FakeUpstreamCall[] = [];
    let nowMs = Date.now();
    const { chat, breakIt, gateSelect } = failOpenApp({
      chatCalls,
      nowMs: () => nowMs,
      snapshotCacheTtlMs: 1000,
    });
    expect((await chat()).status).toBe(200);

    // TTL expiry forces a reload: request A reads the fleet row, then
    // freezes before its domain query.
    nowMs += 1001;
    const gate = gateSelect(4);
    const requestA = chat();
    await gate.reached;

    // The fleet is deleted, and request B observes it: 404 plus a
    // wholesale forget of the entry and its aliases.
    await database.delete(schema.slots);
    await database.delete(schema.domains);
    await database.delete(schema.fleets);
    expect((await chat()).status).toBe(404);

    // A's pre-deletion read completes LAST. Publishing it would put the
    // deleted fleet's entry (and its alias) back for fail-open to serve.
    gate.proceed();
    expect((await requestA).status).toBe(503);

    breakIt();
    const outage = await chat();
    expect(outage.status).toBe(503);
    // state_store_unavailable = nothing cached (correct); a resurrected
    // entry would surface as no_active_domain served stale instead.
    expect(
      ((await outage.json()) as { error: { code: string } }).error.code,
    ).toBe("state_store_unavailable");
    expect(outage.headers.get("x-haru-routing")).toBeNull();
    expect(chatCalls).toHaveLength(1);
  });

  it("never caches a slug-fallback snapshot under the id the pointer named", async () => {
    const chatCalls: FakeUpstreamCall[] = [];
    const { chat, breakIt, gateSelect } = failOpenApp({ chatCalls });
    const goneId = (await getFleetSnapshot(database, "default"))!.id;

    // Request A resolves the pointer to the id owner, then freezes before
    // its snapshot load (access 1 = pointer read by id, access 2 = fleet
    // row).
    const gate = gateSelect(2);
    const requestA = chat(goneId);
    await gate.reached;

    // The id owner is deleted and a DIFFERENT fleet takes the string as
    // its slug.
    await database.delete(schema.slots);
    await database.delete(schema.domains);
    await database.delete(schema.fleets);
    const slugOwner = testLayout() as {
      slug: string;
      activeDomainSlug: string;
    };
    slugOwner.slug = goneId;
    slugOwner.activeDomainSlug = "beta";
    await applyFleetLayout(database, slugOwner);

    // A's fleet-row read now falls through to the slug owner: a snapshot
    // that does NOT belong to the id A's pointer named. Cached under that
    // id it would be invisible to every eviction (the owner's uuid-shaped
    // slug is never aliased and its own id differs), so A must drop it.
    gate.proceed();
    expect((await requestA).status).toBe(404);

    breakIt();
    // Nothing was poisoned: the id resolves to nothing during the outage,
    // not to the slug owner's routing under the wrong key.
    expect((await chat(goneId)).status).toBe(503);
    expect(chatCalls).toHaveLength(0);
  });
});
