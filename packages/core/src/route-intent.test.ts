import { describe, expect, it } from "vitest";

import {
  DOMAIN_A_ID,
  DOMAIN_B_ID,
  domain,
  fleet,
  inferenceSlot,
  trainingSlot,
} from "./fixtures.test-helper.js";
import { buildRouteIntent } from "./route-intent.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");

describe("buildRouteIntent", () => {
  it("marks a ready active domain with all slots serving as eligible", () => {
    const intent = buildRouteIntent(fleet(), NOW);
    expect(intent.revision).toBe(1);
    expect(intent.generatedAt).toBe(NOW.toISOString());
    expect(intent.active?.domainId).toBe(DOMAIN_A_ID);
    expect(intent.active?.eligible).toBe(true);
    expect(intent.active?.weight).toBe(1);
    expect(intent.active?.models.map((m) => m.name)).toEqual([
      "example-chat-small",
    ]);
    expect(intent.standby?.domainId).toBe(DOMAIN_B_ID);
    expect(intent.standby?.eligible).toBe(false);
    expect(intent.standby?.weight).toBe(0);
  });

  it("standby inference slots sleeping does not affect its listing", () => {
    const snapshot = fleet({
      domains: [
        domain(DOMAIN_A_ID, "alpha"),
        domain(DOMAIN_B_ID, "beta", {
          slots: [
            inferenceSlot(DOMAIN_B_ID, { state: "sleeping" }),
            trainingSlot(DOMAIN_B_ID, { state: "training" }),
          ],
        }),
      ],
    });
    const intent = buildRouteIntent(snapshot, NOW);
    expect(intent.standby?.domainId).toBe(DOMAIN_B_ID);
    expect(intent.standby?.eligible).toBe(false);
  });

  it("active is ineligible while an inference slot is not serving", () => {
    const snapshot = fleet({
      domains: [
        domain(DOMAIN_A_ID, "alpha", {
          slots: [
            inferenceSlot(DOMAIN_A_ID, { state: "waking" }),
            trainingSlot(DOMAIN_A_ID),
          ],
        }),
        domain(DOMAIN_B_ID, "beta"),
      ],
    });
    expect(buildRouteIntent(snapshot, NOW).active?.eligible).toBe(false);
  });

  it("active is ineligible when the domain is failed or has no URL", () => {
    const failed = fleet({
      domains: [
        domain(DOMAIN_A_ID, "alpha", { state: "failed" }),
        domain(DOMAIN_B_ID, "beta"),
      ],
    });
    expect(buildRouteIntent(failed, NOW).active?.eligible).toBe(false);

    const noUrl = fleet({
      domains: [
        domain(DOMAIN_A_ID, "alpha", { servingBaseUrl: null }),
        domain(DOMAIN_B_ID, "beta"),
      ],
    });
    expect(buildRouteIntent(noUrl, NOW).active?.eligible).toBe(false);
  });

  it("a degraded active with serving slots stays eligible", () => {
    const snapshot = fleet({
      domains: [
        domain(DOMAIN_A_ID, "alpha", { state: "degraded" }),
        domain(DOMAIN_B_ID, "beta"),
      ],
    });
    expect(buildRouteIntent(snapshot, NOW).active?.eligible).toBe(true);
  });

  it("returns null active when the fleet has no active pointer", () => {
    const intent = buildRouteIntent(fleet({ activeDomainId: null }), NOW);
    expect(intent.active).toBeNull();
    // The first domain becomes the reported standby candidate.
    expect(intent.standby?.domainId).toBe(DOMAIN_A_ID);
  });

  it("an inference-slot-less domain is never eligible", () => {
    const snapshot = fleet({
      domains: [
        domain(DOMAIN_A_ID, "alpha", {
          slots: [trainingSlot(DOMAIN_A_ID)],
        }),
        domain(DOMAIN_B_ID, "beta"),
      ],
    });
    expect(buildRouteIntent(snapshot, NOW).active?.eligible).toBe(false);
  });
});
