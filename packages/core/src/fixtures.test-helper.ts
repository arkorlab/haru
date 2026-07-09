import {
  fleetPolicySchema,
  type DomainSnapshot,
  type FleetPolicy,
  type FleetSnapshot,
  type SlotSnapshot,
} from "@haru/protocol";

/**
 * Test fixture builders. Deterministic UUIDs keep assertions readable;
 * the shapes still satisfy the protocol schemas.
 */

export const FLEET_ID = "00000000-0000-4000-8000-00000000000f";
export const DOMAIN_A_ID = "00000000-0000-4000-8000-00000000000a";
export const DOMAIN_B_ID = "00000000-0000-4000-8000-00000000000b";

const nextSlotId = (() => {
  let counter = 0;
  return (): string => {
    counter += 1;
    return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
  };
})();

export function inferenceSlot(
  domainId: string,
  overrides: Partial<SlotSnapshot> = {},
): SlotSnapshot {
  return {
    id: nextSlotId(),
    domainId,
    gpuIndex: 0,
    kind: "inference",
    state: "serving",
    spec: {
      kind: "inference",
      sleepLevel: 1,
      models: [
        {
          name: "example-chat-small",
          servingUrl: "http://127.0.0.1:8001",
        },
      ],
    },
    ...overrides,
  };
}

export function trainingSlot(
  domainId: string,
  overrides: Partial<SlotSnapshot> = {},
): SlotSnapshot {
  return {
    id: nextSlotId(),
    domainId,
    gpuIndex: 0,
    kind: "training",
    state: "idle",
    spec: {
      kind: "training",
      command: ["python", "train.py"],
      checkpointDir: "/checkpoints",
    },
    ...overrides,
  };
}

export function domain(
  id: string,
  slug: string,
  overrides: Partial<DomainSnapshot> = {},
): DomainSnapshot {
  return {
    id,
    fleetId: FLEET_ID,
    slug,
    state: "ready",
    provider: "static",
    placement: {
      cloud: "aws",
      region: "us-east-1",
      accelerator: "SOME-GPU",
      acceleratorCount: 2,
      useSpot: false,
    },
    supervisorUrl: `http://127.0.0.1:87${slug === "alpha" ? "01" : "02"}`,
    servingBaseUrl: `http://127.0.0.1:90${slug === "alpha" ? "01" : "02"}`,
    lastSeenAt: null,
    slots: [inferenceSlot(id), trainingSlot(id)],
    ...overrides,
  };
}

export function fleet(overrides: Partial<FleetSnapshot> = {}): FleetSnapshot {
  const policy: FleetPolicy = fleetPolicySchema.parse({});
  return {
    id: FLEET_ID,
    slug: "default",
    displayName: null,
    activeDomainId: DOMAIN_A_ID,
    routeRevision: 1,
    policy,
    domains: [domain(DOMAIN_A_ID, "alpha"), domain(DOMAIN_B_ID, "beta")],
    ...overrides,
  };
}
