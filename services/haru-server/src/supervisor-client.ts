import {
  gpuMemorySchema,
  probeResponseSchema,
  supervisorStatusSchema,
  type GpuMemory,
  type ProbeResponse,
  type SupervisorStatus,
} from "@haru/protocol";

/** Raised on any supervisor call failure (network, timeout, non-2xx). */
export class SupervisorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupervisorError";
  }
}

export interface SupervisorClientOptions {
  fetchFn: typeof fetch;
  baseUrl: string;
  token: string | undefined;
  timeoutMs: number;
}

async function call(
  options: SupervisorClientOptions,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs);
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (options.token !== undefined && options.token !== "") {
    headers.authorization = `Bearer ${options.token}`;
  }
  try {
    const response = await options.fetchFn(
      new URL(path, options.baseUrl).href,
      {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      throw new SupervisorError(
        `supervisor ${path} returned ${response.status}`,
      );
    }
    return (await response.json()) as unknown;
  } catch (error) {
    if (error instanceof SupervisorError) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new SupervisorError(`supervisor ${path} unreachable: ${detail}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Thin typed client for the haru supervisor's control API. Every
 * method is a single short HTTP call bounded by `timeoutMs`; the
 * reconciler composes them into re-entrant step executors.
 */
export const supervisorClient = {
  async status(options: SupervisorClientOptions): Promise<SupervisorStatus> {
    return supervisorStatusSchema.parse(
      await call(options, "GET", "/v1/status"),
    );
  },
  async stopTraining(
    options: SupervisorClientOptions,
    graceMs: number,
  ): Promise<void> {
    await call(options, "POST", "/v1/training/stop", { graceMs });
  },
  async startTraining(options: SupervisorClientOptions): Promise<void> {
    await call(options, "POST", "/v1/training/start", {});
  },
  async wake(options: SupervisorClientOptions): Promise<void> {
    await call(options, "POST", "/v1/vllm/wake", {});
  },
  async sleep(options: SupervisorClientOptions): Promise<void> {
    await call(options, "POST", "/v1/vllm/sleep", {});
  },
  async gpuMemory(options: SupervisorClientOptions): Promise<GpuMemory> {
    return gpuMemorySchema.parse(await call(options, "GET", "/v1/gpu/memory"));
  },
  async probe(
    options: SupervisorClientOptions,
    prompt: string,
    maxTokens: number,
  ): Promise<ProbeResponse> {
    return probeResponseSchema.parse(
      await call(options, "POST", "/v1/probe", { prompt, maxTokens }),
    );
  },
};
