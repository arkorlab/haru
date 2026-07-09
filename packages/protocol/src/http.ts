/**
 * Shared HTTP scaffolding for haru's outbound calls and request-body
 * parsing. Kept dependency-free (fetch + AbortController only) so the
 * supervisor's protocol-only dependency rule holds.
 */

/**
 * fetch with a wall-clock bound until the response HEADERS arrive.
 * The returned Response's body is NOT bounded: the timer is cleared as
 * soon as fetch resolves, so streaming bodies are never cut.
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
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(
      new DOMException(`no response within ${timeoutMs}ms`, "TimeoutError"),
    );
  }, timeoutMs);
  const signal = extraSignal
    ? AbortSignal.any([controller.signal, extraSignal])
    : controller.signal;
  try {
    return await fetchFunction(input, { ...init, signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse a request body as JSON, mapping malformed/absent JSON to the
 * given fallback. The fallback is load-bearing and differs per caller:
 * haru-server passes `null` (its request schemas have required fields
 * and must reject an empty body), while the supervisor passes `{}`
 * (its schemas are all-optional so a body-less POST is valid).
 */
export async function readJsonBody(
  c: { req: { json: () => Promise<unknown> } },
  fallback: unknown,
): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return fallback;
  }
}
