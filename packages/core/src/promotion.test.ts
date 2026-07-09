import { describe, expect, it } from "vitest";

import {
  DOMAIN_A_ID,
  DOMAIN_B_ID,
  domain,
  fleet,
} from "./fixtures.test-helper.js";
import { decideDemotion, decidePromotion } from "./promotion.js";

describe("decidePromotion", () => {
  it("returns already_active for the current active domain", () => {
    const decision = decidePromotion(fleet(), DOMAIN_A_ID);
    expect(decision).toEqual({ type: "already_active", routeRevision: 1 });
  });

  it("creates an operation for a ready standby", () => {
    const decision = decidePromotion(fleet(), DOMAIN_B_ID);
    expect(decision).toEqual({ type: "create", targetDomainId: DOMAIN_B_ID });
  });

  it("allows promoting a degraded standby", () => {
    const snapshot = fleet({
      domains: [
        domain(DOMAIN_A_ID, "alpha"),
        domain(DOMAIN_B_ID, "beta", { state: "degraded" }),
      ],
    });
    expect(decidePromotion(snapshot, DOMAIN_B_ID).type).toBe("create");
  });

  it("rejects a domain outside the fleet", () => {
    const decision = decidePromotion(
      fleet(),
      "00000000-0000-4000-8000-0000000000ff",
    );
    expect(decision.type).toBe("invalid_target");
  });

  it("rejects non-promotable domain states", () => {
    for (const state of [
      "provisioning",
      "failed",
      "stopping",
      "stopped",
    ] as const) {
      const snapshot = fleet({
        domains: [
          domain(DOMAIN_A_ID, "alpha"),
          domain(DOMAIN_B_ID, "beta", { state }),
        ],
      });
      const decision = decidePromotion(snapshot, DOMAIN_B_ID);
      expect(decision.type, state).toBe("invalid_target");
    }
  });

  it("is deterministic for repeated calls (idempotent decision)", () => {
    const snapshot = fleet();
    expect(decidePromotion(snapshot, DOMAIN_B_ID)).toEqual(
      decidePromotion(snapshot, DOMAIN_B_ID),
    );
  });
});

describe("decideDemotion", () => {
  it("never demotes the active domain", () => {
    const decision = decideDemotion(fleet(), DOMAIN_A_ID);
    expect(decision.type).toBe("invalid_target");
  });

  it("creates an operation for a ready standby", () => {
    expect(decideDemotion(fleet(), DOMAIN_B_ID)).toEqual({
      type: "create",
      targetDomainId: DOMAIN_B_ID,
    });
  });

  it("rejects unknown domains", () => {
    expect(
      decideDemotion(fleet(), "00000000-0000-4000-8000-0000000000ff").type,
    ).toBe("invalid_target");
  });
});
