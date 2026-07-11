import { Agent } from "undici";

import type { Dispatcher } from "undici";

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
  // `dispatcher` is undici's own extension of fetch's RequestInit
  // (honored by Node's bundled fetch, invisible to the standard type),
  // so the init is typed as the intersection: a plain structural
  // subtype, no assertion. The spread puts our dispatcher last on
  // purpose: a caller-supplied one would reintroduce the very defaults
  // this module exists to remove, so the chat dispatcher wins by
  // construction. chat-fetch.test.ts proves at runtime that the
  // option actually reaches the wire.
  return (input, init) => {
    const withDispatcher: RequestInit & { dispatcher: Dispatcher } = {
      ...init,
      dispatcher,
    };
    return fetch(input, withDispatcher);
  };
}
