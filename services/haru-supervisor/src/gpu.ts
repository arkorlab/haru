import {
  describeExecFailure,
  gpuMemorySchema,
  type ExecFunction,
  type GpuMemory,
} from "@haru/protocol";

// Re-exported for existing importers; the boundary now lives in
// @haru/protocol so drivers and the supervisor share one exec shape.
export type { ExecFunction, ExecResult } from "@haru/protocol";

const NVIDIA_SMI_ARGS = [
  "--query-gpu=index,memory.used,memory.total",
  "--format=csv,noheader,nounits",
] as const;

/**
 * Read per-GPU memory usage via nvidia-smi. The exec boundary is
 * injectable so tests never need a GPU.
 */
export async function readGpuMemory(exec: ExecFunction): Promise<GpuMemory> {
  const result = await exec("nvidia-smi", NVIDIA_SMI_ARGS);
  if (result.code !== 0) {
    // Shared formatter surfaces a missing binary / timeout kill (signal +
    // exec message) instead of an opaque "exited 1 with empty stderr".
    // Capped: this message rides verbatim into the /v1/gpu/memory 502
    // body, which must not embed up to the 16 MiB exec stderr buffer.
    throw new Error(
      `nvidia-smi ${describeExecFailure(result, { maxStderrChars: 500 })}`,
    );
  }
  const gpus = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const fields = line.split(",").map((v) => v.trim());
      if (fields.length !== 3) {
        // The query pins three columns (index, used, total); a different
        // count means the CSV shape drifted (driver change / injected
        // header), which the NaN guard below could otherwise mask.
        throw new TypeError(
          `nvidia-smi returned ${String(fields.length)} columns, expected 3 (index, used, total): "${line}"`,
        );
      }
      const [index, usedMiB, totalMiB] = fields;
      const parsed = {
        index: Number(index),
        usedMiB: Number(usedMiB),
        totalMiB: Number(totalMiB),
      };
      if (
        Number.isNaN(parsed.index) ||
        Number.isNaN(parsed.usedMiB) ||
        Number.isNaN(parsed.totalMiB)
      ) {
        // MIG instances and some drivers report "[N/A]" for memory
        // fields; surface the raw line so the operator sees WHY GPU
        // memory introspection is unavailable on this host instead of
        // a bare schema error.
        throw new TypeError(
          `nvidia-smi reported a non-numeric memory line (unsupported GPU/driver mode?): "${line}"`,
        );
      }
      return parsed;
    });
  return gpuMemorySchema.parse({ gpus });
}
