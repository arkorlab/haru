import { requestTargetUrl, supervisorStatusSchema } from "@haru/protocol";
import { describe, expect, it } from "vitest";

import { createSupervisorApp } from "./app.js";
import { loadSupervisorConfig } from "./config.js";

import type { SpawnFunction } from "./training.js";

const CONFIG_JSON = JSON.stringify({
  slots: [
    {
      kind: "inference",
      gpuIndex: 0,
      models: [
        { name: "example-chat-small", port: 9001 },
        { name: "example-chat-medium", port: 9002 },
      ],
    },
    {
      kind: "training",
      gpuIndex: 0,
      command: ["python", "train.py"],
      checkpointDir: "/checkpoints",
    },
  ],
});

interface FakeVllmState {
  sleeping: Map<number, boolean>;
  calls: string[];
  probeOk: boolean;
}

function fakeVllmFetch(state: FakeVllmState): typeof fetch {
  return (input, init) => {
    const url = new URL(requestTargetUrl(input));
    const port = Number(url.port);
    state.calls.push(
      `${init?.method ?? "GET"} ${url.host}${url.pathname}${url.search}`,
    );
    if (url.pathname === "/is_sleeping") {
      return Promise.resolve(
        Response.json({ is_sleeping: state.sleeping.get(port) ?? true }),
      );
    }
    if (url.pathname === "/sleep") {
      state.sleeping.set(port, true);
      return Promise.resolve(Response.json({ status: "ok" }));
    }
    if (url.pathname === "/wake_up") {
      state.sleeping.set(port, false);
      return Promise.resolve(Response.json({ status: "ok" }));
    }
    if (url.pathname === "/v1/chat/completions") {
      if (!state.probeOk) {
        return Promise.resolve(new Response("boom", { status: 500 }));
      }
      return Promise.resolve(
        Response.json({
          choices: [{ message: { role: "assistant", content: "pong" } }],
        }),
      );
    }
    return Promise.reject(new TypeError(`unrouted ${url.href}`));
  };
}

const noopSpawn: SpawnFunction = () => ({
  pid: 42,
  kill: () => true,
  once: () => undefined,
});

function makeApp(options: { state: FakeVllmState; token?: string }) {
  return createSupervisorApp({
    config: loadSupervisorConfig(CONFIG_JSON),
    token: options.token,
    fetchFn: fakeVllmFetch(options.state),
    spawnFn: noopSpawn,
    exec: () =>
      Promise.resolve({ code: 0, stdout: "0, 1000, 97887\n", stderr: "" }),
  });
}

function freshState(): FakeVllmState {
  return {
    sleeping: new Map([
      [9001, true],
      [9002, true],
    ]),
    calls: [],
    probeOk: true,
  };
}

describe("auth", () => {
  it("guards every /v1 route when a token is set; healthz stays open", async () => {
    const app = makeApp({ state: freshState(), token: "secret" });
    expect((await app.request("/healthz")).status).toBe(200);
    expect((await app.request("/v1/status")).status).toBe(401);
    expect(
      (
        await app.request("/v1/status", {
          headers: { authorization: "Bearer secret" },
        })
      ).status,
    ).toBe(200);
  });
});

describe("GET /v1/status and /v1/ready", () => {
  it("reports per-model sleep state and readiness", async () => {
    const state = freshState();
    const app = makeApp({ state });
    const asleep = supervisorStatusSchema.parse(
      await (await app.request("/v1/status")).json(),
    );
    expect(asleep.ready).toBe(false);
    const inferenceSlot = asleep.slots.find((s) => s.kind === "inference");
    expect(inferenceSlot?.models?.map((m) => m.sleeping)).toEqual([true, true]);
    const trainingSlot = asleep.slots.find((s) => s.kind === "training");
    expect(trainingSlot?.training?.state).toBe("idle");

    state.sleeping.set(9001, false);
    state.sleeping.set(9002, false);
    const awake = supervisorStatusSchema.parse(
      await (await app.request("/v1/status")).json(),
    );
    expect(awake.ready).toBe(true);

    const ready = await (await app.request("/v1/ready")).json();
    expect(ready).toEqual({ ready: true });
  });

  it("reports sleeping=null for an unreachable vLLM server", async () => {
    const failingFetch: typeof fetch = () =>
      Promise.reject(new TypeError("fetch failed"));
    const app = createSupervisorApp({
      config: loadSupervisorConfig(CONFIG_JSON),
      token: undefined,
      fetchFn: failingFetch,
      spawnFn: noopSpawn,
    });
    const status = supervisorStatusSchema.parse(
      await (await app.request("/v1/status")).json(),
    );
    const models = status.slots.find((s) => s.kind === "inference")?.models;
    expect(models?.every((m) => m.sleeping === null)).toBe(true);
    expect(status.ready).toBe(false);
  });
});

describe("vLLM sleep/wake control", () => {
  it("wakes every local server through the private admin endpoint", async () => {
    const state = freshState();
    const app = makeApp({ state });
    const response = await app.request("/v1/vllm/wake", { method: "POST" });
    expect(response.status).toBe(200);
    expect(state.calls).toContain("POST 127.0.0.1:9001/wake_up");
    expect(state.calls).toContain("POST 127.0.0.1:9002/wake_up");
    expect(state.sleeping.get(9001)).toBe(false);
    expect(state.sleeping.get(9002)).toBe(false);
  });

  it("puts servers to level 1 sleep", async () => {
    const state = freshState();
    state.sleeping.set(9001, false);
    const app = makeApp({ state });
    const response = await app.request("/v1/vllm/sleep", { method: "POST" });
    expect(response.status).toBe(200);
    expect(state.calls).toContain("POST 127.0.0.1:9001/sleep?level=1");
    expect(state.sleeping.get(9001)).toBe(true);
  });

  it("400s a malformed targeted body instead of sleeping everything", async () => {
    const state = freshState();
    state.sleeping.set(9001, false);
    state.sleeping.set(9002, false);
    const app = makeApp({ state });
    const response = await app.request("/v1/vllm/sleep", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Truncated body that was meant to carry a gpuIndex.
      body: '{"gpuIndex":',
    });
    expect(response.status).toBe(400);
    // No admin call went out: the wide default did not kick in.
    expect(state.calls.filter((c) => c.includes("/sleep"))).toHaveLength(0);
    expect(state.sleeping.get(9001)).toBe(false);
  });

  it("wake is idempotent (waking an awake server is a no-op 200)", async () => {
    const state = freshState();
    state.sleeping.set(9001, false);
    state.sleeping.set(9002, false);
    const app = makeApp({ state });
    const response = await app.request("/v1/vllm/wake", { method: "POST" });
    expect(response.status).toBe(200);
  });

  it("fans the admin action out to every model concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const gatedFetch: typeof fetch = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return Response.json({ status: "ok" });
      } finally {
        inFlight -= 1;
      }
    };
    const app = createSupervisorApp({
      config: loadSupervisorConfig(CONFIG_JSON),
      token: undefined,
      fetchFn: gatedFetch,
      spawnFn: noopSpawn,
    });
    const response = await app.request("/v1/vllm/wake", { method: "POST" });
    expect(response.status).toBe(200);
    // Both models' wake calls were in flight together, not serialized.
    expect(maxInFlight).toBe(2);
  });
});

describe("training control", () => {
  it("start/stop/status drive the supervised run", async () => {
    const state = freshState();
    const app = makeApp({ state });
    const start = await app.request("/v1/training/start", { method: "POST" });
    expect(start.status).toBe(200);
    const running = await (await app.request("/v1/training/status")).json();
    expect(running.slots[0].state).toBe("running");
    expect(running.slots[0].pids).toEqual([42]);

    const stop = await app.request("/v1/training/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ graceMs: 5000 }),
    });
    expect(stop.status).toBe(202);
    const stopping = await (await app.request("/v1/training/status")).json();
    expect(stopping.slots[0].state).toBe("stopping");
  });

  it("stop with no running training is a no-op 202", async () => {
    const app = makeApp({ state: freshState() });
    const response = await app.request("/v1/training/stop", {
      method: "POST",
    });
    expect(response.status).toBe(202);
  });
});

describe("GET /v1/gpu/memory", () => {
  it("returns parsed nvidia-smi data", async () => {
    const app = makeApp({ state: freshState() });
    const response = await app.request("/v1/gpu/memory");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      gpus: [{ index: 0, usedMiB: 1000, totalMiB: 97_887 }],
    });
  });
});

describe("POST /v1/probe", () => {
  it("probes every model and reports ok", async () => {
    const state = freshState();
    const app = makeApp({ state });
    const response = await app.request("/v1/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "ping", maxTokens: 4 }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.results).toHaveLength(2);
    expect(
      state.calls.filter((c) => c.includes("/v1/chat/completions")),
    ).toHaveLength(2);
  });

  it("reports a failing model with its error", async () => {
    const state = freshState();
    state.probeOk = false;
    const app = makeApp({ state });
    const response = await app.request("/v1/probe", { method: "POST" });
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.results[0].error).toContain("500");
  });

  it("bounds each completion by the caller-provided timeoutMs", async () => {
    // vLLM never answers; the caller's tiny budget must abort the
    // request instead of holding it for the built-in 60s default.
    const neverResolvingFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted by timeout"));
        });
      });
    const app = createSupervisorApp({
      config: loadSupervisorConfig(CONFIG_JSON),
      token: undefined,
      fetchFn: neverResolvingFetch,
      spawnFn: noopSpawn,
      exec: () =>
        Promise.resolve({ code: 0, stdout: "0, 1000, 97887\n", stderr: "" }),
    });
    const response = await app.request("/v1/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timeoutMs: 1 }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(
      (body.results as { error?: string }[]).every((r) =>
        r.error?.includes("aborted"),
      ),
    ).toBe(true);
  });
});

describe("loadSupervisorConfig", () => {
  it("rejects an empty slot list", () => {
    expect(() => loadSupervisorConfig('{"slots": []}')).toThrow();
  });
});
