import {
  createSkyRunner,
  DEFAULT_SKY_COMMAND_TIMEOUT_MS,
  DEFAULT_SKY_LAUNCH_TIMEOUT_MS,
  SkyCliError,
  withTemporaryYaml,
} from "@haru/driver-skypilot/exec";

import {
  SERVICE_STATUSES,
  type ServiceLaunchSpec,
  type SkyserveDriver,
  type SkyServiceStatus,
} from "./types.js";
import { renderSkyServiceYaml } from "./yaml.js";

import type { ExecFunction } from "@haru/driver-skypilot/exec";

/** Injectable service-YAML writer (an injected writer owns its file's
 * lifecycle). */
export type WriteServiceFileFunction = (contents: string) => Promise<string>;

/** The CLI colorizes the status cell; tokens are matched on the bare
 * text. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replaceAll(/\u{1B}\[[0-9;]*m/gu, "");
}

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
      // `sky serve status` has NO machine-readable output flag (unlike
      // `sky status --output json`), so this scrapes the human table:
      // find the service's row (the name is the first column) and pick
      // the cell matching one of the DOCUMENTED service statuses.
      // Table layout may drift across releases, but the status
      // vocabulary is a documented CLI contract; a row with no
      // recognizable status surfaces as a typed error instead of a
      // silent null. Switch to an output flag if upstream grows one
      // (see KNOWN_ISSUES).
      const stdout = await runSky(
        ["serve", "status", serviceName],
        commandTimeoutMs,
      );
      const rows = stripAnsi(stdout)
        .split("\n")
        .map((line) => line.trim().split(/\s+/));
      const row = rows.find((tokens) => tokens[0] === serviceName);
      if (!row) {
        return null;
      }
      // Skip the NAME column (tokens[0], already matched against
      // serviceName) when scanning for the status cell: a service whose
      // name happens to be a status token must not shadow the real
      // STATUS column.
      const status = row
        .slice(1)
        .find((token) =>
          (SERVICE_STATUSES as readonly string[]).includes(token),
        );
      if (status === undefined) {
        throw new SkyCliError(
          `sky serve status ${serviceName}`,
          0,
          `no documented status token in service row: ${row.join(" ")}`,
        );
      }
      return { name: serviceName, status };
    },

    async teardownService(serviceName: string) {
      await runSky(["serve", "down", serviceName, "--yes"], commandTimeoutMs);
    },
  };
}
