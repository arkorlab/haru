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
  const suffix = path.startsWith("/") ? path : `/${path}`;
  const joined = new URL(`${prefix}${suffix}`, base);
  // Re-apply the base query params that `new URL` dropped, without
  // overriding any the path set itself.
  for (const [key, value] of base.searchParams) {
    if (!joined.searchParams.has(key)) {
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
