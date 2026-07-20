import {
  fetchJsonWithTimeout,
  gpuMemorySchema,
  joinUrl,
  probeResponseSchema,
  SUPERVISOR_INNER_TIMEOUT_KIND,
  supervisorInnerTimeoutMs,
  SUPERVISOR_STATUS_MODEL_TIMEOUT_MS,
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

/**
 * Keep selector-bearing supervisor URLs below common proxy/request-line
 * limits. This is NOT a model-name/count product limit: if the encoded
 * selector exceeds it, the call falls back to the legacy all-model
 * shape and the server still applies its layout-bound verdict locally.
 */
const MAX_SUPERVISOR_QUERY_CHARACTERS = 4096;

async function call(
  options: SupervisorClientOptions,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (options.token !== undefined && options.token !== "") {
    headers.authorization = `Bearer ${options.token}`;
  }
  try {
    // One timer bounds headers AND the JSON body read: a supervisor
    // that answers headers then stalls the body must not hang the
    // reconcile tick past timeoutMs.
    const { response, body: responseBody } = await fetchJsonWithTimeout(
      options.fetchFn,
      joinUrl(options.baseUrl, path),
      {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      options.timeoutMs,
    );
    if (!response.ok) {
      throw new SupervisorError(
        `supervisor ${path} returned ${response.status}`,
        response.status,
      );
    }
    return responseBody;
  } catch (error) {
    if (error instanceof SupervisorError) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new SupervisorError(`supervisor ${path} unreachable: ${detail}`);
  }
}

/**
 * Select only the layout-bound models on status/probe calls. Query
 * parameters preserve compatibility with older supervisors, which
 * ignore them and retain their all-model behaviour. A lone empty
 * `model` value represents an explicit empty selection; omission
 * continues to mean all configured models.
 */
function pathWithModelSelector(
  path: string,
  modelNames: readonly string[] | undefined,
  timeoutMs?: number,
): string {
  const query = new URLSearchParams();
  if (modelNames !== undefined) {
    const uniqueModelNames = [...new Set(modelNames)];
    if (uniqueModelNames.length === 0) {
      query.append("model", "");
    } else {
      for (const modelName of uniqueModelNames) {
        query.append("model", modelName);
      }
    }
  }
  if (timeoutMs !== undefined) {
    query.set("timeoutMs", String(timeoutMs));
  }
  let serialized = query.toString();
  if (
    modelNames !== undefined &&
    serialized.length > MAX_SUPERVISOR_QUERY_CHARACTERS
  ) {
    // Drop ONLY the optimization selector. In particular, status must
    // retain its shorter inner timeout so an all-model fallback cannot
    // consume the outer heartbeat budget.
    const fallbackQuery = new URLSearchParams();
    if (timeoutMs !== undefined) {
      fallbackQuery.set("timeoutMs", String(timeoutMs));
    }
    // The selector was dropped, so model absence alone would look like
    // an old client's outer-timeout request to a new supervisor. Mark
    // the preserved timeout as already-inner to prevent a second
    // headroom subtraction. Old supervisors ignore this query key.
    fallbackQuery.set("timeoutKind", SUPERVISOR_INNER_TIMEOUT_KIND);
    serialized = fallbackQuery.toString();
  }
  return serialized === "" ? path : `${path}?${serialized}`;
}

function withFrozenTimeout(
  options: SupervisorClientOptions,
  timeoutMs: number,
): SupervisorClientOptions {
  // Spell out the fields: spreading `options` would evaluate a
  // clock-backed timeout getter a second time before this override.
  return {
    fetchFn: options.fetchFn,
    baseUrl: options.baseUrl,
    token: options.token,
    timeoutMs,
  };
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
  async status(
    options: SupervisorClientOptions,
    modelNames?: readonly string[],
  ): Promise<SupervisorStatus> {
    // Freeze a potentially clock-backed getter exactly once. The
    // supervisor receives a strictly shorter per-vLLM timeout, leaving
    // headroom to serialize and return sleeping:null before this HTTP
    // call's outer timer fires.
    const outerTimeoutMs = options.timeoutMs;
    const innerTimeoutMs = Math.min(
      SUPERVISOR_STATUS_MODEL_TIMEOUT_MS,
      supervisorInnerTimeoutMs(outerTimeoutMs),
    );
    const path = pathWithModelSelector(
      "/v1/status",
      modelNames,
      innerTimeoutMs,
    );
    return parseAs(
      supervisorStatusSchema,
      "/v1/status",
      await call(withFrozenTimeout(options, outerTimeoutMs), "GET", path),
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
    modelNames: readonly string[],
  ): Promise<ProbeResponse> {
    // Freeze the remaining step budget exactly once. The shorter
    // timeout rides in the body while the full value bounds this HTTP
    // exchange, so the supervisor can report per-model timeout results
    // before the reconciler stops waiting.
    const outerTimeoutMs = options.timeoutMs;
    const innerTimeoutMs = supervisorInnerTimeoutMs(outerTimeoutMs);
    const path = pathWithModelSelector("/v1/probe", modelNames);
    return parseAs(
      probeResponseSchema,
      "/v1/probe",
      await call(withFrozenTimeout(options, outerTimeoutMs), "POST", path, {
        prompt,
        maxTokens,
        timeoutMs: innerTimeoutMs,
      }),
    );
  },
};
