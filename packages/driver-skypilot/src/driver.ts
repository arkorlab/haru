import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { z } from "zod";

import { defaultExec, SkyCliError, type ExecFunction } from "./exec.js";
import {
  skyClusterStatusSchema,
  type DomainLaunchSpec,
  type SkyClusterStatus,
  type SkypilotDriver,
} from "./types.js";
import { renderSkyTaskYaml } from "./yaml.js";

/** Writes rendered task YAML somewhere `sky` can read it; injectable. */
export type WriteTaskFileFunction = (contents: string) => Promise<string>;

const defaultWriteTaskFile: WriteTaskFileFunction = async (contents) => {
  const directory = await mkdtemp(path.join(tmpdir(), "haru-sky-"));
  const taskPath = path.join(directory, "task.yaml");
  await writeFile(taskPath, contents, "utf8");
  return taskPath;
};

export interface SkypilotDriverOptions {
  exec?: ExecFunction;
  writeTaskFile?: WriteTaskFileFunction;
  /** Bound for `sky launch` (provisioning can take many minutes). */
  launchTimeoutMs?: number;
  /** Bound for status/stop/down calls. */
  commandTimeoutMs?: number;
}

const DEFAULT_LAUNCH_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * SkyPilot driver: haru's lower-level multi-cloud provisioning
 * boundary. haru asks SkyPilot to create/stop/inspect GPU domains and
 * never talks to AWS/GCP APIs itself. Command shapes are pinned to the
 * SkyPilot version documented in the README.
 */
export function createSkypilotDriver(
  options: SkypilotDriverOptions = {},
): SkypilotDriver {
  const exec = options.exec ?? defaultExec;
  const writeTaskFile = options.writeTaskFile ?? defaultWriteTaskFile;
  const launchTimeoutMs = options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
  const commandTimeoutMs =
    options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;

  async function runSky(
    arguments_: readonly string[],
    timeoutMs: number,
  ): Promise<string> {
    const result = await exec("sky", arguments_, { timeoutMs });
    if (result.code !== 0) {
      throw new SkyCliError(
        `sky ${arguments_.join(" ")}`,
        result.code,
        result.stderr,
      );
    }
    return result.stdout;
  }

  return {
    async launchDomain(spec: DomainLaunchSpec) {
      const taskPath = await writeTaskFile(renderSkyTaskYaml(spec));
      await runSky(
        ["launch", "--cluster", spec.clusterName, "--yes", taskPath],
        launchTimeoutMs,
      );
      return { clusterName: spec.clusterName };
    },

    async getDomainStatus(
      clusterName: string,
    ): Promise<SkyClusterStatus | null> {
      const stdout = await runSky(
        ["status", clusterName, "--format", "json"],
        commandTimeoutMs,
      );
      const parsed = z
        .array(skyClusterStatusSchema)
        .safeParse(JSON.parse(stdout));
      if (!parsed.success) {
        throw new SkyCliError(
          `sky status ${clusterName}`,
          0,
          `unparseable status output: ${parsed.error.message}`,
        );
      }
      return parsed.data.find((c) => c.name === clusterName) ?? null;
    },

    async stopDomain(clusterName: string) {
      await runSky(["stop", clusterName, "--yes"], commandTimeoutMs);
    },

    async teardownDomain(clusterName: string) {
      await runSky(["down", clusterName, "--yes"], commandTimeoutMs);
    },
  };
}
