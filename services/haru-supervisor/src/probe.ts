import type { ProbeResult } from "@haru/protocol";

/** Fallback when the caller does not send a probe budget. */
export const DEFAULT_PROBE_CALL_TIMEOUT_MS = 60_000;

/**
 * Run one synthetic (non-streaming) chat completion against a local
 * vLLM server and report success + latency. Used by the promotion
 * flow to prove a freshly woken server actually generates tokens
 * before routing flips to it. `timeoutMs` comes from the caller's
 * probe budget so the local vLLM request never outlives the caller's
 * own wait.
 */
export async function probeModel(
  fetchFunction: typeof fetch,
  now: () => number,
  model: { name: string; port: number },
  prompt: string,
  maxTokens: number,
  timeoutMs: number = DEFAULT_PROBE_CALL_TIMEOUT_MS,
): Promise<ProbeResult> {
  const startedAt = now();
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetchFunction(
      `http://127.0.0.1:${model.port}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: model.name,
          messages: [{ role: "user", content: prompt }],
          max_tokens: maxTokens,
          stream: false,
        }),
        signal: controller.signal,
      },
    );
    const latencyMs = now() - startedAt;
    if (!response.ok) {
      return {
        model: model.name,
        ok: false,
        latencyMs,
        error: `upstream returned ${response.status}`,
      };
    }
    const body = (await response.json()) as { choices?: unknown[] };
    const hasChoices = Array.isArray(body.choices) && body.choices.length > 0;
    if (!hasChoices) {
      return {
        model: model.name,
        ok: false,
        latencyMs,
        error: "completion returned no choices",
      };
    }
    return { model: model.name, ok: true, latencyMs };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      model: model.name,
      ok: false,
      latencyMs: now() - startedAt,
      error: detail,
    };
  } finally {
    clearTimeout(timer);
  }
}
