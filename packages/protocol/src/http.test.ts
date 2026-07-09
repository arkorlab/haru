import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchWithTimeout, readJsonBody } from "./http.js";

/** A fetch that never answers and rejects with the abort reason. */
const hangingFetch: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      const reason: unknown = init.signal?.reason;
      reject(reason instanceof Error ? reason : new Error("aborted"));
    });
  });

describe("fetchWithTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts with a TimeoutError once the header budget elapses", async () => {
    const pending = fetchWithTimeout(hangingFetch, "https://x.test", {}, 1000);
    void vi.advanceTimersByTimeAsync(1001);
    await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("propagates an extraSignal abort with the caller's reason", async () => {
    const client = new AbortController();
    const pending = fetchWithTimeout(
      hangingFetch,
      "https://x.test",
      {},
      60_000,
      client.signal,
    );
    client.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("clears the timer once headers arrive and never bounds the body", async () => {
    const response = new Response("ok");
    const resolved = await fetchWithTimeout(
      () => Promise.resolve(response),
      "https://x.test",
      {},
      1000,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await resolved.text()).toBe("ok");
  });
});

describe("readJsonBody", () => {
  const failing = { req: { json: () => Promise.reject(new Error("bad")) } };

  it("returns the parsed body when valid", async () => {
    const c = { req: { json: () => Promise.resolve({ a: 1 }) } };
    expect(await readJsonBody(c, null)).toEqual({ a: 1 });
  });

  it("maps malformed JSON to the caller's explicit fallback", async () => {
    expect(await readJsonBody(failing, null)).toBeNull();
    expect(await readJsonBody(failing, {})).toEqual({});
  });
});
