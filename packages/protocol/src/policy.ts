import { z } from "zod";

/**
 * Millisecond budgets feed setTimeout, which clamps delays above
 * 2^31-1 to 1ms (an "effectively infinite" timeout would fire
 * instantly); bound them at the schema so misconfiguration is a
 * config-time error.
 */
const MAX_TIMEOUT_MS = 2_147_483_647;
const timeoutMsSchema = z.number().int().positive().max(MAX_TIMEOUT_MS);

/** Synthetic inference probe configuration. */
export const probePolicySchema = z.object({
  prompt: z.string().min(1).default("ping"),
  maxTokens: z.number().int().positive().default(4),
});
export type ProbePolicy = z.infer<typeof probePolicySchema>;

/**
 * Per-fleet operational policy. Stored as jsonb on the fleet row and
 * parsed on read, so a partially-specified policy always yields fully
 * populated defaults.
 *
 * All timeouts are per promotion/demotion step, measured from the
 * moment the reconciler enters the step. Training checkpointing is
 * best-effort inside `trainingStopGraceMs`; failover is never blocked
 * waiting for a perfect checkpoint.
 */
export const fleetPolicySchema = z.object({
  /** Automatically promote a standby when the active goes stale. */
  autoFailover: z.boolean().default(false),
  /** Active domain heartbeat staleness threshold. */
  heartbeatStaleMs: timeoutMsSchema.default(30_000),
  /**
   * How long the ACTIVE domain may stay degraded (supervisor reachable
   * but models not serving) before it escalates to failed, which makes
   * auto-failover fire. Only meaningful with autoFailover on; standbys
   * are never escalated (that would strip their promotability).
   */
  degradedGraceMs: timeoutMsSchema.default(60_000),
  /** SIGTERM-to-SIGKILL grace for preemptible LoRA training. */
  trainingStopGraceMs: timeoutMsSchema.default(30_000),
  /** Total bound for the stop_training step (grace + kill + exit). */
  stopTrainingTimeoutMs: timeoutMsSchema.default(90_000),
  /** Bound for the verify_gpu step (VRAM release check). */
  verifyGpuTimeoutMs: timeoutMsSchema.default(30_000),
  /** Bound for the wake_vllm step (level 1 sleep -> awake). */
  wakeTimeoutMs: timeoutMsSchema.default(120_000),
  /** Bound for the probe step (synthetic inference). */
  probeTimeoutMs: timeoutMsSchema.default(60_000),
  /** Bound for the switch_active step (single DB compare-and-swap). */
  switchActiveTimeoutMs: timeoutMsSchema.default(10_000),
  /** Bound for the best-effort demote_old_sleep / sleep_vllm step. */
  sleepTimeoutMs: timeoutMsSchema.default(60_000),
  /** Bound for the best-effort demote_old_train / start_training step. */
  startTrainingTimeoutMs: timeoutMsSchema.default(30_000),
  probe: probePolicySchema.default({ prompt: "ping", maxTokens: 4 }),
});
export type FleetPolicy = z.infer<typeof fleetPolicySchema>;

/** Parse a possibly-partial policy value (e.g. a jsonb column) into a
 * fully defaulted policy. `null`/`undefined` yield all defaults. */
export function resolveFleetPolicy(value: unknown): FleetPolicy {
  return fleetPolicySchema.parse(value ?? {});
}
