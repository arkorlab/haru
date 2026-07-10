/**
 * Shared HTTP scaffolding for haru's outbound calls and request-body
 * parsing. Kept dependency-free (fetch + AbortController only) so the
 * supervisor's protocol-only dependency rule holds.
 */

function timeoutSignal(
  timeoutMs: number,
  extraSignal: AbortSignal | undefined,
  initSignal: AbortSignal | null | undefined,
): { signal: AbortSignal; timer: ReturnType<typeof setTimeout> } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(
      new DOMException(`no response within ${timeoutMs}ms`, "TimeoutError"),
    );
  }, timeoutMs);
  const signals = [controller.signal];
  if (extraSignal) {
    signals.push(extraSignal);
  }
  // A signal the caller put in `init` (the standard fetch idiom) must
  // compose, not be silently discarded.
  if (initSignal) {
    signals.push(initSignal);
  }
  return {
    signal: signals.length === 1 ? controller.signal : AbortSignal.any(signals),
    timer,
  };
}

/**
 * fetch with a wall-clock bound until the response HEADERS arrive.
 * The returned Response's body is NOT bounded: the timer is cleared as
 * soon as fetch resolves, so streaming bodies are never cut. Callers
 * that consume a small JSON body and need the WHOLE call bounded must
 * use `fetchJsonWithTimeout` instead.
 *
 * The internal timer aborts with a DOMException named "TimeoutError"
 * so callers can distinguish "we gave up" (map to 504) from an
 * `extraSignal` abort (e.g. the client disconnected). Implemented with
 * setTimeout + abort(reason) rather than AbortSignal.timeout so tests
 * can drive it with fake timers.
 */
export async function fetchWithTimeout(
  fetchFunction: typeof fetch,
  input: string | URL | Request,
  init: RequestInit,
  timeoutMs: number,
  extraSignal?: AbortSignal,
): Promise<Response> {
  const { signal, timer } = timeoutSignal(timeoutMs, extraSignal, init.signal);
  try {
    return await fetchFunction(input, { ...init, signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * fetch a small JSON control response with ONE timer bounding both the
 * header wait AND the body read: a peer that returns headers and then
 * stalls the body must not hang the caller past its budget. On a
 * non-2xx response the body is left unread (`body: undefined`) so the
 * caller can map the status itself.
 */
export async function fetchJsonWithTimeout(
  fetchFunction: typeof fetch,
  input: string | URL | Request,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ response: Response; body: unknown }> {
  const { signal, timer } = timeoutSignal(timeoutMs, undefined, init.signal);
  try {
    const response = await fetchFunction(input, { ...init, signal });
    if (!response.ok) {
      return { response, body: undefined };
    }
    return { response, body: (await response.json()) as unknown };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse a JSON request body from anything exposing `json()` (a web
 * Request, or Hono's `c.req`), mapping malformed/absent JSON to the
 * given fallback. Only suitable when the fallback FAILS downstream
 * validation (haru-server passes `null` and its request schemas have
 * required fields): for all-optional schemas use
 * `readOptionalJsonBody`, which distinguishes empty from malformed.
 */
export async function readJsonBody(
  source: { json: () => Promise<unknown> },
  fallback: unknown,
): Promise<unknown> {
  try {
    return await source.json();
  } catch {
    return fallback;
  }
}

/**
 * Parse an OPTIONAL JSON request body: a genuinely empty body yields
 * `emptyFallback` (all-optional schemas accept body-less POSTs), but
 * malformed non-empty JSON is reported as such so the route can 400.
 * Without the distinction, a truncated targeted body (e.g. one meant
 * to carry a gpuIndex) would silently parse as "target everything".
 */
export async function readOptionalJsonBody(
  source: { text: () => Promise<string> },
  emptyFallback: unknown,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  let text: string;
  try {
    text = await source.text();
  } catch {
    return { ok: false };
  }
  if (text.trim() === "") {
    return { ok: true, value: emptyFallback };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}
