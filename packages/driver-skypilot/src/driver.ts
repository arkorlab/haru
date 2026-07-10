import { z } from "zod";

import {
  createSkyRunner,
  DEFAULT_SKY_COMMAND_TIMEOUT_MS,
  DEFAULT_SKY_LAUNCH_TIMEOUT_MS,
  parseStdoutJson,
  SkyCliError,
  withTemporaryYaml,
  type ExecFunction,
} from "./exec.js";
import {
  skyClusterStatusSchema,
  type DomainLaunchSpec,
  type SkyClusterStatus,
  type SkypilotDriver,
} from "./types.js";
import { renderSkyTaskYaml } from "./yaml.js";

/** Writes rendered task YAML somewhere `sky` can read it; injectable
 * (an injected writer owns its file's lifecycle). */
export type WriteTaskFileFunction = (contents: string) => Promise<string>;

export interface SkypilotDriverOptions {
  exec?: ExecFunction;
  writeTaskFile?: WriteTaskFileFunction;
  /** Bound for `sky launch` (provisioning can take many minutes). */
  launchTimeoutMs?: number;
  /** Bound for status/stop/down calls. */
  commandTimeoutMs?: number;
}

/**
 * SkyPilot driver: haru's lower-level multi-cloud provisioning
 * boundary. haru asks SkyPilot to create/stop/inspect GPU domains and
 * never talks to AWS/GCP APIs itself. Command shapes are pinned to the
 * SkyPilot version documented in the README.
 */
export function createSkypilotDriver(
  options: SkypilotDriverOptions = {},
): SkypilotDriver {
  const runSky = createSkyRunner(options.exec);
  const writeTaskFile = options.writeTaskFile;
  const launchTimeoutMs =
    options.launchTimeoutMs ?? DEFAULT_SKY_LAUNCH_TIMEOUT_MS;
  const commandTimeoutMs =
    options.commandTimeoutMs ?? DEFAULT_SKY_COMMAND_TIMEOUT_MS;

  return {
    async launchDomain(spec: DomainLaunchSpec) {
      const launch = (taskPath: string) =>
        runSky(
          ["launch", "--cluster", spec.clusterName, "--yes", taskPath],
          launchTimeoutMs,
        );
      // The default path scopes the rendered YAML to the sky call and
      // removes its temp directory afterwards; an injected writer owns
      // its file's lifecycle itself.
      if (writeTaskFile) {
        await launch(await writeTaskFile(renderSkyTaskYaml(spec)));
      } else {
        await withTemporaryYaml(
          "haru-sky-",
          "task.yaml",
          renderSkyTaskYaml(spec),
          launch,
        );
      }
      return { clusterName: spec.clusterName };
    },

    async getDomainStatus(
      clusterName: string,
    ): Promise<SkyClusterStatus | null> {
      // `-o/--output json` is the documented output-format flag on
      // `sky status` (there is no `--format`).
      const stdout = await runSky(
        ["status", clusterName, "--output", "json"],
        commandTimeoutMs,
      );
      const parsed = z
        .array(skyClusterStatusSchema)
        .safeParse(parseStdoutJson(stdout, `sky status ${clusterName}`));
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
