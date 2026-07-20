import { describe, expect, it } from "vitest";

import {
  isSupervisorAuthError,
  SupervisorError,
  supervisorClient,
} from "./supervisor-client.js";

function optionsWith(fetchFunction: typeof fetch) {
  return {
    fetchFn: fetchFunction,
    baseUrl: "https://supervisor.test",
    token: "secret",
    timeoutMs: 1000,
  };
}

async function caughtFrom(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

describe("supervisorClient error normalization", () => {
  it("folds a schema-invalid 200 body into SupervisorError, not ZodError", async () => {
    // A drifted supervisor version must surface as a per-domain call
    // failure the reconciler can contain, never as a raw ZodError that
    // aborts the whole tick.
    const fetchFunction: typeof fetch = () =>
      Promise.resolve(Response.json({ totally: "wrong shape" }));
    await expect(
      supervisorClient.status(optionsWith(fetchFunction)),
    ).rejects.toBeInstanceOf(SupervisorError);
  });

  it("carries the HTTP status so auth failures are distinguishable", async () => {
    const unauthorizedFetch: typeof fetch = () =>
      Promise.resolve(new Response("nope", { status: 401 }));
    const error = await caughtFrom(
      supervisorClient.status(optionsWith(unauthorizedFetch)),
    );
    expect(error).toBeInstanceOf(SupervisorError);
    expect((error as SupervisorError).status).toBe(401);
    expect(isSupervisorAuthError(error)).toBe(true);

    // Network-style failures carry no status and are not auth errors.
    const failingFetch: typeof fetch = () => {
      throw new TypeError("fetch failed");
    };
    const networkError = await caughtFrom(
      supervisorClient.status(optionsWith(failingFetch)),
    );
    expect(isSupervisorAuthError(networkError)).toBe(false);
  });

  it("preserves a path prefix on the supervisor base URL", async () => {
    const seen: string[] = [];
    const recordingFetch: typeof fetch = (input) => {
      seen.push(input instanceof Request ? input.url : String(input));
      return Promise.resolve(Response.json({ slots: [], ready: false }));
    };
    await supervisorClient.status({
      fetchFn: recordingFetch,
      baseUrl: "https://ingress.test/haru-supervisor",
      token: undefined,
      timeoutMs: 1000,
    });
    expect(seen[0]).toBe(
      "https://ingress.test/haru-supervisor/v1/status?timeoutMs=900",
    );
  });

  it("selects layout models and freezes the outer timeout getter once", async () => {
    const seen: string[] = [];
    let timeoutReads = 0;
    const recordingFetch: typeof fetch = (input) => {
      seen.push(input instanceof Request ? input.url : String(input));
      return Promise.resolve(Response.json({ slots: [], ready: false }));
    };
    await supervisorClient.status(
      {
        fetchFn: recordingFetch,
        baseUrl: "https://supervisor.test",
        token: undefined,
        get timeoutMs() {
          timeoutReads += 1;
          return 5000;
        },
      },
      ["example-chat-small", "example-chat-large"],
    );
    expect(timeoutReads).toBe(1);
    expect(seen[0]).toBe(
      "https://supervisor.test/v1/status?model=example-chat-small&model=example-chat-large&timeoutMs=4000",
    );
  });

  it("gives probe completions a shorter inner timeout and selects models", async () => {
    let seenUrl = "";
    let seenBody: unknown;
    const recordingFetch: typeof fetch = (input, init) => {
      seenUrl = input instanceof Request ? input.url : String(input);
      seenBody =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return Promise.resolve(Response.json({ ok: true, results: [] }));
    };
    await supervisorClient.probe(
      {
        fetchFn: recordingFetch,
        baseUrl: "https://supervisor.test",
        token: undefined,
        timeoutMs: 5000,
      },
      "ping",
      4,
      ["example-chat-small"],
    );
    expect(seenUrl).toBe(
      "https://supervisor.test/v1/probe?model=example-chat-small",
    );
    expect(seenBody).toEqual({
      prompt: "ping",
      maxTokens: 4,
      timeoutMs: 4500,
    });
  });

  it("drops only an oversized model selector while preserving timeout budgets", async () => {
    const seen: { url: string; body: unknown }[] = [];
    const recordingFetch: typeof fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      seen.push({
        url,
        body:
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return Promise.resolve(
        url.includes("/v1/status")
          ? Response.json({ slots: [], ready: false })
          : Response.json({ ok: true, results: [] }),
      );
    };
    const options = {
      fetchFn: recordingFetch,
      baseUrl: "https://supervisor.test",
      token: undefined,
      timeoutMs: 5000,
    };
    // The product contract deliberately permits arbitrary model-name
    // lengths. This encoded selector is too large for a safe request
    // line, so the client must use the legacy all-model call instead.
    const oversizedModelName = "x".repeat(5000);

    await supervisorClient.status(options, [oversizedModelName]);
    await supervisorClient.probe(options, "ping", 4, [oversizedModelName]);

    expect(seen[0]).toEqual({
      url: "https://supervisor.test/v1/status?timeoutMs=4000&timeoutKind=inner",
      body: undefined,
    });
    expect(seen[1]).toEqual({
      url: "https://supervisor.test/v1/probe?timeoutKind=inner",
      body: { prompt: "ping", maxTokens: 4, timeoutMs: 4500 },
    });
  });
});
