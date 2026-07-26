import {
  SkyCliError,
  type ExecFunction,
  type ExecResult,
} from "@haru/driver-skypilot/exec";
import { describe, expect, it } from "vitest";

import { createSkyserveDriver } from "./driver.js";
import { renderSkyServiceYaml } from "./yaml.js";

import type { ServiceLaunchSpec } from "./types.js";

const SPEC: ServiceLaunchSpec = {
  serviceName: "haru-default-serve",
  placement: {
    cloud: "gcp",
    region: "us-central1",
    accelerator: "EXAMPLE-GPU",
    acceleratorCount: 1,
    useSpot: true,
  },
  servicePort: 9001,
  readinessProbePath: "/v1/models",
  replicas: 2,
  envs: { EXAMPLE: "1" },
  setup: "pip install vllm\n",
  run: "serve\n",
};

interface RecordedCall {
  args: readonly string[];
  timeoutMs: number | undefined;
}

function recordingExec(results: Partial<Record<string, ExecResult>> = {}): {
  exec: ExecFunction;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const exec: ExecFunction = (_command, arguments_, options) => {
    calls.push({ args: arguments_, timeoutMs: options?.timeoutMs });
    const key = arguments_[1] ?? "";
    return Promise.resolve(
      results[key] ?? { code: 0, stdout: "[]", stderr: "" },
    );
  };
  return { exec, calls };
}

describe("renderSkyServiceYaml", () => {
  it("adds the service block on top of the shared placement mapping", () => {
    const yaml = renderSkyServiceYaml(SPEC);
    expect(yaml).toContain("name: haru-default-serve");
    expect(yaml).toContain("readiness_probe:");
    expect(yaml).toContain("path: /v1/models");
    expect(yaml).toContain("replicas: 2");
    expect(yaml).toContain("cloud: gcp");
    expect(yaml).toContain("use_spot: true");
    expect(yaml).toContain("- 9001");
  });

  it("quotes YAML-1.1-ambiguous env values so PyYAML keeps them strings", () => {
    // SkyServe reads service YAML with PyYAML (YAML 1.1); `off`/`no`/`y`
    // and sexagesimal `12:34:56` must stay quoted strings, not booleans
    // or base-60 integers.
    const yaml = renderSkyServiceYaml({
      ...SPEC,
      envs: { VLLM_FLAG: "off", SHORT: "n", WINDOW: "12:34:56" },
    });
    expect(yaml).toContain('VLLM_FLAG: "off"');
    expect(yaml).toContain('SHORT: "n"');
    expect(yaml).toContain('WINDOW: "12:34:56"');
    expect(yaml).toContain("use_spot: true");
  });
});

describe("createSkyserveDriver", () => {
  it("launches through sky serve up with the rendered file", async () => {
    const { exec, calls } = recordingExec();
    const written: string[] = [];
    const driver = createSkyserveDriver({
      exec,
      writeServiceFile: (contents) => {
        written.push(contents);
        return Promise.resolve("/tmp/service.yaml");
      },
      launchTimeoutMs: 2500,
    });
    await driver.launchService(SPEC);
    expect(written[0]).toContain("replicas: 2");
    expect(calls[0]?.args).toEqual([
      "serve",
      "up",
      "--service-name",
      "haru-default-serve",
      "--yes",
      "/tmp/service.yaml",
    ]);
    expect(calls[0]?.timeoutMs).toBe(2500);
  });

  it("scrapes the documented status from the human table", async () => {
    // `sky serve status` has no JSON flag; the driver matches the
    // documented status vocabulary in the service's (colorized) row.
    const table = [
      "\u{1B}[36m\u{1B}[1mServices\u{1B}[0m",
      "NAME                VERSION  UPTIME  STATUS  REPLICAS  ENDPOINT",
      "haru-default-serve  1        4m 16s  \u{1B}[32mREADY\u{1B}[0m   2/2       3.84.15.251:30001",
    ].join("\n");
    const { exec, calls } = recordingExec({
      status: { code: 0, stdout: table, stderr: "" },
    });
    const driver = createSkyserveDriver({ exec });
    const status = await driver.getServiceStatus("haru-default-serve");
    expect(status).toEqual({ name: "haru-default-serve", status: "READY" });
    expect(calls[0]?.args).toEqual(["serve", "status", "haru-default-serve"]);

    // No row for the service: it does not exist.
    expect(await driver.getServiceStatus("ghost")).toBeNull();
  });

  it("maps status failures to SkyCliError", async () => {
    const failing = createSkyserveDriver({
      exec: () =>
        Promise.resolve({ code: 1, stdout: "", stderr: "not logged in" }),
    });
    await expect(failing.getServiceStatus("x")).rejects.toThrow(SkyCliError);

    // A row exists but carries no documented status token (upstream
    // renamed a status): surface it, never silently report "absent".
    const drifted = createSkyserveDriver({
      exec: () =>
        Promise.resolve({
          code: 0,
          stdout: "svc-a  1  4m  SOME_NEW_STATE  1/1  1.2.3.4:1",
          stderr: "",
        }),
    });
    await expect(drifted.getServiceStatus("svc-a")).rejects.toThrow(
      /no documented status token/,
    );
  });

  it("tears down with confirmation", async () => {
    const { exec, calls } = recordingExec();
    const driver = createSkyserveDriver({ exec });
    await driver.teardownService("haru-default-serve");
    expect(calls[0]?.args).toEqual([
      "serve",
      "down",
      "haru-default-serve",
      "--yes",
    ]);
  });
});
