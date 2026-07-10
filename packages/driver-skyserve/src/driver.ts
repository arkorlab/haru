import {
  createSkyRunner,
  DEFAULT_SKY_COMMAND_TIMEOUT_MS,
  DEFAULT_SKY_LAUNCH_TIMEOUT_MS,
  parseStdoutJson,
  SkyCliError,
  withTemporaryYaml,
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

/** Injectable service-YAML writer (an injected writer owns its file's
 * lifecycle). */
export type WriteServiceFileFunction = (contents: string) => Promise<string>;

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
  const writeServiceFile = options.writeServiceFile;
  const launchTimeoutMs =
    options.launchTimeoutMs ?? DEFAULT_SKY_LAUNCH_TIMEOUT_MS;
  const commandTimeoutMs =
    options.commandTimeoutMs ?? DEFAULT_SKY_COMMAND_TIMEOUT_MS;

  return {
    async launchService(spec: ServiceLaunchSpec) {
      const launch = (servicePath: string) =>
        runSky(
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
      // Default path scopes the YAML's temp directory to the sky call.
      if (writeServiceFile) {
        await launch(await writeServiceFile(renderSkyServiceYaml(spec)));
      } else {
        await withTemporaryYaml(
          "haru-skyserve-",
          "service.yaml",
          renderSkyServiceYaml(spec),
          launch,
        );
      }
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
        .safeParse(parseStdoutJson(stdout, `sky serve status ${serviceName}`));
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
