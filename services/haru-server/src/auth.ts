import { createHash, timingSafeEqual } from "node:crypto";

import { errorBody } from "@haru/protocol";

import type { MiddlewareHandler } from "hono";

/** Length-equalising constant-time comparison of two secrets. */
export function isSameSecret(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * Bearer-token gate for the public API. When no token is configured
 * the API is open (local development only); the caller is expected to
 * log a loud warning at boot in that case.
 */
export function bearerAuth(
  expectedToken: string | undefined,
): MiddlewareHandler {
  return async (c, next) => {
    if (expectedToken === undefined || expectedToken === "") {
      await next();
      return;
    }
    const header = c.req.header("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (presented === "" || !isSameSecret(presented, expectedToken)) {
      return c.json(
        errorBody("unauthorized", "invalid or missing bearer token"),
        401,
      );
    }
    await next();
  };
}
