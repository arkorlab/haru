import { execFile } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  /**
   * The signal that killed the child, or null. A `timeoutMs` kill
   * surfaces here (e.g. "SIGTERM") so a caller can tell a timed-out
   * `sky launch` (cloud provisioning may still be running) from a
   * genuine non-zero exit. Optional so existing fake execs keep
   * type-checking.
   */
  signal?: NodeJS.Signals | null;
  /**
   * The execFile error message for a NON-exit failure - a missing
   * binary (ENOENT), a timeout kill, or a maxBuffer overflow - where
   * `code` is a synthesized 1 that says nothing about WHY. null on a
   * clean run or a real numeric exit code. Optional for the same
   * back-compat reason as `signal`.
   */
  errorMessage?: string | null;
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

/**
 * Human-readable tail describing a failed exec:
 * `exited <code> (<errorMessage>, signal <SIGNAL>): <stderr>`. The
 * signal/errorMessage parenthetical surfaces a timeout kill or missing
 * binary (otherwise an opaque "exited 1"); empty parts are dropped, and
 * the `: <stderr>` is omitted entirely when stderr is blank (so a
 * signal-only failure never dangles a trailing colon). Shared so every
 * exec consumer (sky CLI, nvidia-smi) renders failures identically;
 * callers prepend the command name.
 */
export function describeExecFailure(
  result: Pick<ExecResult, "code" | "signal" | "errorMessage" | "stderr">,
  // maxStderrChars, not bytes: `.slice` counts UTF-16 code units (as the
  // prior stderr.slice(0, 500) did), which is fine for a length bound on
  // an error string.
  options?: { maxStderrChars?: number },
): string {
  const max = options?.maxStderrChars;
  // The cap covers errorMessage too, not just stderr: a downstream caller
  // that bounds its message (SkyCliError) must stay bounded even if some
  // errorMessage embeds output (defaultExec already avoids the signal-kill
  // case, but keep the formatter self-contained).
  const cap = (value: string): string =>
    max === undefined ? value : value.slice(0, max);
  const parts = [
    result.errorMessage ? cap(result.errorMessage) : undefined,
    result.signal ? `signal ${result.signal}` : undefined,
    // Drop undefined AND empty strings so a blank errorMessage never
    // renders as an empty "()" fragment.
  ].filter((part) => part !== undefined && part !== "");
  const cause = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  const stderr = cap(result.stderr.trim());
  const detail = stderr === "" ? "" : `: ${stderr}`;
  return `exited ${String(result.code)}${cause}${detail}`;
}

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
        let signal: NodeJS.Signals | null = null;
        let errorMessage: string | null = null;
        if (error) {
          signal = error.signal ?? null;
          if (typeof error.code === "number") {
            code = error.code;
          } else {
            // Not a real exit code (spawn failure or kill): synthesize 1.
            // Keep the message ONLY for a STRING-coded failure (ENOENT /
            // EACCES, or maxBuffer's ERR_CHILD_PROCESS_STDIO_MAXBUFFER) -
            // those carry a short, useful reason. A signal kill (code
            // null, signal set) leaves errorMessage null on purpose: Node
            // embeds the ENTIRE captured stderr in that message
            // ("Command failed: <cmd>\n<stderr>"), which `signal` plus the
            // separately-captured `stderr` already convey, so keeping it
            // would duplicate the stderr and blow any downstream cap.
            code = 1;
            if (typeof error.code === "string") {
              errorMessage = error.message;
            }
          }
        }
        resolve({ code, stdout, stderr, signal, errorMessage });
      },
    );
  });
