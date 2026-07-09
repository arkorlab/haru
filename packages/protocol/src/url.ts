/**
 * Join an absolute-style API path onto a base URL while PRESERVING the
 * base URL's path prefix. `new URL("/v1/x", base)` silently discards
 * any path on `base` (absolute-path resolution keeps only the origin),
 * which misroutes deployments behind path-routing gateways; every
 * outbound haru call goes through this helper instead.
 */
export function joinUrl(baseUrl: string, path: string): string {
  const base = new URL(baseUrl);
  const prefix = base.pathname.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return new URL(`${prefix}${suffix}`, base).href;
}
