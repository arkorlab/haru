import { execFile } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  timeoutMs?: number;
  env?: Record<string, string>;
  maxBufferBytes?: number;
}

/**
 * Process-execution boundary shared by the drivers (`sky` CLI) and the
 * supervisor (`nvidia-smi`). Injectable so every consumer is testable
 * without the real binary; the default implementation uses execFile
 * with an argv array (no shell interpolation).
 */
export type ExecFunction = (
  command: string,
  arguments_: readonly string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

const DEFAULT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export const defaultExec: ExecFunction = (command, arguments_, options) =>
  new Promise((resolve) => {
    execFile(
      command,
      [...arguments_],
      {
        // Kills a wedged child (a known nvidia-smi failure mode on
        // sick GPUs/drivers) instead of leaking a pending handler.
        timeout: options?.timeoutMs,
        env: options?.env ? { ...process.env, ...options.env } : undefined,
        maxBuffer: options?.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
      },
      (error, stdout, stderr) => {
        let code = 0;
        if (error) {
          code = typeof error.code === "number" ? error.code : 1;
        }
        resolve({ code, stdout, stderr });
      },
    );
  });
