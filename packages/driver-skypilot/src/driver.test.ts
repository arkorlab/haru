import { describe, expect, it } from "vitest";

import { createSkypilotDriver } from "./driver.js";
import { SkyCliError, type ExecFunction, type ExecResult } from "./exec.js";
import { renderSkyTaskYaml } from "./yaml.js";

import type { DomainLaunchSpec } from "./types.js";

const SPEC: DomainLaunchSpec = {
  clusterName: "haru-default-alpha",
  placement: {
    cloud: "aws",
    region: "us-east-1",
    accelerator: "EXAMPLE-GPU",
    acceleratorCount: 2,
    useSpot: false,
  },
  ports: [8701, 9001, 9002],
  envs: { HARU_SUPERVISOR_TOKEN: "secret" },
  setup: "pip install vllm\n",
  run: "haru-supervisor\n",
};

interface RecordedCall {
  command: string;
  args: readonly string[];
  timeoutMs: number | undefined;
}

function recordingExec(results: Partial<Record<string, ExecResult>> = {}): {
  exec: ExecFunction;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const exec: ExecFunction = (command, arguments_, options) => {
    calls.push({ command, args: arguments_, timeoutMs: options?.timeoutMs });
    const key = arguments_[0] ?? "";
    return Promise.resolve(
      results[key] ?? { code: 0, stdout: "[]", stderr: "" },
    );
  };
  return { exec, calls };
}

describe("renderSkyTaskYaml", () => {
  it("translates placement into SkyPilot resources", () => {
    const yaml = renderSkyTaskYaml(SPEC);
    expect(yaml).toContain("name: haru-default-alpha");
    expect(yaml).toContain("cloud: aws");
    expect(yaml).toContain("region: us-east-1");
    expect(yaml).toContain("accelerators: EXAMPLE-GPU:2");
    expect(yaml).toContain("use_spot: false");
    expect(yaml).toContain("- 8701");
    expect(yaml).toContain("HARU_SUPERVISOR_TOKEN: secret");
  });

  it("expresses gcp + spot purely as data", () => {
    const yaml = renderSkyTaskYaml({
      ...SPEC,
      placement: {
        cloud: "gcp",
        region: "us-central1",
        accelerator: "EXAMPLE-GPU",
        acceleratorCount: 1,
        useSpot: true,
      },
    });
    expect(yaml).toContain("cloud: gcp");
    expect(yaml).toContain("use_spot: true");
    expect(yaml).toContain("accelerators: EXAMPLE-GPU:1");
  });

  it("omits empty envs and ports blocks", () => {
    const yaml = renderSkyTaskYaml({ ...SPEC, ports: [], envs: {} });
    expect(yaml).not.toContain("envs:");
    expect(yaml).not.toContain("ports:");
  });
});

describe("createSkypilotDriver", () => {
  it("launches with the rendered task file and cluster name", async () => {
    const { exec, calls } = recordingExec({
      launch: { code: 0, stdout: "", stderr: "" },
    });
    const written: string[] = [];
    const driver = createSkypilotDriver({
      exec,
      writeTaskFile: (contents) => {
        written.push(contents);
        return Promise.resolve("/tmp/task.yaml");
      },
      launchTimeoutMs: 1000,
    });
    const result = await driver.launchDomain(SPEC);
    expect(result).toEqual({ clusterName: "haru-default-alpha" });
    expect(written[0]).toContain("accelerators: EXAMPLE-GPU:2");
    expect(calls[0]?.command).toBe("sky");
    expect(calls[0]?.args).toEqual([
      "launch",
      "--cluster",
      "haru-default-alpha",
      "--yes",
      "/tmp/task.yaml",
    ]);
    expect(calls[0]?.timeoutMs).toBe(1000);
  });

  it("maps a non-zero exit to SkyCliError", async () => {
    const { exec } = recordingExec({
      launch: { code: 2, stdout: "", stderr: "quota exceeded" },
    });
    const driver = createSkypilotDriver({
      exec,
      writeTaskFile: () => Promise.resolve("/tmp/task.yaml"),
    });
    await expect(driver.launchDomain(SPEC)).rejects.toThrow(SkyCliError);
    await expect(driver.launchDomain(SPEC)).rejects.toThrow("quota exceeded");
  });

  it("parses sky status json and finds the cluster", async () => {
    const { exec, calls } = recordingExec({
      status: {
        code: 0,
        stdout: JSON.stringify([
          { name: "other", status: "STOPPED", extra: 1 },
          { name: "haru-default-alpha", status: "UP", launched_at: 123 },
        ]),
        stderr: "",
      },
    });
    const driver = createSkypilotDriver({ exec });
    const status = await driver.getDomainStatus("haru-default-alpha");
    expect(status?.status).toBe("UP");
    expect(calls[0]?.args).toEqual([
      "status",
      "haru-default-alpha",
      "--output",
      "json",
    ]);
  });

  it("returns null for an unknown cluster", async () => {
    const { exec } = recordingExec({
      status: { code: 0, stdout: "[]", stderr: "" },
    });
    const driver = createSkypilotDriver({ exec });
    expect(await driver.getDomainStatus("ghost")).toBeNull();
  });

  it("stops and tears down with confirmation flags", async () => {
    const { exec, calls } = recordingExec();
    const driver = createSkypilotDriver({ exec });
    await driver.stopDomain("haru-default-alpha");
    await driver.teardownDomain("haru-default-alpha");
    expect(calls.map((c) => c.args)).toEqual([
      ["stop", "haru-default-alpha", "--yes"],
      ["down", "haru-default-alpha", "--yes"],
    ]);
  });
});
