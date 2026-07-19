import { blankableNumber, blankableString } from "@haru/protocol";
import { z } from "zod";

/** Supervisor boot environment. Only main.ts reads it at runtime;
 * extracted into this pure module (no import-time side effects) so the
 * blank/trim normalisation can be unit-tested without main.ts's
 * serve()/signal-handler setup. */
export const supervisorEnvironmentSchema = z.object({
  PORT: blankableNumber(
    z.coerce.number().int().min(1).max(65_535).default(8701),
  ),
  // Trimmed and blank-normalised: a whitespace-only token must not count
  // as "set" (it would bind the control plane publicly while no `\S+`
  // credential could match it), and a `secret\n` from a secret file must
  // resolve to the same `secret` the SERVER sends after its own trim.
  HARU_SUPERVISOR_TOKEN: blankableString,
  HARU_SUPERVISOR_CONFIG: z.string().min(1),
});
export type SupervisorEnvironment = z.infer<typeof supervisorEnvironmentSchema>;

export function loadSupervisorEnvironment(
  environment: NodeJS.ProcessEnv,
): SupervisorEnvironment {
  return supervisorEnvironmentSchema.parse(environment);
}

/**
 * The supervisor-private variables that must NEVER reach a trainer
 * child. HARU_SUPERVISOR_TOKEN is the bearer credential for the
 * 0.0.0.0-bound control API (sleep/wake/kill-training): training
 * commands are operator-authored workloads whose tooling routinely
 * captures the process environment into run metadata, telemetry, or
 * crash dumps, so inheriting it would hand the sole external auth
 * boundary to anything the trainer ships off-host. The config path is
 * stripped alongside it as supervisor-internal. Kept next to the env
 * schema so a future supervisor secret gets added in one place.
 */
const SUPERVISOR_PRIVATE_ENVIRONMENT_KEYS: ReadonlySet<string> = new Set([
  "HARU_SUPERVISOR_TOKEN",
  "HARU_SUPERVISOR_CONFIG",
]);

/** A copy of `base` safe to hand a trainer child: the full inherited
 * environment (PATH, CUDA_*, HOME, ...) minus the supervisor's own
 * secrets. The comparison is case-insensitive: environment variables
 * are case-insensitive on Windows (process.env preserves the casing
 * they were SET with), so an exact-case filter would leak a
 * lowercase-set token there. */
export function trainerEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(base).filter(
      ([key]) => !SUPERVISOR_PRIVATE_ENVIRONMENT_KEYS.has(key.toUpperCase()),
    ),
  );
}
