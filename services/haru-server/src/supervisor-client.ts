import {
  gpuMemorySchema,
  joinUrl,
  probeResponseSchema,
  supervisorStatusSchema,
  type GpuMemory,
  type ProbeResponse,
  type SupervisorStatus,
} from "@haru/protocol";

import type { z } from "zod";

/**
 * Raised on any supervisor call failure (network, timeout, non-2xx,
 * schema-invalid response). `status` carries the HTTP status when the
 * supervisor answered, so callers can distinguish permanent auth
 * failures (401/403) from transient unreachability.
 */
export class SupervisorError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "SupervisorError";
    this.status = status;
  }
}

export function isSupervisorAuthError(error: unknown): boolean {
  return (
    error instanceof SupervisorError &&
    (error.status === 401 || error.status === 403)
  );
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
    const response = await options.fetchFn(joinUrl(options.baseUrl, path), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new SupervisorError(
        `supervisor ${path} returned ${response.status}`,
        response.status,
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
 * Parse a supervisor response body, folding schema violations into
 * SupervisorError. A drifted supervisor version must surface as "this
 * supervisor call failed" (which callers treat per-domain), never as a
 * raw ZodError that aborts a whole reconcile tick.
 */
function parseAs<T>(schema: z.ZodType<T>, path: string, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new SupervisorError(
      `supervisor ${path} returned a schema-invalid body: ${result.error.message}`,
    );
  }
  return result.data;
}

/**
 * Thin typed client for the haru supervisor's control API. Every
 * method is a single short HTTP call bounded by `timeoutMs`; the
 * reconciler composes them into re-entrant step executors.
 */
export const supervisorClient = {
  async status(options: SupervisorClientOptions): Promise<SupervisorStatus> {
    return parseAs(
      supervisorStatusSchema,
      "/v1/status",
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
    return parseAs(
      gpuMemorySchema,
      "/v1/gpu/memory",
      await call(options, "GET", "/v1/gpu/memory"),
    );
  },
  async probe(
    options: SupervisorClientOptions,
    prompt: string,
    maxTokens: number,
    timeoutMs: number,
  ): Promise<ProbeResponse> {
    // The probe budget rides in the body so the supervisor's inner
    // per-model timers stay in sync with this client call's timeout;
    // otherwise a lowered policy budget would abort the HTTP call
    // while the supervisor keeps the vLLM request running.
    return parseAs(
      probeResponseSchema,
      "/v1/probe",
      await call(options, "POST", "/v1/probe", {
        prompt,
        maxTokens,
        timeoutMs,
      }),
    );
  },
};
