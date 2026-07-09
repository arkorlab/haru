import {
  createSkyRunner,
  DEFAULT_SKY_COMMAND_TIMEOUT_MS,
  DEFAULT_SKY_LAUNCH_TIMEOUT_MS,
  SkyCliError,
  writeTemporaryYaml,
} from "@haru/driver-skypilot/exec";
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

const defaultWriteServiceFile: WriteServiceFileFunction = (contents) =>
  writeTemporaryYaml("haru-skyserve-", "service.yaml", contents);

export interface SkyserveDriverOptions {
  exec?: ExecFunction;
  writeServiceFile?: WriteServiceFileFunction;
  launchTimeoutMs?: number;
  commandTimeoutMs?: number;
}

/**
 * SkyServe driver: the serving-oriented orchestration boundary.
 * Reuses the SkyPilot exec + sky-runner boundary (both wrap the same
 * `sky` binary, which is deliberate and documented).
 */
export function createSkyserveDriver(
  options: SkyserveDriverOptions = {},
): SkyserveDriver {
  const runSky = createSkyRunner(options.exec);
  const writeServiceFile = options.writeServiceFile ?? defaultWriteServiceFile;
  const launchTimeoutMs =
    options.launchTimeoutMs ?? DEFAULT_SKY_LAUNCH_TIMEOUT_MS;
  const commandTimeoutMs =
    options.commandTimeoutMs ?? DEFAULT_SKY_COMMAND_TIMEOUT_MS;

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
