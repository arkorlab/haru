import { Agent, fetch as undiciFetch } from "undici";

/**
 * Undici timeout overrides for the chat proxy's dispatcher. Values are
 * milliseconds; 0 disables the timer (undici's convention). Exposed so
 * tests can prove the options reach the wire with sub-second values;
 * production callers use the defaults.
 */
export interface ChatFetchOptions {
  /** Bound on the wait for response headers (default 0 = disabled). */
  headersTimeoutMs?: number;
  /** Idle bound between body chunks (default 0 = disabled). */
  bodyTimeoutMs?: number;
}

/**
 * A fetch for the chat proxy whose transport-level timeouts are OWNED
 * BY HARU, not by undici's defaults.
 *
 * Node's bundled fetch enforces its own 300s headersTimeout: a
 * HARU_CHAT_HEADER_TIMEOUT_MS above that used to die at 300s with a
 * generic "fetch failed" TypeError, which the proxy mapped to 502
 * upstream_unreachable instead of 504. Long non-streaming completions
 * (headers arrive only after full generation) hit this for real. The
 * dedicated Agent disables undici's headers timer; the proxy's own
 * fetchWithTimeout timer is then the single, exact TTFB bound at any
 * configured value.
 *
 * bodyTimeout is disabled for the same reason: it is an IDLE timer
 * between body chunks (also 300s by default), so a streaming
 * completion that goes quiet mid-generation (long tool call, reasoning
 * pause, batched scheduler) would be severed mid-stream. That breaks
 * the proxy's documented contract that a long SSE body is never cut.
 * A client disconnect still tears the upstream down through the
 * passthrough body cancellation, so nothing generates for a dead peer.
 *
 * Only the chat proxy uses this fetch. Control-plane calls keep the
 * global fetch: every one of them runs under fetchJsonWithTimeout
 * budgets well below undici's defaults, and inheriting those defaults
 * is a useful backstop there.
 */
export function createChatFetch(options: ChatFetchOptions = {}): typeof fetch {
  const dispatcher = new Agent({
    headersTimeout: options.headersTimeoutMs ?? 0,
    bodyTimeout: options.bodyTimeoutMs ?? 0,
  });
  // undici's OWN fetch, not Node's bundled one: a dispatcher only
  // composes reliably with the fetch of the same undici instance.
  // Node 24's bundled fetch rejects this package's Agent with
  // UND_ERR_INVALID_ARG (Node 26 happens to accept it - exactly the
  // version coupling this avoids). The assertions bridge the undici
  // package's types to the lib's global fetch signature: both describe
  // the same runtime web classes, and the chat proxy only ever passes
  // a string URL, a plain init, and an AbortSignal. The spread puts
  // our dispatcher last on purpose: a caller-supplied one would
  // reintroduce the very defaults this module exists to remove.
  // chat-fetch.test.ts proves at runtime that the options reach the
  // wire.
  return (input, init) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher,
    }) as unknown as Promise<Response>;
}
