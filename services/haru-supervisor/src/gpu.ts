import { gpuMemorySchema, type GpuMemory } from "@haru/protocol";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ExecFunction = (
  command: string,
  arguments_: readonly string[],
) => Promise<ExecResult>;

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
    throw new Error(`nvidia-smi exited ${result.code}: ${result.stderr}`);
  }
  const gpus = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const [index, usedMiB, totalMiB] = line.split(",").map((v) => v.trim());
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
