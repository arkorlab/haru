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
    expect(seen[0]).toBe("https://ingress.test/haru-supervisor/v1/status");
  });
});
