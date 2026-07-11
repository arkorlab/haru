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

const isAuthenticated =
  environment.HARU_SUPERVISOR_TOKEN !== undefined &&
  environment.HARU_SUPERVISOR_TOKEN !== "";
if (!isAuthenticated) {
  console.warn(
    "HARU_SUPERVISOR_TOKEN is not set: the control API is UNAUTHENTICATED " +
      "and will bind to 127.0.0.1 only (local development mode).",
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
    // Own process group (pgid = child pid): LoRA launchers commonly
    // fork GPU-owning workers, and signalling only the launcher would
    // leave them holding VRAM, so verify_gpu never observes the
    // release and the failover stalls. The group kill below reaches
    // every descendant.
    detached: true,
    env: {
      ...process.env,
      // The trainer must checkpoint here and resume from it on start.
      HARU_CHECKPOINT_DIR: options.checkpointDir,
    },
  });
  return {
    pid: child.pid,
    kill: (signal) => {
      if (child.pid === undefined) {
        return child.kill(signal);
      }
      try {
        // Negative pid = the whole process group.
        process.kill(-child.pid, signal);
        return true;
      } catch {
        // Group already gone (or platform without group semantics):
        // fall back to the direct child.
        return child.kill(signal);
      }
    },
    once: (event, listener) => {
      // Forward both 'exit' and 'error': an unlistened ChildProcess
      // 'error' (e.g. ENOENT for a typo'd command) would otherwise
      // crash the whole supervisor as an unhandled 'error' event.
      child.once(event, listener);
    },
  };
};

const { app, stopAllTraining } = createSupervisorApp({
  config,
  token: environment.HARU_SUPERVISOR_TOKEN,
  exec: realExec,
  spawnFn: realSpawn,
});

const server = serve(
  {
    fetch: app.fetch,
    port: environment.PORT,
    // An unauthenticated control plane (sleep/wake/kill-training)
    // must never listen beyond loopback.
    hostname: isAuthenticated ? "0.0.0.0" : "127.0.0.1",
  },
  (info) => {
    console.log(`haru-supervisor listening on ${info.address}:${info.port}`);
  },
);

/** Checkpoint grace for trainers stopped by a supervisor shutdown.
 * Well inside systemd's default 90s stop timeout, so the SIGTERM ->
 * grace -> SIGKILL escalation completes before the platform SIGKILLs
 * the whole group. */
const SHUTDOWN_TRAINING_GRACE_MS = 30_000;

// Installing a SIGTERM handler suppresses Node's default
// terminate-on-signal, so the handler must complete the shutdown
// itself. Trainers MUST be stopped here: they run as detached process
// groups, so an unstopped run would survive the restart holding GPU
// VRAM while the restarted supervisor (fresh in-memory state) could
// start a second run beside it.
process.on("SIGTERM", () => {
  stopAllTraining(SHUTDOWN_TRAINING_GRACE_MS);
  // Closing the listener lets the process exit naturally once the
  // event loop drains; the pending kill timers keep it alive until
  // every trainer exited or was SIGKILLed.
  server.close();
});
