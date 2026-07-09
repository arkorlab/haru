import { spawn } from "node:child_process";

import { defaultExec, type ExecFunction } from "@haru/protocol";
import { serve } from "@hono/node-server";
import { z } from "zod";

import { createSupervisorApp } from "./app.js";
import { loadSupervisorConfig } from "./config.js";

import type { SpawnFunction } from "./training.js";

const environmentSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(8701),
  HARU_SUPERVISOR_TOKEN: z.string().optional(),
  HARU_SUPERVISOR_CONFIG: z.string().min(1),
});

const environment = environmentSchema.parse(process.env);
const config = loadSupervisorConfig(environment.HARU_SUPERVISOR_CONFIG);

if (
  environment.HARU_SUPERVISOR_TOKEN === undefined ||
  environment.HARU_SUPERVISOR_TOKEN === ""
) {
  console.warn(
    "HARU_SUPERVISOR_TOKEN is not set: the control API is UNAUTHENTICATED. " +
      "This is acceptable for local development only.",
  );
}

const EXEC_TIMEOUT_MS = 15_000;

// The timeout kills a wedged nvidia-smi (a known failure mode on sick
// GPUs/drivers) instead of leaking a pending handler per verify_gpu
// retry.
const realExec: ExecFunction = (command, arguments_, options) =>
  defaultExec(command, arguments_, { timeoutMs: EXEC_TIMEOUT_MS, ...options });

const realSpawn: SpawnFunction = (command, options) => {
  const [executable, ...arguments_] = command;
  if (executable === undefined) {
    throw new Error("training command must not be empty");
  }
  const child = spawn(executable, arguments_, {
    stdio: "inherit",
    env: {
      ...process.env,
      // The trainer must checkpoint here and resume from it on start.
      HARU_CHECKPOINT_DIR: options.checkpointDir,
    },
  });
  return {
    pid: child.pid,
    kill: (signal) => child.kill(signal),
    once: (event, listener) => {
      // Forward both 'exit' and 'error': an unlistened ChildProcess
      // 'error' (e.g. ENOENT for a typo'd command) would otherwise
      // crash the whole supervisor as an unhandled 'error' event.
      child.once(event, listener);
    },
  };
};

const app = createSupervisorApp({
  config,
  token: environment.HARU_SUPERVISOR_TOKEN,
  exec: realExec,
  spawnFn: realSpawn,
});

serve({ fetch: app.fetch, port: environment.PORT }, (info) => {
  console.log(`haru-supervisor listening on :${info.port}`);
});
