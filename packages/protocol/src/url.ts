/**
 * Join an absolute-style API path onto a base URL while PRESERVING the
 * base URL's path prefix AND query string. `new URL("/v1/x", base)`
 * silently discards any path on `base` (absolute-path resolution keeps
 * only the origin) and always drops the base's query, which misroutes
 * deployments behind path-routing gateways and strips required base
 * query params (e.g. an `?api-version=...` on a serving URL); every
 * outbound haru call goes through this helper instead.
 *
 * A query the caller puts on `path` (e.g. `/sleep?level=1`) wins over a
 * same-named base param; other base params ride through unchanged.
 */
export function joinUrl(baseUrl: string, path: string): string {
  const base = new URL(baseUrl);
  const prefix = base.pathname.replace(/\/+$/, "");
  // The WHATWG URL parser STRIPS ASCII tab (0x09), LF (0x0A) and CR
  // (0x0D) from a URL string before it parses the authority, so a
  // `path` like `\t//evil.example/x` or `/\t/evil.example/x` would fuse
  // its remaining slashes into a `//` protocol-relative reference AFTER
  // the leading-slash collapse below and swap the base's origin. Remove
  // them up front so the collapse sees the real structure.
  const withoutUrlWhitespace = path.replaceAll(/[\t\n\r]/g, "");
  // Collapse any leading slashes AND backslashes to exactly one forward
  // slash. A `path` like `//evil.example/x` - or `\\evil.example/x`,
  // which the WHATWG URL parser normalizes to `//` on http/https - would
  // otherwise be parsed as protocol-relative and swap the base's
  // host/origin against an origin-only base. Every caller passes a
  // code-literal path today, so this is defense in depth.
  const suffix = `/${withoutUrlWhitespace.replace(/^[\\/]+/, "")}`;
  const joined = new URL(`${prefix}${suffix}`, base);
  // Final backstop: joinUrl must NEVER change the origin (it only
  // appends a path/query onto the base). Anything that still moved the
  // host - a `//host` pathname on the base itself, or any residual
  // protocol-relative fusion the collapse missed - is a
  // misconfiguration or an injection attempt, not a routable URL; fail
  // closed rather than emit a request to the wrong host.
  if (joined.origin !== base.origin) {
    throw new Error(
      `joinUrl refused to change origin (${base.origin} -> ${joined.origin})`,
    );
  }
  // Re-apply the base query params that `new URL` dropped. Snapshot the
  // path's OWN keys first so a same-named base param is skipped (path
  // wins on conflict) while EVERY value the base carries for other keys
  // is preserved - including repeats like `?tag=a&tag=b` (a plain
  // `has()` check inside the loop would drop the second `tag`).
  const pathKeys = new Set(joined.searchParams.keys());
  for (const [key, value] of base.searchParams) {
    if (!pathKeys.has(key)) {
      joined.searchParams.append(key, value);
    }
  }
  return joined.href;
}

/** Normalise any fetch input shape to its target URL string. */
export function requestTargetUrl(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}
