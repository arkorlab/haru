import { z } from "zod";

/**
 * An optional string env var where a present-but-blank value (empty or
 * whitespace-only, e.g. an unexpanded `$VAR` in a manifest) is treated
 * as unset. Without this, a blank var counts as "present" and shadows a
 * `??` fallback: a blank HARU_RECONCILE_FLEETS would suppress the
 * HARU_DEFAULT_FLEET fallback and leave the reconcile loop iterating no
 * fleets while the interval timer still fires.
 */
const blankableStringSchema = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed === "" ? undefined : trimmed;
  });

/**
 * Wrap a numeric env schema so a present-but-blank value (empty or
 * whitespace-only, e.g. an unexpanded `${VAR}` in a manifest) is treated
 * as unset. Without this, `z.coerce.number()` coerces `""` to 0, which
 * then fails the `.positive()` / `.min(1)` bound and crashes boot with a
 * confusing "must be greater than 0" instead of falling back to the
 * field's default (or staying optional).
 */
function blankableNumber<Schema extends z.ZodType>(schema: Schema) {
  return z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? undefined : value,
    schema,
  );
}

/** Server boot environment. Only main.ts reads this; the app factory
 * takes explicit dependencies so tests never touch process.env. */
export const serverEnvironmentSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: blankableNumber(
    z.coerce.number().int().min(1).max(65_535).default(8700),
  ),
  // Bearer tokens are trimmed and blank-normalised: a whitespace-only or
  // trailing-newline value (common from a secret file) must not count as
  // "set" - it would bind the surface publicly while `\S+`-captured
  // credentials could never match it - and a `secret\n` must resolve to
  // the same `secret` the presented credential carries.
  HARU_API_TOKEN: blankableStringSchema,
  HARU_SUPERVISOR_TOKEN: blankableStringSchema,
  HARU_DEFAULT_FLEET: blankableStringSchema,
  /** TTFB bound for the chat proxy; raise for long non-streaming
   * completions (headers arrive only after full generation). */
  HARU_CHAT_HEADER_TIMEOUT_MS: blankableNumber(
    z.coerce.number().int().positive().max(2_147_483_647).optional(),
  ),
  /** Fleet snapshot cache TTL for the chat hot path (default 2000).
   * Pointer moves surface immediately regardless (per-request route
   * revision check); this only bounds slot-state staleness. */
  HARU_SNAPSHOT_CACHE_TTL_MS: blankableNumber(
    z.coerce.number().int().positive().max(2_147_483_647).optional(),
  ),
  /** Max chat request body size in bytes (413 above it; default 32
   * MiB). Raise for very large multimodal or long-context payloads. */
  HARU_CHAT_MAX_BODY_BYTES: blankableNumber(
    z.coerce.number().int().positive().max(2_147_483_647).optional(),
  ),
  /** Reconcile loop interval; unset disables the background loop. */
  HARU_RECONCILE_INTERVAL_MS: blankableNumber(
    z.coerce.number().int().positive().max(2_147_483_647).optional(),
  ),
  /** Fleets the background loop reconciles (comma-separated slugs). A
   * blank value is treated as unset so it does not shadow the
   * HARU_DEFAULT_FLEET fallback in main.ts. */
  HARU_RECONCILE_FLEETS: blankableStringSchema,
});
export type ServerEnvironment = z.infer<typeof serverEnvironmentSchema>;

export function loadServerEnvironment(
  environment: NodeJS.ProcessEnv,
): ServerEnvironment {
  return serverEnvironmentSchema.parse(environment);
}
