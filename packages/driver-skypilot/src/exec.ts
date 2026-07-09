import { execFile } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  timeoutMs?: number;
  env?: Record<string, string>;
}

/**
 * Process-execution boundary. Injectable so driver behaviour is fully
 * testable without a `sky` binary; the default implementation uses
 * execFile with an argv array (no shell interpolation).
 */
export type ExecFunction = (
  command: string,
  arguments_: readonly string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

export const defaultExec: ExecFunction = (command, arguments_, options) =>
  new Promise((resolve) => {
    execFile(
      command,
      [...arguments_],
      {
        timeout: options?.timeoutMs,
        env: options?.env ? { ...process.env, ...options.env } : undefined,
        maxBuffer: 16 * 1024 * 1024,
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

/** Raised when a `sky` CLI invocation exits non-zero. */
export class SkyCliError extends Error {
  readonly command: string;
  readonly code: number;
  readonly stderr: string;

  constructor(command: string, code: number, stderr: string) {
    super(`${command} exited ${code}: ${stderr.trim().slice(0, 500)}`);
    this.name = "SkyCliError";
    this.command = command;
    this.code = code;
    this.stderr = stderr;
  }
}
