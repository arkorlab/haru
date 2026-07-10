import { describe, expect, it } from "vitest";

import { readGpuMemory, type ExecFunction } from "./gpu.js";

describe("readGpuMemory", () => {
  it("parses nvidia-smi CSV output", async () => {
    const exec: ExecFunction = (command, arguments_) => {
      expect(command).toBe("nvidia-smi");
      expect(arguments_).toContain("--format=csv,noheader,nounits");
      return Promise.resolve({
        code: 0,
        stdout: "0, 1234, 97887\n1, 96000, 97887\n",
        stderr: "",
      });
    };
    const memory = await readGpuMemory(exec);
    expect(memory.gpus).toEqual([
      { index: 0, usedMiB: 1234, totalMiB: 97_887 },
      { index: 1, usedMiB: 96_000, totalMiB: 97_887 },
    ]);
  });

  it("throws on a non-zero exit", async () => {
    const exec: ExecFunction = () =>
      Promise.resolve({ code: 9, stdout: "", stderr: "no devices" });
    await expect(readGpuMemory(exec)).rejects.toThrow("no devices");
  });

  it("rejects malformed rows via the schema", async () => {
    const exec: ExecFunction = () =>
      Promise.resolve({ code: 0, stdout: "0, abc, 97887\n", stderr: "" });
    await expect(readGpuMemory(exec)).rejects.toThrow();
  });
});
