import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Length-equalising constant-time comparison of two secrets. Shared by
 * both services' bearer gates; this is a security boundary, so there
 * must be exactly one implementation to harden.
 */
export function isSameSecret(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * Framework-agnostic bearer-token check. An unset/empty expected token
 * means the surface is deliberately open (local development only; the
 * caller is expected to log a loud warning at boot).
 */
export function isBearerTokenValid(
  authorizationHeader: string | undefined,
  expectedToken: string | undefined,
): boolean {
  if (expectedToken === undefined || expectedToken === "") {
    return true;
  }
  const header = authorizationHeader ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  return presented !== "" && isSameSecret(presented, expectedToken);
}
