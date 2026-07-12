import { z } from "zod";

/** Wire shape of every haru API error. */
export const apiErrorBodySchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
  }),
});
export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;

/** Error codes shared across haru API surfaces. `errorBody` is typed
 * against this list so a typo'd code fails to compile. */
export const ERROR_CODES = {
  unauthorized: "unauthorized",
  fleetNotFound: "fleet_not_found",
  modelNotFound: "model_not_found",
  noActiveDomain: "no_active_domain",
  invalidRequest: "invalid_request",
  invalidTarget: "invalid_target",
  operationConflict: "operation_conflict",
  upstreamUnreachable: "upstream_unreachable",
  upstreamTimeout: "upstream_timeout",
  /** The request body exceeded the chat proxy's size cap. */
  payloadTooLarge: "payload_too_large",
  /** The supervisor received SIGTERM; no new work is accepted. */
  shuttingDown: "shutting_down",
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export function errorBody(code: ErrorCode, message: string): ApiErrorBody {
  return { error: { code, message } };
}
