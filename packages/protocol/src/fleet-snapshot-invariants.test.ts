import { describe, expect, it } from "vitest";

import { fleetSnapshotSchema } from "./fleet.js";
import { resolveFleetPolicy } from "./policy.js";

const fleetId = createUuid(1);
const timestamp = "2026-01-01T00:00:00.000Z";

function createUuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}

function createDomain(
  domainNumber: number,
  modelNamesBySlot: readonly (readonly string[])[],
) {
  const domainId = createUuid(domainNumber);
  const basePort = 8000 + domainNumber * 100;

  return {
    id: domainId,
    fleetId,
    slug: `domain-${domainNumber}`,
    state: "ready",
    provider: "static",
    placement: {
      cloud: "aws",
      region: "region-a",
      accelerator: "example-accelerator",
    },
    supervisorUrl: `http://127.0.0.1:${basePort}`,
    servingBaseUrl: `http://127.0.0.1:${basePort + 1}`,
    lastSeenAt: timestamp,
    stateUpdatedAt: timestamp,
    slots: modelNamesBySlot.map((modelNames, slotIndex) => ({
      id: createUuid(domainNumber * 100 + slotIndex),
      domainId,
      gpuIndex: slotIndex,
      kind: "inference",
      state: "serving",
      spec: {
        kind: "inference",
        models: modelNames.map((name, modelIndex) => ({
          name,
          servingUrl: `http://127.0.0.1:${
            basePort + 10 + slotIndex * 10 + modelIndex
          }`,
        })),
      },
    })),
  };
}

function createSnapshot(
  domains: readonly ReturnType<typeof createDomain>[],
): unknown {
  return {
    id: fleetId,
    slug: "default",
    displayName: null,
    activeDomainId: domains[0]?.id ?? null,
    routeRevision: 1,
    policy: resolveFleetPolicy({}),
    domains,
  };
}

describe("fleetSnapshotSchema model binding invariants", () => {
  it("rejects a duplicate model name across inference slots in one domain", () => {
    const result = fleetSnapshotSchema.safeParse(
      createSnapshot([
        createDomain(2, [["example-chat"], ["other-model", "example-chat"]]),
      ]),
    );

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({
        code: "custom",
        message: "model binding names must be unique within a domain",
        path: ["domains", 0, "slots", 1, "spec", "models", 1, "name"],
      }),
    );
  });

  it("rejects a duplicate model name within one inference slot", () => {
    const result = fleetSnapshotSchema.safeParse(
      createSnapshot([createDomain(2, [["example-chat", "example-chat"]])]),
    );

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({
        path: ["domains", 0, "slots", 0, "spec", "models", 1, "name"],
      }),
    );
  });

  it("allows the same model name in different domains", () => {
    const firstDomain = createDomain(2, [["example-chat"]]);
    const secondDomain = createDomain(3, [["example-chat"]]);
    const result = fleetSnapshotSchema.safeParse(
      createSnapshot([firstDomain, secondDomain]),
    );

    expect(result.success).toBe(true);
  });
});
