import { z } from "zod";

import { slotKindSchema } from "./enums.js";
import { probeMaxTokensSchema, probePromptSchema } from "./policy.js";

/**
 * The server leaves this much of a supervisor HTTP budget for the
 * supervisor to serialize its result and for the response to travel
 * back after an inner vLLM timeout. For short budgets, ten percent is
 * reserved instead so a configured sub-second timeout remains useful.
 */
export const SUPERVISOR_RESPONSE_HEADROOM_MS = 1000;

export function supervisorInnerTimeoutMs(outerTimeoutMs: number): number {
  const proportionalHeadroomMs = Math.max(1, Math.floor(outerTimeoutMs / 10));
  return Math.max(
    1,
    outerTimeoutMs -
      Math.min(SUPERVISOR_RESPONSE_HEADROOM_MS, proportionalHeadroomMs),
  );
}

/**
 * Default outer budget for haru-server heartbeat status calls. This
 * stays 1s above the 5s /is_sleeping timeout in pre-selector
 * supervisors, so a rolling server-first deployment still leaves
 * enough time for their sleeping:null response to arrive.
 */
export const SUPERVISOR_STATUS_TIMEOUT_MS = 6000;
/** Hard inner cap for each local /is_sleeping call. */
export const SUPERVISOR_STATUS_MODEL_TIMEOUT_MS = 4000;
/** Query marker: the caller already converted an outer budget to an
 * inner per-model timeout. Kept as one shared literal so client and
 * supervisor cannot drift on its spelling. */
export const SUPERVISOR_INNER_TIMEOUT_KIND = "inner";

/**
 * Supervisor-side static configuration (HARU_SUPERVISOR_CONFIG): the
 * slot layout of the GPU host the supervisor runs on. vLLM servers
 * must be launched with sleep mode enabled and bound to 127.0.0.1;
 * their admin endpoints (sleep/wake) are private, local-only controls
 * that are never exposed beyond the supervisor.
 */
// Strict: HARU_SUPERVISOR_CONFIG is operator-authored, so a misspelled
// key must fail at load time rather than be silently dropped.
// Lowercase-only, mirroring the layout's modelBindingSchema: every
// server-side health/wake/sleep/probe check matches the layout's
// lowercase binding name against this reported name by EXACT string
// equality, so a casing mismatch would not fail here at config time
// but as runtime health flapping (the active's slots CASed to failed
// on every heartbeat) and spurious failover.
export const supervisorModelNameSchema = z
  .string()
  .min(1)
  .refine((value) => value === value.toLowerCase(), {
    message: "model names must be lowercase (matched against the layout)",
  });
export const supervisorModelSelectionSchema = z.array(
  supervisorModelNameSchema,
);

export const supervisorInferenceModelConfigSchema = z.strictObject({
  name: supervisorModelNameSchema,
  /** Local port of the vLLM server for this model on 127.0.0.1. */
  port: z.number().int().min(1).max(65_535),
});
export type SupervisorInferenceModelConfig = z.infer<
  typeof supervisorInferenceModelConfigSchema
>;

export const supervisorInferenceSlotConfigSchema = z.strictObject({
  kind: z.literal("inference"),
  gpuIndex: z.number().int().nonnegative(),
  models: z.array(supervisorInferenceModelConfigSchema).min(1),
});

export const supervisorTrainingSlotConfigSchema = z.strictObject({
  kind: z.literal("training"),
  gpuIndex: z.number().int().nonnegative(),
  command: z.array(z.string().min(1)).min(1),
  checkpointDir: z.string().min(1),
});

export const supervisorSlotConfigSchema = z.discriminatedUnion("kind", [
  supervisorInferenceSlotConfigSchema,
  supervisorTrainingSlotConfigSchema,
]);
export type SupervisorSlotConfig = z.infer<typeof supervisorSlotConfigSchema>;

export const supervisorConfigSchema = z
  .strictObject({
    /** Optional pointer to the bundled JSON Schema, so an editor can
     * validate / autocomplete the config. Ignored by the loader. */
    $schema: z.string().optional(),
    slots: z.array(supervisorSlotConfigSchema).min(1),
  })
  // The supervisor keys training runs by gpuIndex; a duplicate
  // (kind, gpuIndex) entry would silently overwrite the first one.
  .refine(
    (config) => {
      const keys = config.slots.map((slot) => `${slot.gpuIndex}:${slot.kind}`);
      return new Set(keys).size === keys.length;
    },
    {
      message: "each (gpuIndex, kind) pair must be unique",
      path: ["slots"],
    },
  )
  // Server-side wake/sleep completion checks key the supervisor's
  // reported models by NAME in a last-write-wins map, so a name listed
  // on two slots would let the wrong slot's report satisfy (or fail)
  // another slot's check - e.g. a demote's sleep proof passing while
  // the layout-bound server still holds VRAM. The layout schema rejects
  // the same duplication for the same reason.
  .refine(
    (config) => {
      const names = config.slots.flatMap((slot) =>
        slot.kind === "inference" ? slot.models.map((m) => m.name) : [],
      );
      return new Set(names).size === names.length;
    },
    {
      message: "model names must be unique across inference slots",
      path: ["slots"],
    },
  );
export type SupervisorConfig = z.infer<typeof supervisorConfigSchema>;

/** Per-model status as reported by GET /v1/status. */
export const supervisorModelStatusSchema = z.object({
  name: z.string(),
  port: z.number().int(),
  /** null when the local vLLM server is unreachable. */
  sleeping: z.boolean().nullable(),
});
export type SupervisorModelStatus = z.infer<typeof supervisorModelStatusSchema>;

export const trainingRunStateSchema = z.enum(["idle", "running", "stopping"]);
export type TrainingRunState = z.infer<typeof trainingRunStateSchema>;

export const supervisorTrainingStatusSchema = z.object({
  state: trainingRunStateSchema,
  pids: z.array(z.number().int()),
});
export type SupervisorTrainingStatus = z.infer<
  typeof supervisorTrainingStatusSchema
>;

export const supervisorSlotStatusSchema = z.object({
  gpuIndex: z.number().int().nonnegative(),
  kind: slotKindSchema,
  /** Present on inference slots. */
  models: z.array(supervisorModelStatusSchema).optional(),
  /** Present on training slots. */
  training: supervisorTrainingStatusSchema.optional(),
});
export type SupervisorSlotStatus = z.infer<typeof supervisorSlotStatusSchema>;

/** GET /v1/status response. */
export const supervisorStatusSchema = z.object({
  slots: z.array(supervisorSlotStatusSchema),
  /**
   * True when every inference model is reachable and awake. Probe
   * results are NOT folded in; the promotion flow runs its own
   * synthetic probe before routing flips.
   */
  ready: z.boolean(),
});
export type SupervisorStatus = z.infer<typeof supervisorStatusSchema>;

/** POST /v1/vllm/sleep and /v1/vllm/wake body. Omitted gpuIndex means
 * every inference slot on the host.
 *
 * The supervisor's inbound request bodies are strict: the server is the
 * only caller and ships from the same repo, so an unknown key is drift
 * or a typo, not a compatible extension. (Supervisor RESPONSE schemas,
 * which the server parses, stay lenient - leniency toward a peer.) */
export const vllmTargetRequestSchema = z.strictObject({
  gpuIndex: z.number().int().nonnegative().optional(),
});
export type VllmTargetRequest = z.infer<typeof vllmTargetRequestSchema>;

/**
 * Millisecond values feed setTimeout, which clamps delays above
 * 2^31-1 to ~1ms; an oversized "grace" would SIGKILL immediately.
 */
const MAX_TIMEOUT_MS = 2_147_483_647;
const timeoutMsSchema = z.number().int().positive().max(MAX_TIMEOUT_MS);

/**
 * Parsed form of the GET /v1/status query. `models: undefined` keeps
 * the legacy "all configured models" behaviour; an empty array asks
 * for training status without probing any inference model.
 */
export const supervisorStatusQuerySchema = z.strictObject({
  models: supervisorModelSelectionSchema.optional(),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(SUPERVISOR_STATUS_MODEL_TIMEOUT_MS)
    .optional(),
  timeoutKind: z.literal(SUPERVISOR_INNER_TIMEOUT_KIND).optional(),
});
export type SupervisorStatusQuery = z.infer<typeof supervisorStatusQuerySchema>;

/** POST /v1/training/stop body. */
export const trainingStopRequestSchema = z.strictObject({
  graceMs: timeoutMsSchema.optional(),
});
export type TrainingStopRequest = z.infer<typeof trainingStopRequestSchema>;

export const gpuMemoryEntrySchema = z.object({
  index: z.number().int().nonnegative(),
  usedMiB: z.number().nonnegative(),
  totalMiB: z.number().positive(),
});
export type GpuMemoryEntry = z.infer<typeof gpuMemoryEntrySchema>;

/** GET /v1/gpu/memory response. */
export const gpuMemorySchema = z.object({
  gpus: z.array(gpuMemoryEntrySchema),
});
export type GpuMemory = z.infer<typeof gpuMemorySchema>;

/** POST /v1/probe body. */
export const probeRequestSchema = z.strictObject({
  prompt: probePromptSchema.default("ping"),
  maxTokens: probeMaxTokensSchema.default(4),
  /**
   * Per-model completion timeout. The caller (reconciler) passes its
   * probe step budget so the supervisor never keeps a vLLM request
   * alive past the point the caller stopped waiting for it; omitted
   * means the supervisor's built-in default.
   */
  timeoutMs: timeoutMsSchema.optional(),
});
export type ProbeRequest = z.infer<typeof probeRequestSchema>;

/** POST /v1/probe response. */
export const probeResultSchema = z.object({
  model: z.string(),
  ok: z.boolean(),
  latencyMs: z.number().nonnegative(),
  error: z.string().optional(),
});
export type ProbeResult = z.infer<typeof probeResultSchema>;

export const probeResponseSchema = z.object({
  ok: z.boolean(),
  results: z.array(probeResultSchema),
});
export type ProbeResponse = z.infer<typeof probeResponseSchema>;

/** GET /v1/ready response. */
export const readyResponseSchema = z.object({
  ready: z.boolean(),
});
export type ReadyResponse = z.infer<typeof readyResponseSchema>;
