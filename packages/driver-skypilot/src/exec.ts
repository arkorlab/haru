import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { defaultExec } from "@haru/protocol";

import type { ExecFunction } from "@haru/protocol";

// The exec boundary itself lives in @haru/protocol (shared with the
// supervisor's nvidia-smi calls); re-exported here so both drivers
// keep importing from `@haru/driver-skypilot/exec`.
export { defaultExec } from "@haru/protocol";
export type { ExecFunction, ExecOptions, ExecResult } from "@haru/protocol";

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

/** Bound for `sky launch` / `sky serve up` (provisioning can take many
 * minutes). */
export const DEFAULT_SKY_LAUNCH_TIMEOUT_MS = 30 * 60 * 1000;
/** Bound for status/stop/down calls. */
export const DEFAULT_SKY_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Parse a `sky ... --format json` stdout, wrapping non-JSON output
 * (empty string, warning banners, truncation) in a typed SkyCliError
 * instead of letting a raw SyntaxError escape the driver boundary.
 */
export function parseStdoutJson(stdout: string, command: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SkyCliError(command, 0, `non-JSON stdout (${detail}): ${stdout}`);
  }
}

export type SkyRunner = (
  arguments_: readonly string[],
  timeoutMs: number,
) => Promise<string>;

/**
 * Wrap an exec boundary into a `sky <args>` runner that returns stdout
 * and raises a typed SkyCliError on non-zero exit. Shared by the
 * SkyPilot and SkyServe drivers (both drive the same `sky` binary).
 */
export function createSkyRunner(exec: ExecFunction = defaultExec): SkyRunner {
  return async (arguments_, timeoutMs) => {
    const result = await exec("sky", arguments_, { timeoutMs });
    if (result.code !== 0) {
      throw new SkyCliError(
        `sky ${arguments_.join(" ")}`,
        result.code,
        result.stderr,
      );
    }
    return result.stdout;
  };
}

/**
 * Write rendered YAML into a fresh temp directory, run `use` with the
 * file path, and remove the directory afterwards (including on error):
 * a long-running control plane repeatedly launching domains must not
 * accumulate temp directories.
 */
export async function withTemporaryYaml<T>(
  directoryPrefix: string,
  fileName: string,
  contents: string,
  use: (filePath: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), directoryPrefix));
  try {
    const filePath = path.join(directory, fileName);
    await writeFile(filePath, contents, "utf8");
    return await use(filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
