import { z } from "zod";

/**
 * Millisecond budgets feed setTimeout, which clamps delays above
 * 2^31-1 to 1ms (an "effectively infinite" timeout would fire
 * instantly); bound them at the schema so misconfiguration is a
 * config-time error.
 */
const MAX_TIMEOUT_MS = 2_147_483_647;
const timeoutMsSchema = z.number().int().positive().max(MAX_TIMEOUT_MS);

const probePromptSchema = z.string().min(1);
const probeMaxTokensSchema = z.number().int().positive();

/** Synthetic inference probe configuration. Strict: this is
 * operator-authored config, so a misspelled key must fail at parse
 * time rather than be silently dropped. */
export const probePolicySchema = z.strictObject({
  prompt: probePromptSchema.default("ping"),
  maxTokens: probeMaxTokensSchema.default(4),
});
export type ProbePolicy = z.infer<typeof probePolicySchema>;

/** Storage form of the probe config: like probePolicySchema but WITHOUT
 * the inner defaults, so a `{ probe: { prompt } }` layout patch does not
 * bake in the sibling maxTokens (a plain `.partial()` still fires each
 * field's `.default()`). */
const probePolicyPatchSchema = z.strictObject({
  prompt: probePromptSchema.optional(),
  maxTokens: probeMaxTokensSchema.optional(),
});

/**
 * Per-fleet operational policy. Stored as jsonb on the fleet row and
 * parsed on read, so a partially-specified policy always yields fully
 * populated defaults.
 *
 * All timeouts are per promotion/demotion step, measured from the
 * moment the reconciler enters the step. Training checkpointing is
 * best-effort inside `trainingStopGraceMs`; failover is never blocked
 * waiting for a perfect checkpoint.
 *
 * Strict: a misspelled key (e.g. `autoFailver`) must be a config-time
 * error, not a silently dropped field that leaves a safety setting
 * like `autoFailover` at its default. `.partial()` in the layout
 * schema inherits this strictness.
 */
const autoFailoverSchema = z.boolean();

export const fleetPolicySchema = z.strictObject({
  /** Automatically promote a standby when the active goes stale. */
  autoFailover: autoFailoverSchema.default(false),
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

/**
 * A partial policy for STORAGE (the layout's `policy` block, persisted
 * to the fleet's jsonb column). Unlike `fleetPolicySchema.partial()`,
 * this must NOT bake each field's default into the stored value: Zod's
 * `.partial()` only wraps a field in `.optional()`, leaving the inner
 * `.default()` to still fire, so a `{ autoFailover: true }` layout would
 * persist ALL eleven defaults. Because `resolveFleetPolicy` never
 * re-defaults a key that is already present, that would freeze the
 * fleet against any later change to a default (e.g. lowering
 * `heartbeatStaleMs`), and re-seeding cannot fix it (the fleet insert is
 * ON CONFLICT DO NOTHING). Storing only the operator-provided keys keeps
 * the documented contract: unset fields resolve to the CURRENT default
 * on read. Still strict, so a typo'd key remains a config-time error.
 *
 * Keep the key set in lockstep with `fleetPolicySchema` - the drift
 * guard in protocol.test.ts asserts the two shapes match.
 */
export const fleetPolicyPatchSchema = z.strictObject({
  autoFailover: autoFailoverSchema.optional(),
  heartbeatStaleMs: timeoutMsSchema.optional(),
  degradedGraceMs: timeoutMsSchema.optional(),
  trainingStopGraceMs: timeoutMsSchema.optional(),
  stopTrainingTimeoutMs: timeoutMsSchema.optional(),
  verifyGpuTimeoutMs: timeoutMsSchema.optional(),
  wakeTimeoutMs: timeoutMsSchema.optional(),
  probeTimeoutMs: timeoutMsSchema.optional(),
  switchActiveTimeoutMs: timeoutMsSchema.optional(),
  sleepTimeoutMs: timeoutMsSchema.optional(),
  startTrainingTimeoutMs: timeoutMsSchema.optional(),
  // The probe sub-object carries its OWN defaults; use the patch form so
  // a `{ probe: { prompt } }` patch does not bake in maxTokens.
  probe: probePolicyPatchSchema.optional(),
});
export type FleetPolicyPatch = z.infer<typeof fleetPolicyPatchSchema>;

/** Parse a possibly-partial policy value (e.g. a jsonb column) into a
 * fully defaulted policy. `null`/`undefined` yield all defaults. */
export function resolveFleetPolicy(value: unknown): FleetPolicy {
  return fleetPolicySchema.parse(value ?? {});
}
