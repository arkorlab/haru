import { z } from "zod";

import {
  operationKindSchema,
  operationStateSchema,
  operationStepSchema,
} from "./enums.js";

export const operationErrorSchema = z.object({
  step: operationStepSchema.nullable(),
  code: z.string().min(1),
  message: z.string(),
});
export type OperationError = z.infer<typeof operationErrorSchema>;

export const operationSnapshotSchema = z.object({
  id: z.uuid(),
  fleetId: z.uuid(),
  kind: operationKindSchema,
  state: operationStateSchema,
  targetDomainId: z.uuid(),
  currentStep: operationStepSchema.nullable(),
  stepStartedAt: z.iso.datetime({ offset: true }).nullable(),
  error: operationErrorSchema.nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type OperationSnapshot = z.infer<typeof operationSnapshotSchema>;

// Strict: these are the server's own control-API request bodies. Client
// and server ship from one repo and version together, so an unknown key
// is a typo / drift, not a compatible extension - reject it at the edge.
export const promoteRequestSchema = z.strictObject({
  targetDomainId: z.uuid(),
});
export type PromoteRequest = z.infer<typeof promoteRequestSchema>;

export const demoteRequestSchema = z.strictObject({
  targetDomainId: z.uuid(),
});
export type DemoteRequest = z.infer<typeof demoteRequestSchema>;

/** 200 response when the requested target is already active. */
export const promoteNoopResponseSchema = z.object({
  status: z.literal("already_active"),
  routeRevision: z.number().int().positive(),
});
export type PromoteNoopResponse = z.infer<typeof promoteNoopResponseSchema>;

/** 202 response when an operation was created or joined. */
export const operationAcceptedResponseSchema = z.object({
  status: z.literal("accepted"),
  operation: operationSnapshotSchema,
});
export type OperationAcceptedResponse = z.infer<
  typeof operationAcceptedResponseSchema
>;
