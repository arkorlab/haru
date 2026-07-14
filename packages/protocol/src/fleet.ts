import { z } from "zod";

import {
  domainProviderSchema,
  domainStateSchema,
  slotKindSchema,
  slotStateSchema,
  storedSlugSchema,
} from "./enums.js";
import { placementSpecSchema } from "./placement.js";
import { fleetPolicySchema } from "./policy.js";

/**
 * URL that the chat proxy / supervisor client will feed to
 * joinUrl + fetch as an HTTP endpoint. `z.url()` alone admits schemes
 * like mailto: or file:, which would pass seed validation and then
 * blow up (or be fetched) mid-request; bad layouts must fail at
 * config time instead.
 */
export const httpUrlSchema = z.url({ protocol: /^https?$/ });

/**
 * One model exposed by an inference slot: the public model name (what
 * chat clients put in `model`) and the OpenAI-compatible base URL of
 * the vLLM server that hosts it. Multiple models on one GPU slot means
 * multiple vLLM server processes sharing that GPU.
 */
export const modelBindingSchema = z.strictObject({
  // Lowercase-only: this is the routing key clients put in `model`,
  // matched exactly by the chat proxy. Requiring lowercase here turns
  // a client/server casing mismatch (many callers normalise model ids
  // to lowercase) into a config-time error instead of a silent 404.
  // The vLLM server behind `servingUrl` must serve the same lowercase
  // name (e.g. via --served-model-name).
  name: z
    .string()
    .min(1)
    .refine((value) => value === value.toLowerCase(), {
      message: "model binding names must be lowercase (routing key)",
    }),
  servingUrl: httpUrlSchema,
});
export type ModelBinding = z.infer<typeof modelBindingSchema>;

/**
 * Inference slot spec: which models this GPU serves. `sleepLevel: 1`
 * is the only supported standby mode in this slice (vLLM level 1
 * sleep keeps weights in CPU RAM for the fastest wake path).
 *
 * Strict: operator-authored config; unknown keys (e.g. a misspelled
 * `sleepLevel`) fail at parse time. `slotLayoutSchema` extends this
 * with `gpuIndex` and inherits the strictness.
 */
export const inferenceSlotSpecSchema = z.strictObject({
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
export const trainingSlotSpecSchema = z.strictObject({
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

export const slotSnapshotSchema = z
  .object({
    id: z.uuid(),
    domainId: z.uuid(),
    gpuIndex: z.number().int().nonnegative(),
    kind: slotKindSchema,
    state: slotStateSchema,
    spec: slotSpecSchema,
  })
  // The row's `kind` column and the spec discriminant are written
  // together by applyFleetLayout; enforce they agree at the read
  // boundary so a drifted row can never surface as (say) an inference
  // slot carrying a training spec. Routing and health predicates then
  // gate on either interchangeably.
  .refine((slot) => slot.kind === slot.spec.kind, {
    message: "slot.kind must match slot.spec.kind",
    path: ["kind"],
  });
export type SlotSnapshot = z.infer<typeof slotSnapshotSchema>;

export const domainSnapshotSchema = z.object({
  id: z.uuid(),
  fleetId: z.uuid(),
  slug: storedSlugSchema,
  state: domainStateSchema,
  provider: domainProviderSchema,
  placement: placementSpecSchema,
  /** Private control-plane URL of the domain's supervisor. */
  supervisorUrl: httpUrlSchema.nullable(),
  /** OpenAI-compatible base URL used as the domain-level fallback. */
  servingBaseUrl: httpUrlSchema.nullable(),
  lastSeenAt: z.iso.datetime({ offset: true }).nullable(),
  /**
   * When the domain last changed state. Written with the reconciler's
   * injected app clock (not the DB clock) because the degraded
   * escalation budget compares against that same clock.
   */
  stateUpdatedAt: z.iso.datetime({ offset: true }),
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
  slug: storedSlugSchema,
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
