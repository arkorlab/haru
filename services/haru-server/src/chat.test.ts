import {
  applyFleetLayout,
  getFleetSnapshot,
  switchActive,
  transitionDomainSlots,
} from "@haru/db";
import { createTestDatabase } from "@haru/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
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
}) {
  return createApp({
    database,
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
