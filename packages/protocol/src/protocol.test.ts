import { describe, expect, it } from "vitest";

import { chatCompletionRequestSchema } from "./chat.js";
import { operationStepSchema, slugSchema } from "./enums.js";
import { errorBody } from "./errors.js";
import {
  domainRole,
  inferenceSlotSpecSchema,
  slotSpecSchema,
  trainingSlotSpecSchema,
} from "./fleet.js";
import { fleetLayoutSchema } from "./layout.js";
import { placementSpecSchema } from "./placement.js";
import { fleetPolicySchema, resolveFleetPolicy } from "./policy.js";
import { probeRequestSchema, trainingStopRequestSchema } from "./supervisor.js";
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
});

describe("errorBody", () => {
  it("builds the wire envelope", () => {
    expect(errorBody("fleet_not_found", "no such fleet")).toEqual({
      error: { code: "fleet_not_found", message: "no such fleet" },
    });
  });
});
