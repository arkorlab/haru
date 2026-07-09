import { z } from "zod";

/** Server boot environment. Only main.ts reads this; the app factory
 * takes explicit dependencies so tests never touch process.env. */
export const serverEnvironmentSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8700),
  HARU_API_TOKEN: z.string().optional(),
  HARU_SUPERVISOR_TOKEN: z.string().optional(),
  HARU_DEFAULT_FLEET: z.string().optional(),
  /** TTFB bound for the chat proxy; raise for long non-streaming
   * completions (headers arrive only after full generation). */
  HARU_CHAT_HEADER_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  /** Reconcile loop interval; unset disables the background loop. */
  HARU_RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().optional(),
  /** Fleets the background loop reconciles (comma-separated slugs). */
  HARU_RECONCILE_FLEETS: z.string().optional(),
});
export type ServerEnvironment = z.infer<typeof serverEnvironmentSchema>;

export function loadServerEnvironment(
  environment: NodeJS.ProcessEnv,
): ServerEnvironment {
  return serverEnvironmentSchema.parse(environment);
}
