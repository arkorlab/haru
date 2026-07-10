/**
 * Scripted fake supervisor + serving endpoints for haru-server tests.
 * One fetch implementation serves every supervisor and vLLM base URL
 * in the test fleet layout, keyed by origin.
 */

import { requestTargetUrl } from "@haru/protocol";

export const ALPHA_SUPERVISOR = "https://alpha-supervisor.test";
export const BETA_SUPERVISOR = "https://beta-supervisor.test";
export const ALPHA_SERVING = "https://alpha-serving.test";
export const BETA_SERVING = "https://beta-serving.test";

/** Two-domain test layout: alpha active, beta standby. */
function testDomain(slug: string, supervisorUrl: string, servingUrl: string) {
  return {
    slug,
    provider: "static",
    placement: {
      cloud: "aws",
      region: "us-east-1",
      accelerator: "TEST-GPU",
    },
    supervisorUrl,
    servingBaseUrl: servingUrl,
    slots: [
      {
        kind: "inference",
        gpuIndex: 0,
        models: [{ name: "example-chat-small", servingUrl: servingUrl }],
      },
      {
        kind: "training",
        gpuIndex: 0,
        command: ["python", "train.py"],
        checkpointDir: "/checkpoints",
      },
    ],
  };
}

export function testLayout(policy: Record<string, unknown> = {}): unknown {
  return {
    slug: "default",
    activeDomainSlug: "alpha",
    policy,
    domains: [
      testDomain("alpha", ALPHA_SUPERVISOR, ALPHA_SERVING),
      testDomain("beta", BETA_SUPERVISOR, BETA_SERVING),
    ],
  };
}

export interface FakeProbeResult {
  model: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export interface FakeSupervisorState {
  /** Training run state reported/managed by the fake. */
  training: "idle" | "running" | "stopping";
  /** When true, /v1/training/start answers 200 but the run stays
   * idle, like a spawn failure surfacing via the child error path. */
  trainingStartIgnored: boolean;
  /** When true, a running training run reports NO pids, like the
   * window between start() flipping to running and the async child
   * 'error' event landing for a command that failed to spawn. */
  trainingPidless: boolean;
  /** When true, /v1/vllm/sleep answers 200 but the models never
   * report asleep (offload wedged, or drifted supervisor config). */
  sleepIgnored: boolean;
  /** Whether the fake's vLLM servers are asleep. */
  sleeping: boolean;
  /** GPU memory in use as a fraction of total. */
  gpuUsedRatio: number;
  /** Whether synthetic probes succeed. */
  probeOk: boolean;
  /** Overrides the /v1/probe results entirely (simulates a supervisor
   * whose configured model set drifted from the fleet layout). */
  probeResults: FakeProbeResult[] | null;
  /** Last /v1/probe request body, for asserting the wire contract. */
  lastProbeBody: unknown;
  /** When false every call fails like a network error. */
  reachable: boolean;
  calls: string[];
}

export function fakeSupervisorState(
  overrides: Partial<FakeSupervisorState> = {},
): FakeSupervisorState {
  return {
    training: "idle",
    trainingStartIgnored: false,
    trainingPidless: false,
    sleepIgnored: false,
    sleeping: true,
    gpuUsedRatio: 0.1,
    probeOk: true,
    probeResults: null,
    lastProbeBody: null,
    reachable: true,
    calls: [],
    ...overrides,
  };
}

function json(body: unknown): Response {
  return Response.json(body, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function supervisorResponse(
  state: FakeSupervisorState,
  method: string,
  pathname: string,
  body: string,
): Response {
  state.calls.push(`${method} ${pathname}`);
  switch (`${method} ${pathname}`) {
    case "GET /v1/status":
      return json({
        ready: !state.sleeping,
        slots: [
          {
            gpuIndex: 0,
            kind: "inference",
            models: [
              {
                name: "example-chat-small",
                port: 9001,
                sleeping: state.sleeping,
              },
            ],
          },
          {
            gpuIndex: 0,
            kind: "training",
            training: {
              state: state.training === "running" ? "running" : state.training,
              pids:
                state.training === "running" && !state.trainingPidless
                  ? [1234]
                  : [],
            },
          },
        ],
      });
    case "POST /v1/training/stop":
      state.training = "idle";
      return json({ status: "ok" });
    case "POST /v1/training/start":
      if (!state.trainingStartIgnored) {
        state.training = "running";
      }
      return json({ status: "ok" });
    case "POST /v1/vllm/wake":
      state.sleeping = false;
      return json({ status: "ok" });
    case "POST /v1/vllm/sleep":
      if (!state.sleepIgnored) {
        state.sleeping = true;
      }
      return json({ status: "ok" });
    case "GET /v1/gpu/memory":
      return json({
        gpus: [
          {
            index: 0,
            usedMiB: Math.round(state.gpuUsedRatio * 96_000),
            totalMiB: 96_000,
          },
        ],
      });
    case "POST /v1/probe": {
      state.lastProbeBody = body === "" ? null : JSON.parse(body);
      const results = state.probeResults ?? [
        {
          model: "example-chat-small",
          ok: state.probeOk,
          latencyMs: 5,
          ...(!state.probeOk && { error: "synthetic failure" }),
        },
      ];
      return json({
        ok: results.length > 0 && results.every((r) => r.ok),
        results,
      });
    }
    default:
      return new Response("not found", { status: 404 });
  }
}

export interface FakeUpstreamCall {
  url: string;
  body: string;
}

/**
 * Build a fetch implementation that routes supervisor origins to fake
 * supervisor state machines and records chat-completion calls against
 * serving origins, answering them with a small SSE stream.
 */
export function buildFakeFetch(options: {
  supervisors: Record<string, FakeSupervisorState>;
  chatCalls?: FakeUpstreamCall[];
}): typeof fetch {
  return (input, init) => {
    const url = new URL(requestTargetUrl(input));
    const supervisor = options.supervisors[url.origin];
    if (supervisor) {
      if (!supervisor.reachable) {
        return Promise.reject(new TypeError("fetch failed"));
      }
      return Promise.resolve(
        supervisorResponse(
          supervisor,
          init?.method ?? "GET",
          url.pathname,
          typeof init?.body === "string" ? init.body : "",
        ),
      );
    }
    if (url.pathname === "/v1/chat/completions") {
      options.chatCalls?.push({
        url: url.href,
        body: typeof init?.body === "string" ? init.body : "",
      });
      const sse = [
        'data: {"choices":[{"delta":{"content":"hello"}}]}',
        "",
        "data: [DONE]",
        "",
        "",
      ].join("\n");
      return Promise.resolve(
        new Response(sse, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );
    }
    return Promise.reject(new TypeError(`fetch failed: unrouted ${url.href}`));
  };
}
