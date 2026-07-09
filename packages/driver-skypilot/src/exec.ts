import { mkdtemp, writeFile } from "node:fs/promises";
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
 * Write rendered YAML into a fresh temp directory and return its path,
 * somewhere the `sky` binary can read it. Injectable at the driver
 * level for tests.
 */
export async function writeTemporaryYaml(
  directoryPrefix: string,
  fileName: string,
  contents: string,
): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), directoryPrefix));
  const filePath = path.join(directory, fileName);
  await writeFile(filePath, contents, "utf8");
  return filePath;
}
