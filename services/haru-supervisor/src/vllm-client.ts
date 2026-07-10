/**
 * Client for vLLM's local admin endpoints (sleep mode controls).
 *
 * These endpoints are development-mode controls (the servers must run
 * with sleep mode enabled and VLLM_SERVER_DEV_MODE=1) and are private
 * by construction: every vLLM server managed by this supervisor binds
 * to 127.0.0.1, so the only way to reach sleep/wake from outside the
 * host is through the supervisor's authenticated control API.
 */

import { fetchJsonWithTimeout, joinUrl } from "@haru/protocol";

export class VllmAdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VllmAdminError";
  }
}

const LOCAL_HOST = "127.0.0.1";
/** Sleep/wake move model weights and can legitimately take minutes. */
const ADMIN_CALL_TIMEOUT_MS = 120_000;
/**
 * /is_sleeping is an in-memory read polled on every /v1/status
 * heartbeat: it must never share the sleep/wake budget. Callers
 * (haru-server heartbeats) give up after ~5s, so a wedged vLLM
 * holding this fetch for two minutes would accumulate one stuck
 * local call per reconcile tick.
 */
const STATUS_CALL_TIMEOUT_MS = 5000;

async function adminCall(
  fetchFunction: typeof fetch,
  port: number,
  method: "GET" | "POST",
  pathAndQuery: string,
  timeoutMs: number,
): Promise<unknown> {
  try {
    // One timer bounds headers AND the JSON body read (the admin
    // endpoints all answer tiny JSON bodies).
    const { response, body } = await fetchJsonWithTimeout(
      fetchFunction,
      joinUrl(`http://${LOCAL_HOST}:${port}`, pathAndQuery),
      { method },
      timeoutMs,
    );
    if (!response.ok) {
      throw new VllmAdminError(
        `vLLM :${port} ${pathAndQuery} returned ${response.status}`,
      );
    }
    return body;
  } catch (error) {
    if (error instanceof VllmAdminError) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new VllmAdminError(
      `vLLM :${port} ${pathAndQuery} unreachable: ${detail}`,
    );
  }
}

/** Put the server to sleep. Level 1 offloads weights to CPU RAM and
 * discards the KV cache: the fastest wake path. */
export async function sleepServer(
  fetchFunction: typeof fetch,
  port: number,
  level: 1 = 1,
): Promise<void> {
  await adminCall(
    fetchFunction,
    port,
    "POST",
    `/sleep?level=${level}`,
    ADMIN_CALL_TIMEOUT_MS,
  );
}

/** Wake a sleeping server (no-op on an awake one). */
export async function wakeServer(
  fetchFunction: typeof fetch,
  port: number,
): Promise<void> {
  await adminCall(
    fetchFunction,
    port,
    "POST",
    "/wake_up",
    ADMIN_CALL_TIMEOUT_MS,
  );
}

/** Whether the server is currently asleep. */
export async function isServerSleeping(
  fetchFunction: typeof fetch,
  port: number,
): Promise<boolean> {
  const body = (await adminCall(
    fetchFunction,
    port,
    "GET",
    "/is_sleeping",
    STATUS_CALL_TIMEOUT_MS,
  )) as { is_sleeping?: unknown } | undefined;
  const sleeping: unknown = body?.is_sleeping;
  if (typeof sleeping !== "boolean") {
    // An empty or shape-drifted body proves NOTHING about the sleep
    // state; reporting "awake" here would let /v1/status mark the
    // domain ready on unverified servers. Throwing surfaces it as
    // sleeping: null (unknown) to status callers.
    throw new VllmAdminError(
      `vLLM :${port} /is_sleeping returned no boolean is_sleeping field`,
    );
  }
  return sleeping;
}
