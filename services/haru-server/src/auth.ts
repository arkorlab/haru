import { isBearerTokenValid, errorBody } from "@haru/protocol";

import type { MiddlewareHandler } from "hono";

/**
 * Bearer-token gate for the public API. When no token is configured
 * the API is open (local development only); the caller is expected to
 * log a loud warning at boot in that case. The comparison itself lives
 * in @haru/protocol so both services share one hardened path.
 */
export function bearerAuth(
  expectedToken: string | undefined,
): MiddlewareHandler {
  return async (c, next) => {
    if (!isBearerTokenValid(c.req.header("authorization"), expectedToken)) {
      return c.json(
        errorBody("unauthorized", "invalid or missing bearer token"),
        401,
      );
    }
    await next();
  };
}
