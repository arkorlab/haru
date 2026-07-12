import { errorBody, fetchWithTimeout, joinUrl } from "@haru/protocol";

/** Default bound on the wait for upstream response headers (TTFB). */
export const DEFAULT_CHAT_HEADER_TIMEOUT_MS = 30_000;

/**
 * Default chat request-body cap (32 MiB). Generous enough for long
 * contexts and base64 multimodal payloads, but bounds the per-request
 * buffer the proxy has to hold to extract `model` and forward the body
 * verbatim. Override with HARU_CHAT_MAX_BODY_BYTES.
 */
export const DEFAULT_CHAT_MAX_BODY_BYTES = 32 * 1024 * 1024;

export type ChatProxyResult =
  | { ok: true; response: Response }
  | { ok: false; status: 502 | 504; body: ReturnType<typeof errorBody> }
  /**
   * The CLIENT disconnected before upstream headers arrived; the
   * upstream request was aborted with it. There is nobody left to
   * answer, so there is no error body (the route returns a bare
   * nginx-style 499 for logs/tests).
   */
  | { ok: false; status: 499; body: null };

/**
 * Forward an OpenAI-compatible chat completion to a serving URL and
 * return the upstream response as-is (streaming passthrough).
 *
 * The abort timer bounds only the pre-header wait: once headers
 * arrive it is cleared, so a long SSE body is never cut mid-stream
 * (a mid-stream client disconnect still propagates by cancelling the
 * passthrough body). `clientSignal` (the incoming request's signal)
 * aborts the upstream fetch when the client goes away pre-headers, so
 * an abandoned request does not keep generating for a full TTFB
 * window. The body text is forwarded verbatim: unknown OpenAI params
 * and vendor extensions survive untouched.
 */
export async function proxyChatCompletion(
  fetchFunction: typeof fetch,
  servingUrl: string,
  bodyText: string,
  headerTimeoutMs: number,
  clientSignal?: AbortSignal,
): Promise<ChatProxyResult> {
  // joinUrl preserves any path prefix on servingUrl (deployments
  // behind path-routing gateways); `new URL("/x", base)` would drop it.
  const url = joinUrl(servingUrl, "/v1/chat/completions");
  let upstream: Response;
  try {
    upstream = await fetchWithTimeout(
      fetchFunction,
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: bodyText,
      },
      headerTimeoutMs,
      clientSignal,
    );
  } catch (error) {
    // Undici aborts surface as DOMException, not Error subclasses;
    // match on the name instead of instanceof. fetchWithTimeout's own
    // timer aborts with a TimeoutError, which distinguishes "we gave
    // up" from "the client went away".
    const abortName =
      typeof error === "object" && error !== null && "name" in error
        ? error.name
        : undefined;
    if (abortName === "TimeoutError") {
      return {
        ok: false,
        status: 504,
        body: errorBody(
          "upstream_timeout",
          `upstream did not return headers within ${headerTimeoutMs}ms`,
        ),
      };
    }
    if (abortName === "AbortError" || clientSignal?.aborted === true) {
      return { ok: false, status: 499, body: null };
    }
    // undici's own headers timer surfaces as TypeError("fetch failed")
    // with a coded cause. It is a timeout, not unreachability, so it
    // maps to 504 like our own timer. Dead in the default wiring (the
    // injected chat fetch disables that timer entirely; see
    // chat-fetch.ts) but embedders passing a plain global fetch with a
    // TTFB bound above undici's 300s still get the honest status.
    const cause =
      typeof error === "object" && error !== null && "cause" in error
        ? error.cause
        : undefined;
    const causeCode =
      typeof cause === "object" && cause !== null && "code" in cause
        ? cause.code
        : undefined;
    if (causeCode === "UND_ERR_HEADERS_TIMEOUT") {
      return {
        ok: false,
        status: 504,
        body: errorBody(
          "upstream_timeout",
          "upstream did not return headers within the transport's own bound",
        ),
      };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: 502,
      body: errorBody(
        "upstream_unreachable",
        `upstream unreachable: ${detail}`,
      ),
    };
  }

  // Re-emit the upstream body untouched. Copy only the content type:
  // upstream server/transport headers must not leak to clients.
  const headers = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType !== null) {
    headers.set("content-type", contentType);
  }
  return {
    ok: true,
    response: new Response(upstream.body, {
      status: upstream.status,
      headers,
    }),
  };
}
