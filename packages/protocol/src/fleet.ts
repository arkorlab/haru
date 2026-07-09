import { z } from "zod";

import {
  domainProviderSchema,
  domainStateSchema,
  slotKindSchema,
  slotStateSchema,
  slugSchema,
} from "./enums.js";
import { placementSpecSchema } from "./placement.js";
import { fleetPolicySchema } from "./policy.js";

/**
 * One model exposed by an inference slot: the public model name (what
 * chat clients put in `model`) and the OpenAI-compatible base URL of
 * the vLLM server that hosts it. Multiple models on one GPU slot means
 * multiple vLLM server processes sharing that GPU.
 */
export const modelBindingSchema = z.object({
  name: z.string().min(1),
  servingUrl: z.url(),
});
export type ModelBinding = z.infer<typeof modelBindingSchema>;

/**
 * Inference slot spec: which models this GPU serves. `sleepLevel: 1`
 * is the only supported standby mode in this slice (vLLM level 1
 * sleep keeps weights in CPU RAM for the fastest wake path).
 */
export const inferenceSlotSpecSchema = z.object({
  kind: z.literal("inference"),
  models: z.array(modelBindingSchema).min(1),
  sleepLevel: z.literal(1).default(1),
});
export type InferenceSlotSpec = z.infer<typeof inferenceSlotSpecSchema>;

/**
 * Training slot spec: the preemptible LoRA training workload that runs
 * on a standby GPU while its vLLM servers sleep. The command must be
 * checkpoint/resume oriented; the supervisor may SIGKILL it after the
 * configured grace period during failover.
 */
export const trainingSlotSpecSchema = z.object({
  kind: z.literal("training"),
  command: z.array(z.string().min(1)).min(1),
  checkpointDir: z.string().min(1),
});
export type TrainingSlotSpec = z.infer<typeof trainingSlotSpecSchema>;

export const slotSpecSchema = z.discriminatedUnion("kind", [
  inferenceSlotSpecSchema,
  trainingSlotSpecSchema,
]);
export type SlotSpec = z.infer<typeof slotSpecSchema>;

export const slotSnapshotSchema = z.object({
  id: z.uuid(),
  domainId: z.uuid(),
  gpuIndex: z.number().int().nonnegative(),
  kind: slotKindSchema,
  state: slotStateSchema,
  spec: slotSpecSchema,
});
export type SlotSnapshot = z.infer<typeof slotSnapshotSchema>;

export const domainSnapshotSchema = z.object({
  id: z.uuid(),
  fleetId: z.uuid(),
  slug: slugSchema,
  state: domainStateSchema,
  provider: domainProviderSchema,
  placement: placementSpecSchema,
  /** Private control-plane URL of the domain's supervisor. */
  supervisorUrl: z.url().nullable(),
  /** OpenAI-compatible base URL used as the domain-level fallback. */
  servingBaseUrl: z.url().nullable(),
  lastSeenAt: z.iso.datetime({ offset: true }).nullable(),
  slots: z.array(slotSnapshotSchema),
});
export type DomainSnapshot = z.infer<typeof domainSnapshotSchema>;

/**
 * Full read model of a fleet. The active/standby role is derived:
 * `domain.id === fleet.activeDomainId` means active; every other
 * domain is standby. `activeDomainId` is the single authoritative
 * routing pointer and only ever moves via compare-and-swap.
 */
export const fleetSnapshotSchema = z.object({
  id: z.uuid(),
  slug: slugSchema,
  displayName: z.string().nullable(),
  activeDomainId: z.uuid().nullable(),
  routeRevision: z.number().int().positive(),
  policy: fleetPolicySchema,
  domains: z.array(domainSnapshotSchema),
});
export type FleetSnapshot = z.infer<typeof fleetSnapshotSchema>;

export function domainRole(
  fleet: Pick<FleetSnapshot, "activeDomainId">,
  domainId: string,
): "active" | "standby" {
  return fleet.activeDomainId === domainId ? "active" : "standby";
}
