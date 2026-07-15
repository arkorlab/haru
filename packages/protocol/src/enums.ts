import { z } from "zod";

/**
 * Lifecycle of a GPU domain (one provisioned machine / cluster that
 * hosts a set of slots).
 *
 * provisioning -> ready | degraded | failed
 * ready <-> degraded
 * ready | degraded -> failed
 * failed -> degraded (heartbeat rejoin) | provisioning (relaunch)
 * ready | degraded | failed | provisioning -> stopping -> stopped -> provisioning
 *
 * The enforced edge table lives in @haru/core (domain-state.ts); this
 * sketch must stay in step with it.
 */
export const domainStateSchema = z.enum([
  "provisioning",
  "ready",
  "degraded",
  "failed",
  "stopping",
  "stopped",
]);
export type DomainState = z.infer<typeof domainStateSchema>;

/** How a domain is provisioned. `static` skips drivers entirely. */
export const domainProviderSchema = z.enum(["skypilot", "skyserve", "static"]);
export type DomainProvider = z.infer<typeof domainProviderSchema>;

export const slotKindSchema = z.enum(["inference", "training"]);
export type SlotKind = z.infer<typeof slotKindSchema>;

/**
 * Slot lifecycle. Which states are valid depends on the slot kind:
 *
 * inference: starting -> serving -> sleeping -> waking -> probing -> serving
 * training:  idle -> training -> stopping -> idle
 * shared:    failed (recoverable), stopped (terminal until relaunch)
 */
export const slotStateSchema = z.enum([
  // Inference lifecycle.
  "starting",
  "serving",
  "sleeping",
  "waking",
  "probing",
  // Training lifecycle.
  "idle",
  "training",
  "stopping",
  // Shared.
  "failed",
  "stopped",
]);
export type SlotState = z.infer<typeof slotStateSchema>;

export const operationKindSchema = z.enum(["promote", "demote"]);
export type OperationKind = z.infer<typeof operationKindSchema>;

export const operationStateSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export type OperationState = z.infer<typeof operationStateSchema>;

/**
 * Ordered steps of a promote operation. `switch_active` is the commit
 * point (a single compare-and-swap on the fleet row); everything after
 * it is best-effort cleanup of the previous active domain.
 */
export const promoteStepSchema = z.enum([
  "stop_training",
  "verify_gpu",
  "wake_vllm",
  "probe",
  "switch_active",
  "demote_old_sleep",
  "demote_old_train",
]);
export type PromoteStep = z.infer<typeof promoteStepSchema>;

/** Ordered steps of a demote operation (targets a standby domain). */
export const demoteStepSchema = z.enum(["sleep_vllm", "start_training"]);
export type DemoteStep = z.infer<typeof demoteStepSchema>;

/** Union of every operation step, as persisted in the operations table. */
export const operationStepSchema = z.enum([
  ...promoteStepSchema.options,
  ...demoteStepSchema.options,
]);
export type OperationStep = z.infer<typeof operationStepSchema>;

/**
 * URL-safe identifier used for fleet and domain slugs. Hyphens are
 * strictly interior: no leading, trailing, or consecutive hyphens, so
 * a slug is always a valid DNS label component (drivers derive
 * SkyPilot cluster / SkyServe service names from it). One slug
 * contract, enforced everywhere: the same strict validator guards
 * config input and snapshot read-back, so a slug that violates it can
 * neither be written nor silently read back.
 */
export const slugSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: "slug must be lowercase alphanumeric with inner hyphens",
  });
export type Slug = z.infer<typeof slugSchema>;
