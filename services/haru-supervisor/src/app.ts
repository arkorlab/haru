import { createHash, timingSafeEqual } from "node:crypto";

import {
  errorBody,
  probeRequestSchema,
  trainingStopRequestSchema,
  vllmTargetRequestSchema,
  type SupervisorConfig,
  type SupervisorSlotStatus,
} from "@haru/protocol";
import { Hono } from "hono";

import { readGpuMemory, type ExecFunction } from "./gpu.js";
import { probeModel } from "./probe.js";
import { TrainingRun, type SpawnFunction } from "./training.js";
import { isServerSleeping, sleepServer, wakeServer } from "./vllm-client.js";

/** Parse a request body as JSON, mapping malformed/absent JSON to {}. */
async function readJsonBody(c: {
  req: { json: () => Promise<unknown> };
}): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

/** Probe one local vLLM server's sleep state; null when unreachable. */
async function sleepingOrNull(
  fetchFunction: typeof fetch,
  port: number,
): Promise<boolean | null> {
  try {
    return await isServerSleeping(fetchFunction, port);
  } catch {
    return null;
  }
}

/** Ready = every inference model is awake and reachable. */
function isReady(statuses: SupervisorSlotStatus[]): boolean {
  const models = statuses
    .filter((s) => s.kind === "inference")
    .flatMap((s) => s.models ?? []);
  return models.length > 0 && models.every((m) => m.sleeping === false);
}

function isSameSecret(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
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

  // One supervised run per training slot, keyed by GPU index.
  const trainingRuns = new Map<number, TrainingRun>();
  for (const slot of trainingSlots) {
    if (spawnFunction) {
      trainingRuns.set(
        slot.gpuIndex,
        new TrainingRun(slot.command, slot.checkpointDir, spawnFunction),
      );
    }
  }

  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.use("/v1/*", async (c, next) => {
    if (token === undefined || token === "") {
      await next();
      return;
    }
    const header = c.req.header("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (presented === "" || !isSameSecret(presented, token)) {
      return c.json(
        errorBody("unauthorized", "invalid or missing bearer token"),
        401,
      );
    }
    await next();
  });

  async function slotStatuses(): Promise<SupervisorSlotStatus[]> {
    const statuses: SupervisorSlotStatus[] = [];
    for (const slot of inferenceSlots) {
      const models = await Promise.all(
        slot.models.map(async (model) => ({
          name: model.name,
          port: model.port,
          sleeping: await sleepingOrNull(fetchFunction, model.port),
        })),
      );
      statuses.push({ gpuIndex: slot.gpuIndex, kind: "inference", models });
    }
    for (const slot of trainingSlots) {
      const run = trainingRuns.get(slot.gpuIndex);
      statuses.push({
        gpuIndex: slot.gpuIndex,
        kind: "training",
        training: {
          state: run?.state ?? "idle",
          pids: run?.pids ?? [],
        },
      });
    }
    return statuses;
  }

  app.get("/v1/status", async (c) => {
    const slots = await slotStatuses();
    return c.json({ slots, ready: isReady(slots) });
  });

  app.get("/v1/ready", async (c) => {
    const slots = await slotStatuses();
    return c.json({ ready: isReady(slots) });
  });

  function targetInferenceSlots(gpuIndex: number | undefined) {
    return gpuIndex === undefined
      ? inferenceSlots
      : inferenceSlots.filter((slot) => slot.gpuIndex === gpuIndex);
  }

  app.post("/v1/vllm/sleep", async (c) => {
    const parsed = vllmTargetRequestSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      return c.json(errorBody("invalid_request", parsed.error.message), 400);
    }
    for (const slot of targetInferenceSlots(parsed.data.gpuIndex)) {
      for (const model of slot.models) {
        // Idempotent: sleeping an already-sleeping server is a no-op
        // on the vLLM side.
        await sleepServer(fetchFunction, model.port, 1);
      }
    }
    return c.json({ status: "ok" });
  });

  app.post("/v1/vllm/wake", async (c) => {
    const parsed = vllmTargetRequestSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      return c.json(errorBody("invalid_request", parsed.error.message), 400);
    }
    for (const slot of targetInferenceSlots(parsed.data.gpuIndex)) {
      for (const model of slot.models) {
        await wakeServer(fetchFunction, model.port);
      }
    }
    return c.json({ status: "ok" });
  });

  app.post("/v1/training/start", (c) => {
    for (const run of trainingRuns.values()) {
      run.start();
    }
    return c.json({ status: "ok" });
  });

  app.post("/v1/training/stop", async (c) => {
    const parsed = trainingStopRequestSchema.safeParse(await readJsonBody(c));
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
    const parsed = probeRequestSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      return c.json(errorBody("invalid_request", parsed.error.message), 400);
    }
    const models = inferenceSlots.flatMap((slot) => slot.models);
    const results = await Promise.all(
      models.map((model) =>
        probeModel(
          fetchFunction,
          now,
          model,
          parsed.data.prompt,
          parsed.data.maxTokens,
        ),
      ),
    );
    return c.json({ ok: results.every((r) => r.ok), results });
  });

  return app;
}
