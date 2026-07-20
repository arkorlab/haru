import { describe, expect, it } from "vitest";

import { chatCompletionRequestSchema } from "./chat.js";
import { operationStepSchema, slugSchema } from "./enums.js";
import { errorBody } from "./errors.js";
import { describeExecFailure } from "./exec.js";
import {
  domainRole,
  fleetSnapshotSchema,
  inferenceSlotSpecSchema,
  modelBindingSchema,
  slotSnapshotSchema,
  slotSpecSchema,
  trainingSlotSpecSchema,
} from "./fleet.js";
import { fleetLayoutSchema } from "./layout.js";
import { demoteRequestSchema, promoteRequestSchema } from "./operations.js";
import { placementSpecSchema } from "./placement.js";
import {
  fleetPolicyPatchSchema,
  fleetPolicySchema,
  MAX_PROBE_PROMPT_CODE_POINTS,
  MAX_PROBE_TOKENS,
  probePolicyPatchSchema,
  probePolicySchema,
  resolveFleetPolicy,
} from "./policy.js";
import {
  probeRequestSchema,
  supervisorInnerTimeoutMs,
  SUPERVISOR_INNER_TIMEOUT_KIND,
  supervisorConfigSchema,
  supervisorStatusQuerySchema,
  SUPERVISOR_STATUS_MODEL_TIMEOUT_MS,
  SUPERVISOR_STATUS_TIMEOUT_MS,
  trainingStopRequestSchema,
  vllmTargetRequestSchema,
} from "./supervisor.js";
import { joinUrl } from "./url.js";

describe("slugSchema", () => {
  it("accepts lowercase alphanumeric slugs with inner hyphens", () => {
    expect(slugSchema.parse("alpha")).toBe("alpha");
    expect(slugSchema.parse("domain-a1")).toBe("domain-a1");
  });

  it("rejects uppercase, leading hyphen, and empty values", () => {
    expect(() => slugSchema.parse("Alpha")).toThrow();
    expect(() => slugSchema.parse("-alpha")).toThrow();
    expect(() => slugSchema.parse("")).toThrow();
  });

  it("rejects trailing and consecutive hyphens (hyphens are interior)", () => {
    expect(() => slugSchema.parse("alpha-")).toThrow();
    expect(() => slugSchema.parse("a--b")).toThrow();
    expect(() => slugSchema.parse("-")).toThrow();
  });
});

describe("placementSpecSchema", () => {
  it("requires an accelerator name with no default", () => {
    expect(() =>
      placementSpecSchema.parse({ cloud: "aws", region: "us-east-1" }),
    ).toThrow();
  });

  it("defaults acceleratorCount and useSpot", () => {
    const spec = placementSpecSchema.parse({
      cloud: "gcp",
      region: "us-central1",
      accelerator: "SOME-GPU",
    });
    expect(spec.acceleratorCount).toBe(1);
    expect(spec.useSpot).toBe(false);
  });

  it("rejects clouds outside the SkyPilot passthrough set", () => {
    expect(() =>
      placementSpecSchema.parse({
        cloud: "azure",
        region: "eastus",
        accelerator: "SOME-GPU",
      }),
    ).toThrow();
  });

  it("rejects an unknown key (strict operator config)", () => {
    expect(() =>
      placementSpecSchema.parse({
        cloud: "aws",
        region: "us-east-1",
        accelerator: "SOME-GPU",
        // A misspelled acceleratorCount must not be silently dropped.
        acceleratorCnt: 4,
      }),
    ).toThrow();
  });
});

describe("fleetPolicySchema", () => {
  it("fills every default from an empty object", () => {
    const policy = fleetPolicySchema.parse({});
    expect(policy.autoFailover).toBe(false);
    expect(policy.heartbeatStaleMs).toBe(30_000);
    expect(policy.trainingStopGraceMs).toBe(30_000);
    expect(policy.wakeTimeoutMs).toBe(120_000);
    expect(policy.probe).toEqual({ prompt: "ping", maxTokens: 4 });
  });

  it("resolveFleetPolicy treats null as all defaults", () => {
    expect(resolveFleetPolicy(null)).toEqual(fleetPolicySchema.parse({}));
  });

  it("keeps explicit overrides", () => {
    const policy = resolveFleetPolicy({ autoFailover: true });
    expect(policy.autoFailover).toBe(true);
    expect(policy.heartbeatStaleMs).toBe(30_000);
  });

  it("rejects a misspelled key instead of silently dropping it", () => {
    // The whole point of strict: a typo'd safety setting must be a
    // config-time error, not a silently-defaulted autoFailover=false.
    expect(() => fleetPolicySchema.parse({ autoFailver: true })).toThrow();
    expect(() => resolveFleetPolicy({ autoFailver: true })).toThrow();
  });

  it("bounds synthetic probe work in stored policy", () => {
    expect(() =>
      fleetPolicySchema.parse({
        probe: {
          prompt: "x".repeat(MAX_PROBE_PROMPT_CODE_POINTS),
          maxTokens: MAX_PROBE_TOKENS,
        },
      }),
    ).not.toThrow();
    expect(() =>
      fleetPolicySchema.parse({
        probe: {
          prompt: "x".repeat(MAX_PROBE_PROMPT_CODE_POINTS + 1),
          maxTokens: MAX_PROBE_TOKENS,
        },
      }),
    ).toThrow();
    expect(() =>
      fleetPolicySchema.parse({
        probe: { prompt: "ping", maxTokens: MAX_PROBE_TOKENS + 1 },
      }),
    ).toThrow();
  });

  it("counts astral prompt characters as Unicode code points", () => {
    expect(() =>
      fleetPolicySchema.parse({
        probe: {
          prompt: "😀".repeat(MAX_PROBE_PROMPT_CODE_POINTS),
        },
      }),
    ).not.toThrow();
    expect(() =>
      fleetPolicySchema.parse({
        probe: {
          prompt: "😀".repeat(MAX_PROBE_PROMPT_CODE_POINTS + 1),
        },
      }),
    ).toThrow();
  });
});

describe("slotSpecSchema", () => {
  it("parses an inference spec and defaults sleepLevel to 1", () => {
    const spec = inferenceSlotSpecSchema.parse({
      kind: "inference",
      models: [{ name: "example-chat", servingUrl: "http://127.0.0.1:8001" }],
    });
    expect(spec.sleepLevel).toBe(1);
  });

  it("rejects an inference spec with no models", () => {
    expect(() =>
      inferenceSlotSpecSchema.parse({ kind: "inference", models: [] }),
    ).toThrow();
  });

  it("requires command and checkpointDir on training specs", () => {
    expect(() =>
      trainingSlotSpecSchema.parse({ kind: "training", command: [] }),
    ).toThrow();
    const spec = trainingSlotSpecSchema.parse({
      kind: "training",
      command: ["python", "train.py"],
      checkpointDir: "/checkpoints/run",
    });
    expect(spec.command).toHaveLength(2);
  });

  it("discriminates on kind", () => {
    expect(() => slotSpecSchema.parse({ kind: "other" })).toThrow();
  });

  it("rejects unknown keys on specs and model bindings (strict)", () => {
    expect(() =>
      inferenceSlotSpecSchema.parse({
        kind: "inference",
        models: [{ name: "example-chat", servingUrl: "http://127.0.0.1:8001" }],
        sleepLvl: 1,
      }),
    ).toThrow();
    expect(() =>
      modelBindingSchema.parse({
        name: "example-chat",
        servingUrl: "http://127.0.0.1:8001",
        serving_url: "http://127.0.0.1:8002",
      }),
    ).toThrow();
  });
});

describe("slotSnapshotSchema", () => {
  const inferenceSnapshot = {
    id: "00000000-0000-4000-8000-00000000000a",
    domainId: "00000000-0000-4000-8000-00000000000b",
    gpuIndex: 0,
    kind: "inference",
    state: "serving",
    spec: {
      kind: "inference",
      sleepLevel: 1,
      models: [{ name: "example-chat", servingUrl: "http://127.0.0.1:8001" }],
    },
  };

  it("accepts a slot whose kind matches its spec discriminant", () => {
    expect(slotSnapshotSchema.parse(inferenceSnapshot).kind).toBe("inference");
  });

  it("rejects a row whose kind disagrees with its spec discriminant", () => {
    expect(() =>
      slotSnapshotSchema.parse({ ...inferenceSnapshot, kind: "training" }),
    ).toThrow(/kind must match/);
  });
});

describe("fleetSnapshotSchema relationships", () => {
  const fleetId = "00000000-0000-4000-8000-000000000001";
  const domainId = "00000000-0000-4000-8000-000000000002";
  const slotId = "00000000-0000-4000-8000-000000000003";
  const timestamp = "2026-01-01T00:00:00.000Z";

  function snapshot() {
    return {
      id: fleetId,
      slug: "default",
      displayName: null,
      activeDomainId: domainId,
      routeRevision: 1,
      policy: resolveFleetPolicy({}),
      domains: [
        {
          id: domainId,
          fleetId,
          slug: "alpha",
          state: "ready",
          provider: "static",
          placement: {
            cloud: "aws",
            region: "region-a",
            accelerator: "example-accelerator",
          },
          supervisorUrl: "http://127.0.0.1:8701",
          servingBaseUrl: "http://127.0.0.1:8000",
          lastSeenAt: timestamp,
          stateUpdatedAt: timestamp,
          slots: [
            {
              id: slotId,
              domainId,
              gpuIndex: 0,
              kind: "inference",
              state: "serving",
              spec: {
                kind: "inference",
                models: [
                  {
                    name: "example-chat",
                    servingUrl: "http://127.0.0.1:8001",
                  },
                ],
              },
            },
          ],
        },
      ],
    };
  }

  it("accepts a relationally coherent snapshot", () => {
    expect(fleetSnapshotSchema.parse(snapshot()).activeDomainId).toBe(domainId);
  });

  it("rejects an active pointer outside the fleet's domain list", () => {
    const value = snapshot();
    value.activeDomainId = "00000000-0000-4000-8000-000000000099";
    expect(() => fleetSnapshotSchema.parse(value)).toThrow(
      /activeDomainId must identify/,
    );
  });

  it("rejects domains and slots owned by a different parent", () => {
    const wrongId = "00000000-0000-4000-8000-000000000099";
    const wrongFleet = snapshot();
    wrongFleet.domains[0]!.fleetId = wrongId;
    expect(() => fleetSnapshotSchema.parse(wrongFleet)).toThrow(
      /domain.fleetId must match/,
    );

    const wrongDomain = snapshot();
    wrongDomain.domains[0]!.slots[0]!.domainId = wrongId;
    expect(() => fleetSnapshotSchema.parse(wrongDomain)).toThrow(
      /slot.domainId must match/,
    );
  });

  it("rejects duplicate relational identities", () => {
    const duplicateDomain = snapshot();
    duplicateDomain.domains.push(structuredClone(duplicateDomain.domains[0]!));
    expect(() => fleetSnapshotSchema.parse(duplicateDomain)).toThrow(
      /domain ids must be unique/,
    );
  });
});

describe("chatCompletionRequestSchema", () => {
  it("passes unknown OpenAI fields through untouched", () => {
    const parsed = chatCompletionRequestSchema.parse({
      model: "example-chat",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.2,
      some_vendor_extension: { nested: true },
    });
    expect(parsed.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(parsed.some_vendor_extension).toEqual({ nested: true });
  });

  it("requires a model name", () => {
    expect(() => chatCompletionRequestSchema.parse({})).toThrow();
    expect(() => chatCompletionRequestSchema.parse({ model: "" })).toThrow();
  });
});

describe("fleetLayoutSchema", () => {
  const validLayout = {
    slug: "default",
    activeDomainSlug: "alpha",
    domains: [
      {
        slug: "alpha",
        placement: {
          cloud: "aws",
          region: "us-east-1",
          accelerator: "SOME-GPU",
          acceleratorCount: 2,
        },
        servingBaseUrl: "http://127.0.0.1:9001",
        slots: [
          {
            kind: "inference",
            gpuIndex: 0,
            models: [
              { name: "example-chat", servingUrl: "http://127.0.0.1:9001" },
            ],
          },
          {
            kind: "training",
            gpuIndex: 0,
            command: ["python", "train.py"],
            checkpointDir: "/checkpoints",
          },
        ],
      },
    ],
  };

  it("parses a valid layout and defaults provider to static", () => {
    const layout = fleetLayoutSchema.parse(validLayout);
    expect(layout.domains[0]?.provider).toBe("static");
  });

  it("rejects an activeDomainSlug that names no domain", () => {
    expect(() =>
      fleetLayoutSchema.parse({ ...validLayout, activeDomainSlug: "ghost" }),
    ).toThrow();
  });

  it("rejects a training-only initial active (nothing to serve)", () => {
    const domain = validLayout.domains[0]!;
    expect(() =>
      fleetLayoutSchema.parse({
        ...validLayout,
        domains: [
          {
            ...domain,
            slots: domain.slots.filter((slot) => slot.kind === "training"),
          },
        ],
      }),
    ).toThrow(/at least one inference model/);
  });

  it("rejects non-HTTP serving and supervisor URLs at config time", () => {
    const domain = validLayout.domains[0]!;
    const inferenceSlot = domain.slots[0]!;
    expect(() =>
      fleetLayoutSchema.parse({
        ...validLayout,
        domains: [
          {
            ...domain,
            slots: [
              {
                ...inferenceSlot,
                models: [{ name: "example-chat", servingUrl: "mailto:x@y" }],
              },
              domain.slots[1],
            ],
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      fleetLayoutSchema.parse({
        ...validLayout,
        domains: [{ ...domain, supervisorUrl: "file:///etc/passwd" }],
      }),
    ).toThrow();
  });

  it("rejects duplicate domain slugs", () => {
    const domain = validLayout.domains[0];
    expect(() =>
      fleetLayoutSchema.parse({
        ...validLayout,
        domains: [domain, domain],
      }),
    ).toThrow();
  });

  it("rejects a model name bound twice within one domain", () => {
    const domain = validLayout.domains[0]!;
    expect(() =>
      fleetLayoutSchema.parse({
        ...validLayout,
        domains: [
          {
            ...domain,
            slots: [
              ...domain.slots,
              {
                kind: "inference",
                gpuIndex: 1,
                models: [
                  // Same routing key as the gpuIndex 0 slot: the chat
                  // proxy would silently pick one of the two URLs.
                  { name: "example-chat", servingUrl: "http://127.0.0.1:9002" },
                ],
              },
            ],
          },
        ],
      }),
    ).toThrow(/unique within a domain/);
  });

  it("allows the same model names across domains (active/standby symmetry)", () => {
    const domain = validLayout.domains[0]!;
    expect(() =>
      fleetLayoutSchema.parse({
        ...validLayout,
        domains: [domain, { ...domain, slug: "beta" }],
      }),
    ).not.toThrow();
  });

  it("rejects unknown keys at every level (strict, incl. extended slots)", () => {
    const domain = validLayout.domains[0]!;
    // Top-level typo.
    expect(() =>
      fleetLayoutSchema.parse({ ...validLayout, autoFailover: true }),
    ).toThrow();
    // Domain-level typo.
    expect(() =>
      fleetLayoutSchema.parse({
        ...validLayout,
        domains: [{ ...domain, superviorUrl: "http://127.0.0.1:8701" }],
      }),
    ).toThrow();
    // Slot-level typo: proves the `.extend({ gpuIndex })` on the slot
    // spec inherits strictness rather than reopening the object.
    expect(() =>
      fleetLayoutSchema.parse({
        ...validLayout,
        domains: [
          {
            ...domain,
            slots: [{ ...domain.slots[0], sleepLvl: 1 }, domain.slots[1]],
          },
        ],
      }),
    ).toThrow();
    // Nested-policy typo: proves `fleetPolicyPatchSchema` keeps the full
    // schema's strictness, so a misspelled safety setting inside a
    // layout's `policy` is still a config-time error.
    expect(() =>
      fleetLayoutSchema.parse({
        ...validLayout,
        policy: { autoFailver: true },
      }),
    ).toThrow();
    // ...while a correctly-spelled partial policy is still accepted.
    expect(() =>
      fleetLayoutSchema.parse({
        ...validLayout,
        policy: { autoFailover: true },
      }),
    ).not.toThrow();
  });

  it("stores only operator-provided policy keys (no baked defaults)", () => {
    // A plain `.partial()` would fire each field's inner `.default()` and
    // persist all eleven defaults, freezing the fleet against any later
    // default change. Only the provided key must survive.
    const parsed = fleetLayoutSchema.parse({
      ...validLayout,
      policy: { autoFailover: true },
    });
    expect(parsed.policy).toEqual({ autoFailover: true });
    // A nested probe patch must not bake in the sibling maxTokens either.
    const withProbe = fleetLayoutSchema.parse({
      ...validLayout,
      policy: { probe: { prompt: "hi" } },
    });
    expect(withProbe.policy).toEqual({ probe: { prompt: "hi" } });
    // An omitted policy stays undefined; resolveFleetPolicy fills current
    // defaults on read.
    const noPolicy = fleetLayoutSchema.parse(validLayout);
    expect(noPolicy.policy).toBeUndefined();
  });

  it("keeps the policy patch schema key set in lockstep with the full policy", () => {
    // Drift guard: fleetPolicyPatchSchema is authored by hand, so a field
    // added to fleetPolicySchema must be added to the patch too, or a new
    // operator-tunable setting would be silently rejected at layout time.
    expect(new Set(Object.keys(fleetPolicyPatchSchema.shape))).toEqual(
      new Set(Object.keys(fleetPolicySchema.shape)),
    );
    // ...and the nested probe patch, or a new probe field (e.g. a
    // temperature) would be silently rejected inside a layout's
    // `policy.probe` while both top-level shapes still share the `probe`
    // key and this guard stayed green.
    expect(new Set(Object.keys(probePolicyPatchSchema.shape))).toEqual(
      new Set(Object.keys(probePolicySchema.shape)),
    );
  });

  it("accepts an optional $schema pointer for editor integration", () => {
    expect(() =>
      fleetLayoutSchema.parse({
        ...validLayout,
        $schema: "../../protocol/schemas/fleet-layout.schema.json",
      }),
    ).not.toThrow();
  });
});

describe("probeRequestSchema", () => {
  it("accepts an optional caller-provided timeout budget", () => {
    expect(probeRequestSchema.parse({}).timeoutMs).toBeUndefined();
    expect(probeRequestSchema.parse({ timeoutMs: 1500 }).timeoutMs).toBe(1500);
    expect(() => probeRequestSchema.parse({ timeoutMs: 0 })).toThrow();
    // setTimeout clamps > 2^31-1 to ~1ms; reject at the schema.
    expect(() =>
      probeRequestSchema.parse({ timeoutMs: 2_147_483_648 }),
    ).toThrow();
  });

  it("uses the same prompt and generation bounds as fleet policy", () => {
    expect(() =>
      probeRequestSchema.parse({
        prompt: "x".repeat(MAX_PROBE_PROMPT_CODE_POINTS),
        maxTokens: MAX_PROBE_TOKENS,
      }),
    ).not.toThrow();
    expect(() =>
      probeRequestSchema.parse({
        prompt: "x".repeat(MAX_PROBE_PROMPT_CODE_POINTS + 1),
      }),
    ).toThrow();
    expect(() =>
      probeRequestSchema.parse({ maxTokens: MAX_PROBE_TOKENS + 1 }),
    ).toThrow();
  });
});

describe("supervisor call budgets and model selection", () => {
  it("reserves response headroom inside the outer heartbeat budget", () => {
    expect(SUPERVISOR_STATUS_TIMEOUT_MS).toBe(6000);
    // A pre-selector supervisor ignores the new timeoutMs query and
    // retains its historic 5s local timeout. The outer call must still
    // leave a full second for that version to return sleeping:null.
    expect(SUPERVISOR_STATUS_TIMEOUT_MS - 5000).toBe(1000);
    expect(SUPERVISOR_STATUS_MODEL_TIMEOUT_MS).toBe(4000);
    expect(supervisorInnerTimeoutMs(SUPERVISOR_STATUS_TIMEOUT_MS)).toBe(5400);
    expect(
      Math.min(
        SUPERVISOR_STATUS_MODEL_TIMEOUT_MS,
        supervisorInnerTimeoutMs(SUPERVISOR_STATUS_TIMEOUT_MS),
      ),
    ).toBe(4000);
    expect(supervisorInnerTimeoutMs(500)).toBe(450);
    expect(supervisorInnerTimeoutMs(2)).toBe(1);
  });

  it("distinguishes all models from an explicit empty selection", () => {
    expect(supervisorStatusQuerySchema.parse({})).toEqual({});
    expect(supervisorStatusQuerySchema.parse({ models: [] })).toEqual({
      models: [],
    });
    expect(
      supervisorStatusQuerySchema.parse({
        timeoutKind: SUPERVISOR_INNER_TIMEOUT_KIND,
      }),
    ).toEqual({ timeoutKind: "inner" });
    expect(() =>
      supervisorStatusQuerySchema.parse({ timeoutKind: "outer" }),
    ).toThrow();
    expect(() =>
      supervisorStatusQuerySchema.parse({
        timeoutMs: SUPERVISOR_STATUS_MODEL_TIMEOUT_MS + 1,
      }),
    ).toThrow();
    expect(() =>
      supervisorStatusQuerySchema.parse({ models: ["UPPERCASE"] }),
    ).toThrow();
  });
});

describe("trainingStopRequestSchema", () => {
  it("bounds graceMs at the setTimeout clamp", () => {
    expect(trainingStopRequestSchema.parse({ graceMs: 5000 }).graceMs).toBe(
      5000,
    );
    expect(() =>
      trainingStopRequestSchema.parse({ graceMs: 2_147_483_648 }),
    ).toThrow();
  });
});

describe("internal request DTOs are strict", () => {
  it("rejects unknown keys on control-API request bodies", () => {
    // Server control API (client and server ship together).
    expect(() =>
      promoteRequestSchema.parse({
        targetDomainId: "00000000-0000-4000-8000-00000000000a",
        force: true,
      }),
    ).toThrow();
    expect(() =>
      demoteRequestSchema.parse({
        targetDomainId: "00000000-0000-4000-8000-00000000000a",
        extra: 1,
      }),
    ).toThrow();
    // Supervisor inbound (server is the only caller).
    expect(() =>
      vllmTargetRequestSchema.parse({ gpuIndex: 0, all: true }),
    ).toThrow();
    expect(() =>
      trainingStopRequestSchema.parse({ graceMs: 5000, hard: true }),
    ).toThrow();
    expect(() =>
      probeRequestSchema.parse({ prompt: "ping", prmpt: "typo" }),
    ).toThrow();
  });

  it("lowercases an uppercase targetDomainId (uuids are case-insensitive)", () => {
    // Postgres stores domain ids lowercase and core matches with `===`,
    // so the schema canonicalises regardless of caller.
    expect(
      promoteRequestSchema.parse({
        targetDomainId: "0F5C1E2A-3B4C-4D5E-8F90-1A2B3C4D5E6F",
      }).targetDomainId,
    ).toBe("0f5c1e2a-3b4c-4d5e-8f90-1a2b3c4d5e6f");
    expect(
      demoteRequestSchema.parse({
        targetDomainId: "0F5C1E2A-3B4C-4D5E-8F90-1A2B3C4D5E6F",
      }).targetDomainId,
    ).toBe("0f5c1e2a-3b4c-4d5e-8f90-1a2b3c4d5e6f");
  });
});

describe("supervisorConfigSchema", () => {
  const validConfig = {
    slots: [
      {
        kind: "inference",
        gpuIndex: 0,
        models: [{ name: "example-chat", port: 8001 }],
      },
    ],
  };

  it("parses a valid config", () => {
    expect(supervisorConfigSchema.parse(validConfig).slots).toHaveLength(1);
  });

  it("rejects unknown keys (strict operator config)", () => {
    // Top-level typo.
    expect(() =>
      supervisorConfigSchema.parse({ ...validConfig, slotz: [] }),
    ).toThrow();
    // Model-level typo (proves nested strictness).
    expect(() =>
      supervisorConfigSchema.parse({
        slots: [
          {
            kind: "inference",
            gpuIndex: 0,
            models: [{ name: "example-chat", port: 8001, prt: 8002 }],
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects a non-lowercase model name (must match the layout's routing key)", () => {
    // The layout side forces lowercase; server-side health/probe checks
    // match the two by exact equality, so a casing mismatch must be a
    // config-time error, not runtime health flapping.
    expect(() =>
      supervisorConfigSchema.parse({
        slots: [
          {
            kind: "inference",
            gpuIndex: 0,
            models: [{ name: "Example-Chat", port: 8001 }],
          },
        ],
      }),
    ).toThrow(/lowercase/);
  });

  it("rejects a model name duplicated across inference slots", () => {
    // Server-side completion checks key reported models by name in a
    // last-write-wins map; a duplicate would let the wrong slot's
    // report satisfy another slot's wake/sleep proof.
    expect(() =>
      supervisorConfigSchema.parse({
        slots: [
          {
            kind: "inference",
            gpuIndex: 0,
            models: [{ name: "example-chat", port: 8001 }],
          },
          {
            kind: "inference",
            gpuIndex: 1,
            models: [{ name: "example-chat", port: 9001 }],
          },
        ],
      }),
    ).toThrow(/unique across inference slots/);
  });
});

describe("operationStepSchema", () => {
  it("covers both promote and demote steps", () => {
    expect(operationStepSchema.parse("switch_active")).toBe("switch_active");
    expect(operationStepSchema.parse("sleep_vllm")).toBe("sleep_vllm");
    expect(() => operationStepSchema.parse("nope")).toThrow();
  });
});

describe("domainRole", () => {
  it("derives active from the fleet pointer", () => {
    expect(domainRole({ activeDomainId: "x" }, "x")).toBe("active");
    expect(domainRole({ activeDomainId: "x" }, "y")).toBe("standby");
    expect(domainRole({ activeDomainId: null }, "y")).toBe("standby");
  });
});

describe("joinUrl", () => {
  it("appends to an origin-only base", () => {
    expect(joinUrl("https://host.example", "/v1/chat/completions")).toBe(
      "https://host.example/v1/chat/completions",
    );
  });

  it("preserves a path prefix on the base URL", () => {
    expect(joinUrl("https://gw.example/tenant-a", "/v1/status")).toBe(
      "https://gw.example/tenant-a/v1/status",
    );
    expect(joinUrl("https://gw.example/tenant-a/", "/v1/status")).toBe(
      "https://gw.example/tenant-a/v1/status",
    );
  });

  it("keeps port and scheme", () => {
    expect(joinUrl("http://127.0.0.1:8701", "/healthz")).toBe(
      "http://127.0.0.1:8701/healthz",
    );
  });

  it("preserves a query string on the base URL", () => {
    expect(
      joinUrl(
        "https://gw.example/vllm?api-version=2024",
        "/v1/chat/completions",
      ),
    ).toBe("https://gw.example/vllm/v1/chat/completions?api-version=2024");
  });

  it("keeps a query the path carries and merges base params", () => {
    expect(joinUrl("http://127.0.0.1:9000?tenant=a", "/sleep?level=1")).toBe(
      "http://127.0.0.1:9000/sleep?level=1&tenant=a",
    );
  });

  it("lets a path param override a same-named base param", () => {
    expect(joinUrl("https://host.example?level=9", "/sleep?level=1")).toBe(
      "https://host.example/sleep?level=1",
    );
  });

  it("preserves repeated base query keys", () => {
    expect(joinUrl("https://host.example?tag=a&tag=b", "/v1/status")).toBe(
      "https://host.example/v1/status?tag=a&tag=b",
    );
  });

  it("does not let a protocol-relative path swap the origin", () => {
    // `//evil.example/x` must stay a path on the base host, never
    // resolve as a protocol-relative URL to evil.example.
    expect(joinUrl("https://host.example", "//evil.example/x")).toBe(
      "https://host.example/evil.example/x",
    );
    expect(joinUrl("https://host.example/base", "///evil.example")).toBe(
      "https://host.example/base/evil.example",
    );
  });

  it("does not let leading backslashes swap the origin", () => {
    // The WHATWG URL parser treats a backslash like a slash on http(s),
    // so a backslash-led path against an origin-only base (e.g. a
    // supervisor 127.0.0.1 URL) must not resolve to another host.
    expect(joinUrl("https://host.example", String.raw`\\evil.example/x`)).toBe(
      "https://host.example/evil.example/x",
    );
    expect(joinUrl("https://host.example", String.raw`/\evil.example`)).toBe(
      "https://host.example/evil.example",
    );
  });

  it("does not let an embedded tab/newline/CR swap the origin", () => {
    // The WHATWG URL parser STRIPS ASCII tab/LF/CR before parsing the
    // authority, so a control char could re-form `//` after the leading
    // slash collapse. joinUrl removes them up front, so these resolve to
    // a plain path on the base host instead of swapping to evil.example.
    for (const control of ["\t", "\n", "\r"]) {
      expect(
        joinUrl("https://host.example", `${control}//evil.example/x`),
      ).toBe("https://host.example/evil.example/x");
      expect(
        joinUrl("https://host.example", `/${control}/evil.example/x`),
      ).toBe("https://host.example/evil.example/x");
    }
  });

  it("refuses a base whose own pathname would swap the host", () => {
    // A `//a/` pathname on the base parses as protocol-relative when the
    // suffix is appended, moving the host to `a`; the origin backstop
    // catches what the path-side collapse cannot. Fail closed.
    expect(() => joinUrl("https://host.example//a/", "x")).toThrow(/origin/);
  });
});

describe("errorBody", () => {
  it("builds the wire envelope", () => {
    expect(errorBody("fleet_not_found", "no such fleet")).toEqual({
      error: { code: "fleet_not_found", message: "no such fleet" },
    });
  });
});

describe("describeExecFailure", () => {
  it("renders a plain non-zero exit with its stderr", () => {
    expect(
      describeExecFailure({
        code: 9,
        signal: null,
        errorMessage: null,
        stderr: "no devices",
      }),
    ).toBe("exited 9: no devices");
  });

  it("surfaces signal and errorMessage, and omits the colon when stderr is blank", () => {
    expect(
      describeExecFailure({
        code: 1,
        signal: "SIGTERM",
        errorMessage: "Command failed: timed out",
        stderr: "",
      }),
    ).toBe("exited 1 (Command failed: timed out, signal SIGTERM)");
  });

  it("drops a blank errorMessage instead of an empty parenthetical", () => {
    expect(
      describeExecFailure({
        code: 1,
        signal: null,
        errorMessage: "",
        stderr: "",
      }),
    ).toBe("exited 1");
  });

  it("caps stderr when a byte budget is given (after trimming)", () => {
    expect(
      describeExecFailure(
        { code: 2, signal: null, errorMessage: null, stderr: "  abcdef  " },
        { maxStderrChars: 3 },
      ),
    ).toBe("exited 2: abc");
  });

  it("caps errorMessage too, so a downstream bound is never defeated", () => {
    const long = "x".repeat(5000);
    const message = describeExecFailure(
      { code: 1, signal: "SIGTERM", errorMessage: long, stderr: long },
      { maxStderrChars: 500 },
    );
    // Both the parenthetical errorMessage and the stderr tail are bounded,
    // not just result.stderr.
    expect(message.length).toBeLessThan(1200);
  });
});
