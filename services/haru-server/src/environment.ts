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

/** Server boot environment. Only main.ts reads this; the app factory
 * takes explicit dependencies so tests never touch process.env. */
export const serverEnvironmentSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8700),
  HARU_API_TOKEN: z.string().optional(),
  HARU_SUPERVISOR_TOKEN: z.string().optional(),
  HARU_DEFAULT_FLEET: blankableStringSchema,
  /** TTFB bound for the chat proxy; raise for long non-streaming
   * completions (headers arrive only after full generation). */
  HARU_CHAT_HEADER_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(2_147_483_647)
    .optional(),
  /** Fleet snapshot cache TTL for the chat hot path (default 2000).
   * Pointer moves surface immediately regardless (per-request route
   * revision check); this only bounds slot-state staleness. */
  HARU_SNAPSHOT_CACHE_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(2_147_483_647)
    .optional(),
  /** Max chat request body size in bytes (413 above it; default 32
   * MiB). Raise for very large multimodal or long-context payloads. */
  HARU_CHAT_MAX_BODY_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(2_147_483_647)
    .optional(),
  /** Reconcile loop interval; unset disables the background loop. */
  HARU_RECONCILE_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(2_147_483_647)
    .optional(),
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
