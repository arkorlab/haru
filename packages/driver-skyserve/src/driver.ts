import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { defaultExec, SkyCliError } from "@haru/driver-skypilot/exec";
import { z } from "zod";

import {
  skyServiceStatusSchema,
  type ServiceLaunchSpec,
  type SkyserveDriver,
  type SkyServiceStatus,
} from "./types.js";
import { renderSkyServiceYaml } from "./yaml.js";

import type { ExecFunction } from "@haru/driver-skypilot/exec";

export type WriteServiceFileFunction = (contents: string) => Promise<string>;

const defaultWriteServiceFile: WriteServiceFileFunction = async (contents) => {
  const directory = await mkdtemp(path.join(tmpdir(), "haru-skyserve-"));
  const servicePath = path.join(directory, "service.yaml");
  await writeFile(servicePath, contents, "utf8");
  return servicePath;
};

export interface SkyserveDriverOptions {
  exec?: ExecFunction;
  writeServiceFile?: WriteServiceFileFunction;
  launchTimeoutMs?: number;
  commandTimeoutMs?: number;
}

const DEFAULT_LAUNCH_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * SkyServe driver: the serving-oriented orchestration boundary.
 * Reuses the SkyPilot exec boundary (both wrap the same `sky` binary,
 * which is deliberate and documented).
 */
export function createSkyserveDriver(
  options: SkyserveDriverOptions = {},
): SkyserveDriver {
  const exec = options.exec ?? defaultExec;
  const writeServiceFile = options.writeServiceFile ?? defaultWriteServiceFile;
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
    async launchService(spec: ServiceLaunchSpec) {
      const servicePath = await writeServiceFile(renderSkyServiceYaml(spec));
      await runSky(
        [
          "serve",
          "up",
          "--service-name",
          spec.serviceName,
          "--yes",
          servicePath,
        ],
        launchTimeoutMs,
      );
      return { serviceName: spec.serviceName };
    },

    async getServiceStatus(
      serviceName: string,
    ): Promise<SkyServiceStatus | null> {
      const stdout = await runSky(
        ["serve", "status", serviceName, "--format", "json"],
        commandTimeoutMs,
      );
      const parsed = z
        .array(skyServiceStatusSchema)
        .safeParse(JSON.parse(stdout));
      if (!parsed.success) {
        throw new SkyCliError(
          `sky serve status ${serviceName}`,
          0,
          `unparseable status output: ${parsed.error.message}`,
        );
      }
      return parsed.data.find((s) => s.name === serviceName) ?? null;
    },

    async teardownService(serviceName: string) {
      await runSky(["serve", "down", serviceName, "--yes"], commandTimeoutMs);
    },
  };
}
