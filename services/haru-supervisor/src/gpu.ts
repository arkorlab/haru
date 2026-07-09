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
      return {
        index: Number(index),
        usedMiB: Number(usedMiB),
        totalMiB: Number(totalMiB),
      };
    });
  return gpuMemorySchema.parse({ gpus });
}
