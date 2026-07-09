import { errorBody, joinUrl } from "@haru/protocol";

/** Default bound on the wait for upstream response headers (TTFB). */
export const DEFAULT_CHAT_HEADER_TIMEOUT_MS = 30_000;

export type ChatProxyResult =
  | { ok: true; response: Response }
  | { ok: false; status: 502 | 504; body: ReturnType<typeof errorBody> };

/**
 * Forward an OpenAI-compatible chat completion to a serving URL and
 * return the upstream response as-is (streaming passthrough).
 *
 * The abort timer bounds only the pre-header wait: once headers
 * arrive it is cleared, so a long SSE body is never cut mid-stream.
 * The body text is forwarded verbatim: unknown OpenAI params and
 * vendor extensions survive untouched.
 */
export async function proxyChatCompletion(
  fetchFunction: typeof fetch,
  servingUrl: string,
  bodyText: string,
  headerTimeoutMs: number,
): Promise<ChatProxyResult> {
  // joinUrl preserves any path prefix on servingUrl (deployments
  // behind path-routing gateways); `new URL("/x", base)` would drop it.
  const url = joinUrl(servingUrl, "/v1/chat/completions");
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, headerTimeoutMs);
  let upstream: Response;
  try {
    upstream = await fetchFunction(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: bodyText,
      signal: controller.signal,
    });
  } catch (error) {
    // Undici aborts surface as DOMException, not Error subclasses;
    // match on the name instead of instanceof.
    const isAbort =
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "AbortError";
    if (isAbort) {
      return {
        ok: false,
        status: 504,
        body: errorBody(
          "upstream_timeout",
          `upstream did not return headers within ${headerTimeoutMs}ms`,
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
  } finally {
    clearTimeout(timer);
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
