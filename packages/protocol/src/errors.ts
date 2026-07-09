import { z } from "zod";

/** Wire shape of every haru API error. */
export const apiErrorBodySchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
  }),
});
export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;

export function errorBody(code: string, message: string): ApiErrorBody {
  return { error: { code, message } };
}

/** Error codes shared across haru services. */
export const ERROR_CODES = {
  unauthorized: "unauthorized",
  fleetNotFound: "fleet_not_found",
  domainNotFound: "domain_not_found",
  modelNotFound: "model_not_found",
  noActiveDomain: "no_active_domain",
  invalidRequest: "invalid_request",
  invalidTarget: "invalid_target",
  operationConflict: "operation_conflict",
  upstreamUnreachable: "upstream_unreachable",
  upstreamTimeout: "upstream_timeout",
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
