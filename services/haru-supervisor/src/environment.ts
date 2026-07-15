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
