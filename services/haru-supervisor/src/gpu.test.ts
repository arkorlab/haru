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

  it("bounds the non-numeric-line message for oversized 3-field garbage", async () => {
    const exec: ExecFunction = () =>
      // Exactly three fields, so the column guard passes; the huge
      // non-numeric first field must still be capped in the message.
      Promise.resolve({
        code: 0,
        stdout: `${"x".repeat(100_000)}, y, z\n`,
        stderr: "",
      });
    let error: unknown;
    try {
      await readGpuMemory(exec);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toContain("non-numeric");
    expect((error as Error).message.length).toBeLessThan(700);
  });

  it("bounds the column-guard message for an oversized malformed line", async () => {
    const exec: ExecFunction = () =>
      // A successful run (code 0) whose single line is huge and
      // malformed: the preview cap must hold, like the failure path.
      Promise.resolve({ code: 0, stdout: "x".repeat(100_000), stderr: "" });
    let error: unknown;
    try {
      await readGpuMemory(exec);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message.length).toBeLessThan(700);
  });

  it("rejects a drifted column count instead of masking it", async () => {
    const exec: ExecFunction = () =>
      // Four columns (driver drift / injected header): the count guard
      // must reject rather than silently reading the wrong ratio.
      Promise.resolve({ code: 0, stdout: "0, 1234, 97887, 55\n", stderr: "" });
    await expect(readGpuMemory(exec)).rejects.toThrow(/expected 3/);
  });

  it("surfaces the signal from a timeout-killed nvidia-smi", async () => {
    const exec: ExecFunction = () =>
      Promise.resolve({
        code: 1,
        stdout: "",
        stderr: "",
        signal: "SIGTERM",
        // defaultExec deliberately leaves errorMessage null for a
        // signal kill (Node's kill message embeds the full stderr);
        // the mock mirrors the real timeout-kill shape.
        errorMessage: null,
      });
    await expect(readGpuMemory(exec)).rejects.toThrow("signal SIGTERM");
  });

  it("bounds the error message even when nvidia-smi floods stderr", async () => {
    const exec: ExecFunction = () =>
      Promise.resolve({ code: 9, stdout: "", stderr: "x".repeat(100_000) });
    // The message rides into the /v1/gpu/memory 502 body: capped, never
    // the full exec stderr buffer.
    let error: unknown;
    try {
      await readGpuMemory(exec);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message.length).toBeLessThan(700);
  });

  it("surfaces the exec message from a spawn failure", async () => {
    const exec: ExecFunction = () =>
      Promise.resolve({
        code: 1,
        stdout: "",
        stderr: "",
        signal: null,
        errorMessage: "spawn nvidia-smi ENOENT",
      });
    await expect(readGpuMemory(exec)).rejects.toThrow("ENOENT");
  });
});
