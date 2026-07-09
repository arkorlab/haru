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

  it("parses service status and maps failures to SkyCliError", async () => {
    const { exec } = recordingExec({
      status: {
        code: 0,
        stdout: JSON.stringify([
          { name: "haru-default-serve", status: "READY", replicas: 2 },
        ]),
        stderr: "",
      },
    });
    const driver = createSkyserveDriver({ exec });
    const status = await driver.getServiceStatus("haru-default-serve");
    expect(status?.status).toBe("READY");

    const failing = createSkyserveDriver({
      exec: () =>
        Promise.resolve({ code: 1, stdout: "", stderr: "not logged in" }),
    });
    await expect(failing.getServiceStatus("x")).rejects.toThrow(SkyCliError);
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
