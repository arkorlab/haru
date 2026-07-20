import {
  errorBody,
  isBearerTokenValid,
  probeRequestSchema,
  readOptionalJsonBody,
  SUPERVISOR_INNER_TIMEOUT_KIND,
  supervisorInnerTimeoutMs,
  supervisorStatusQuerySchema,
  trainingStopRequestSchema,
  vllmTargetRequestSchema,
  type ReadyResponse,
  type SupervisorConfig,
  type SupervisorSlotStatus,
} from "@haru/protocol";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import { readGpuMemory, type ExecFunction } from "./gpu.js";
import { probeModel } from "./probe.js";
import { TrainingRun, type SpawnFunction } from "./training.js";
import { isServerSleeping, sleepServer, wakeServer } from "./vllm-client.js";

/** Probe one local vLLM server's sleep state; null when unreachable. */
async function sleepingOrNull(
  fetchFunction: typeof fetch,
  port: number,
  timeoutMs: number | undefined,
  signal: AbortSignal,
): Promise<boolean | null> {
  try {
    return await isServerSleeping(fetchFunction, port, timeoutMs, signal);
  } catch {
    return null;
  }
}

/** Ready = every requested inference model exists, is awake and reachable. */
function isReady(
  statuses: SupervisorSlotStatus[],
  requestedModelNames?: readonly string[],
): boolean {
  const models = statuses
    .filter((s) => s.kind === "inference")
    .flatMap((s) => s.models ?? []);
  const reportedModelNames = new Set(models.map((model) => model.name));
  return (
    models.length > 0 &&
    models.every((model) => model.sleeping === false) &&
    (requestedModelNames === undefined ||
      requestedModelNames.every((name) => reportedModelNames.has(name)))
  );
}

export interface SupervisorDependencies {
  config: SupervisorConfig;
  /** Required in production: gate for every control route. */
  token: string | undefined;
  fetchFn?: typeof fetch;
  exec?: ExecFunction;
  spawnFn?: SpawnFunction;
  now?: () => number;
  defaultTrainingGraceMs?: number;
}

const DEFAULT_TRAINING_GRACE_MS = 30_000;
const SUPERVISOR_MAX_BODY_BYTES = 64 * 1024;

const supervisorBodyLimit = bodyLimit({
  maxSize: SUPERVISOR_MAX_BODY_BYTES,
  onError: (c) =>
    c.json(
      errorBody(
        "payload_too_large",
        `request body exceeds the ${String(SUPERVISOR_MAX_BODY_BYTES)}-byte limit`,
      ),
      413,
    ),
});

/**
 * No `model` query means the legacy all-model target. A lone empty
 * value is the explicit empty selection emitted by haru-server for a
 * training-only domain.
 */
function modelSelectionQuery(
  values: string[] | undefined,
): string[] | undefined {
  return values?.length === 1 && values[0] === "" ? [] : values;
}

function readSingleQueryValue(
  values: string[] | undefined,
): { ok: true; value: string | undefined } | { ok: false } {
  return values === undefined || values.length === 1
    ? { ok: true, value: values?.[0] }
    : { ok: false };
}

/**
 * The GPU-domain-side control surface. vLLM's sleep/wake admin
 * endpoints stay bound to 127.0.0.1 and are never exposed; this app is
 * the only externally reachable way to drive them, always behind the
 * bearer token.
 */
export function createSupervisorApp(dependencies: SupervisorDependencies) {
  const { config, token } = dependencies;
  const fetchFunction = dependencies.fetchFn ?? fetch;
  const exec = dependencies.exec;
  const spawnFunction = dependencies.spawnFn;
  const now = dependencies.now ?? (() => Date.now());
  const defaultGraceMs =
    dependencies.defaultTrainingGraceMs ?? DEFAULT_TRAINING_GRACE_MS;

  const inferenceSlots = config.slots.filter(
    (slot) => slot.kind === "inference",
  );
  const trainingSlots = config.slots.filter((slot) => slot.kind === "training");

  // One supervised run per training slot, keyed by GPU index. A
  // config with training slots but no way to spawn them must fail at
  // boot: otherwise /v1/training/start would 200 while starting
  // nothing, and the reconciler's start_training step would poll a
  // forever-idle status until its budget expires.
  if (trainingSlots.length > 0 && !spawnFunction) {
    throw new Error(
      "supervisor config declares training slots but no spawn function was provided",
    );
  }
  const trainingRuns = new Map<number, TrainingRun>();
  for (const slot of trainingSlots) {
    if (spawnFunction) {
      trainingRuns.set(
        slot.gpuIndex,
        new TrainingRun(
          slot.command,
          slot.checkpointDir,
          slot.gpuIndex,
          spawnFunction,
        ),
      );
    }
  }

  const app = new Hono();
  let isShuttingDown = false;

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.use("/v1/*", async (c, next) => {
    if (!isBearerTokenValid(c.req.header("authorization"), token)) {
      return c.json(
        errorBody("unauthorized", "invalid or missing bearer token"),
        401,
      );
    }
    await next();
  });
  // Registered after auth: an unauthenticated oversized upload is
  // rejected without the body limiter consuming it.
  app.on("POST", "/v1/*", supervisorBodyLimit);

  async function slotStatuses(
    modelNames: readonly string[] | undefined,
    timeoutMs: number | undefined,
    signal: AbortSignal,
  ): Promise<SupervisorSlotStatus[]> {
    // All local vLLM servers are probed concurrently (across slots,
    // not just within one) so a multi-model host answers /v1/status
    // within one admin-call round trip.
    const selectedModelNames =
      modelNames === undefined ? undefined : new Set(modelNames);
    const inferenceStatuses = await Promise.all(
      inferenceSlots.map(
        async (slot): Promise<SupervisorSlotStatus> => ({
          gpuIndex: slot.gpuIndex,
          kind: "inference",
          models: await Promise.all(
            slot.models
              .filter(
                (model) =>
                  selectedModelNames === undefined ||
                  selectedModelNames.has(model.name),
              )
              .map(async (model) => ({
                name: model.name,
                port: model.port,
                sleeping: await sleepingOrNull(
                  fetchFunction,
                  model.port,
                  timeoutMs,
                  signal,
                ),
              })),
          ),
        }),
      ),
    );
    const trainingStatuses = trainingSlots.map((slot): SupervisorSlotStatus => {
      const run = trainingRuns.get(slot.gpuIndex);
      return {
        gpuIndex: slot.gpuIndex,
        kind: "training",
        training: {
          state: run?.state ?? "idle",
          pids: run?.pids ?? [],
        },
      };
    });
    return [...inferenceStatuses, ...trainingStatuses];
  }

  app.get("/v1/status", async (c) => {
    const rawTimeoutValues = c.req.queries("timeoutMs");
    const timeoutKind = readSingleQueryValue(c.req.queries("timeoutKind"));
    if (!timeoutKind.ok) {
      return c.json(
        errorBody("invalid_request", "timeoutKind must appear at most once"),
        400,
      );
    }
    if (
      rawTimeoutValues !== undefined &&
      (rawTimeoutValues.length !== 1 ||
        !/^[1-9]\d*$/.test(rawTimeoutValues[0] ?? ""))
    ) {
      return c.json(
        errorBody("invalid_request", "timeoutMs must be a positive integer"),
        400,
      );
    }
    const parsed = supervisorStatusQuerySchema.safeParse({
      models: modelSelectionQuery(c.req.queries("model")),
      timeoutMs:
        rawTimeoutValues === undefined
          ? undefined
          : Number(rawTimeoutValues[0]),
      timeoutKind: timeoutKind.value,
    });
    if (!parsed.success) {
      return c.json(errorBody("invalid_request", parsed.error.message), 400);
    }
    const slots = await slotStatuses(
      parsed.data.models,
      parsed.data.timeoutMs,
      c.req.raw.signal,
    );
    return c.json({
      slots,
      ready: isReady(slots, parsed.data.models),
    });
  });

  app.get("/v1/ready", async (c) => {
    const slots = await slotStatuses(undefined, undefined, c.req.raw.signal);
    return c.json({ ready: isReady(slots) } satisfies ReadyResponse);
  });

  function targetInferenceSlots(gpuIndex: number | undefined) {
    return gpuIndex === undefined
      ? inferenceSlots
      : inferenceSlots.filter((slot) => slot.gpuIndex === gpuIndex);
  }

  /**
   * Apply an admin action to every model of the targeted slots.
   * Attempts EVERY model even when earlier ones fail (a crashed vLLM
   * process must not shield its healthy siblings from the command) and
   * reports the failures as a JSON error envelope instead of an
   * uncaught exception.
   */
  async function forEachTargetModel(
    gpuIndex: number | undefined,
    action: (port: number) => Promise<void>,
  ): Promise<{ ok: true } | { ok: false; failures: string[] }> {
    // Fan out concurrently: a slow sleep/wake on one model must not
    // serialize behind the others (multi-model hosts would otherwise
    // exceed the reconciler's nudge timeout and rely on retries). The
    // per-model catch keeps the collect-all-failures envelope, in
    // config order.
    const models = targetInferenceSlots(gpuIndex).flatMap(
      (slot) => slot.models,
    );
    const outcomes = await Promise.all(
      models.map(async (model) => {
        try {
          await action(model.port);
          return null;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return `${model.name}: ${detail}`;
        }
      }),
    );
    const failures = outcomes.filter((outcome) => outcome !== null);
    return failures.length === 0 ? { ok: true } : { ok: false, failures };
  }

  function isUnknownGpuIndex(gpuIndex: number | undefined): boolean {
    return (
      gpuIndex !== undefined &&
      inferenceSlots.every((slot) => slot.gpuIndex !== gpuIndex)
    );
  }

  app.post("/v1/vllm/sleep", async (c) => {
    // Empty body = "target everything" (all fields optional), but a
    // MALFORMED body must 400 rather than silently widen the target.
    const body = await readOptionalJsonBody(c.req, {});
    if (!body.ok) {
      return c.json(errorBody("invalid_request", "malformed JSON body"), 400);
    }
    const parsed = vllmTargetRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return c.json(errorBody("invalid_request", parsed.error.message), 400);
    }
    if (isUnknownGpuIndex(parsed.data.gpuIndex)) {
      return c.json(
        errorBody("invalid_target", "no inference slot on that gpuIndex"),
        404,
      );
    }
    // Idempotent per model: sleeping an already-sleeping server is a
    // no-op on the vLLM side.
    const result = await forEachTargetModel(parsed.data.gpuIndex, (port) =>
      sleepServer(fetchFunction, port, 1),
    );
    if (!result.ok) {
      return c.json(
        errorBody("upstream_unreachable", result.failures.join("; ")),
        502,
      );
    }
    return c.json({ status: "ok" });
  });

  app.post("/v1/vllm/wake", async (c) => {
    // Empty body = "target everything" (all fields optional), but a
    // MALFORMED body must 400 rather than silently widen the target.
    const body = await readOptionalJsonBody(c.req, {});
    if (!body.ok) {
      return c.json(errorBody("invalid_request", "malformed JSON body"), 400);
    }
    const parsed = vllmTargetRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return c.json(errorBody("invalid_request", parsed.error.message), 400);
    }
    if (isUnknownGpuIndex(parsed.data.gpuIndex)) {
      return c.json(
        errorBody("invalid_target", "no inference slot on that gpuIndex"),
        404,
      );
    }
    const result = await forEachTargetModel(parsed.data.gpuIndex, (port) =>
      wakeServer(fetchFunction, port),
    );
    if (!result.ok) {
      return c.json(
        errorBody("upstream_unreachable", result.failures.join("; ")),
        502,
      );
    }
    return c.json({ status: "ok" });
  });

  app.post("/v1/training/start", (c) => {
    // SIGTERM race: server.close() still drains in-flight requests, so
    // a start accepted just before shutdown could otherwise spawn a
    // fresh detached trainer AFTER the shutdown stop sweep ran,
    // leaving it with no kill escalation (the supervisor would hang on
    // its child, or orphan the GPU process on restart).
    if (isShuttingDown) {
      return c.json(
        errorBody(
          "shutting_down",
          "supervisor is shutting down; training cannot start",
        ),
        503,
      );
    }
    for (const run of trainingRuns.values()) {
      run.start();
    }
    return c.json({ status: "ok" });
  });

  app.post("/v1/training/stop", async (c) => {
    // Empty body = "target everything" (all fields optional), but a
    // MALFORMED body must 400 rather than silently widen the target.
    const body = await readOptionalJsonBody(c.req, {});
    if (!body.ok) {
      return c.json(errorBody("invalid_request", "malformed JSON body"), 400);
    }
    const parsed = trainingStopRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return c.json(errorBody("invalid_request", parsed.error.message), 400);
    }
    const graceMs = parsed.data.graceMs ?? defaultGraceMs;
    for (const run of trainingRuns.values()) {
      run.stop(graceMs);
    }
    return c.json({ status: "ok" }, 202);
  });

  app.get("/v1/training/status", (c) => {
    const slots = trainingSlots.map((slot) => {
      const run = trainingRuns.get(slot.gpuIndex);
      return {
        gpuIndex: slot.gpuIndex,
        state: run?.state ?? "idle",
        pids: run?.pids ?? [],
      };
    });
    return c.json({ slots });
  });

  app.get("/v1/gpu/memory", async (c) => {
    if (!exec) {
      return c.json(
        errorBody(
          "invalid_request",
          "GPU memory introspection is not configured",
        ),
        501,
      );
    }
    try {
      return c.json(await readGpuMemory(exec));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return c.json(errorBody("upstream_unreachable", detail), 502);
    }
  });

  app.post("/v1/probe", async (c) => {
    const timeoutKind = readSingleQueryValue(c.req.queries("timeoutKind"));
    if (!timeoutKind.ok) {
      return c.json(
        errorBody("invalid_request", "timeoutKind must appear at most once"),
        400,
      );
    }
    const selected = supervisorStatusQuerySchema.safeParse({
      models: modelSelectionQuery(c.req.queries("model")),
      timeoutKind: timeoutKind.value,
    });
    if (!selected.success) {
      return c.json(errorBody("invalid_request", selected.error.message), 400);
    }
    // Empty body = "target everything" (all fields optional), but a
    // MALFORMED body must 400 rather than silently widen the target.
    const body = await readOptionalJsonBody(c.req, {});
    if (!body.ok) {
      return c.json(errorBody("invalid_request", "malformed JSON body"), 400);
    }
    const parsed = probeRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return c.json(errorBody("invalid_request", parsed.error.message), 400);
    }
    const selectedModelNames =
      selected.data.models === undefined
        ? undefined
        : new Set(selected.data.models);
    const models = inferenceSlots
      .flatMap((slot) => slot.models)
      .filter(
        (model) =>
          selectedModelNames === undefined ||
          selectedModelNames.has(model.name),
      );
    // A pre-selector server sends its OUTER probe budget here. Reserve
    // response headroom on that legacy shape. A new server either
    // supplies a model selector or, when that selector would make the
    // URL unsafe, the explicit inner-timeout marker. In both cases it
    // has already shortened the per-model timeout, so do not subtract
    // twice.
    const perModelTimeoutMs =
      selected.data.models === undefined &&
      selected.data.timeoutKind !== SUPERVISOR_INNER_TIMEOUT_KIND &&
      parsed.data.timeoutMs !== undefined
        ? supervisorInnerTimeoutMs(parsed.data.timeoutMs)
        : parsed.data.timeoutMs;
    // ok must not be vacuously true: a host with zero configured
    // inference models cannot pass a readiness probe.
    const results = await Promise.all(
      models.map((model) =>
        probeModel(
          fetchFunction,
          now,
          model,
          parsed.data.prompt,
          parsed.data.maxTokens,
          perModelTimeoutMs,
          c.req.raw.signal,
        ),
      ),
    );
    const probedModelNames = new Set(results.map((result) => result.model));
    const didProbeEveryRequestedModel =
      selected.data.models === undefined ||
      selected.data.models.every((name) => probedModelNames.has(name));
    return c.json({
      ok:
        results.length > 0 &&
        results.every((result) => result.ok) &&
        didProbeEveryRequestedModel,
      results,
    });
  });

  // Shutdown hook for main's SIGTERM handler: trainers run as their
  // own detached process groups, so a run left unstopped would
  // survive a supervisor restart, keep holding GPU VRAM, and the
  // restarted supervisor (fresh in-memory state) could start a second
  // run beside it. The flag is raised BEFORE the stop sweep so an
  // in-flight /v1/training/start draining through server.close()
  // cannot spawn a new trainer after its run was swept.
  const beginShutdown = (graceMs: number): void => {
    isShuttingDown = true;
    for (const run of trainingRuns.values()) {
      run.stop(graceMs);
    }
  };

  return { app, beginShutdown };
}
