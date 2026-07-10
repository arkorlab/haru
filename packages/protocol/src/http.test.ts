import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchWithTimeout,
  readJsonBody,
  readOptionalJsonBody,
} from "./http.js";

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
  const failing = { json: () => Promise.reject(new Error("bad")) };

  it("returns the parsed body when valid", async () => {
    const source = { json: () => Promise.resolve({ a: 1 }) };
    expect(await readJsonBody(source, null)).toEqual({ a: 1 });
  });

  it("accepts a web-standard Request", async () => {
    const request = new Request("https://x.test", {
      method: "POST",
      body: JSON.stringify({ a: 1 }),
    });
    expect(await readJsonBody(request, null)).toEqual({ a: 1 });
  });

  it("maps malformed JSON to the caller's explicit fallback", async () => {
    expect(await readJsonBody(failing, null)).toBeNull();
    expect(await readJsonBody(failing, {})).toEqual({});
  });
});

describe("readOptionalJsonBody", () => {
  const source = (text: string) => ({ text: () => Promise.resolve(text) });

  it("yields the empty fallback only for a genuinely empty body", async () => {
    expect(await readOptionalJsonBody(source(""), {})).toEqual({
      ok: true,
      value: {},
    });
    expect(await readOptionalJsonBody(source("  \n"), {})).toEqual({
      ok: true,
      value: {},
    });
  });

  it("parses a valid body", async () => {
    expect(await readOptionalJsonBody(source('{"gpuIndex":1}'), {})).toEqual({
      ok: true,
      value: { gpuIndex: 1 },
    });
  });

  it("reports malformed non-empty JSON instead of defaulting", async () => {
    // A truncated targeted body must 400, never silently widen to
    // "target everything".
    expect(await readOptionalJsonBody(source('{"gpuIndex":'), {})).toEqual({
      ok: false,
    });
  });
});
