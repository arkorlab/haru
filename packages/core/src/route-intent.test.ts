import { describe, expect, it } from "vitest";

import {
  DOMAIN_A_ID,
  DOMAIN_B_ID,
  domain,
  fleet,
  inferenceSlot,
  trainingSlot,
} from "./fixtures.test-helper.js";
import {
  buildRouteIntent,
  findRoutableBinding,
  rankStandbys,
} from "./route-intent.js";

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
    expect(intent.standbys.map((s) => s.domainId)).toEqual([DOMAIN_B_ID]);
    expect(intent.standbys[0]?.eligible).toBe(false);
    expect(intent.standbys[0]?.weight).toBe(0);
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
    expect(intent.standbys[0]?.domainId).toBe(DOMAIN_B_ID);
    expect(intent.standbys[0]?.eligible).toBe(false);
  });

  it("active is ineligible while NO inference slot is serving", () => {
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
    const active = buildRouteIntent(snapshot, NOW).active;
    expect(active?.eligible).toBe(false);
    expect(active?.models.every((m) => !m.eligible)).toBe(true);
  });

  it("a partially failed active stays eligible with per-model detail", () => {
    // GPU 0 serves; GPU 1's slot failed. The domain keeps serving its
    // healthy model (chat proxy behavior), and route intent reports
    // exactly which model is down instead of an all-or-nothing false.
    const snapshot = fleet({
      domains: [
        domain(DOMAIN_A_ID, "alpha", {
          slots: [
            inferenceSlot(DOMAIN_A_ID, { state: "serving" }),
            inferenceSlot(DOMAIN_A_ID, {
              gpuIndex: 1,
              state: "failed",
              spec: {
                kind: "inference",
                sleepLevel: 1,
                models: [
                  {
                    name: "example-chat-large",
                    servingUrl: "http://127.0.0.1:8002",
                  },
                ],
              },
            }),
          ],
        }),
        domain(DOMAIN_B_ID, "beta"),
      ],
    });
    const active = buildRouteIntent(snapshot, NOW).active;
    expect(active?.eligible).toBe(true);
    expect(active?.models.map((m) => [m.name, m.eligible])).toEqual([
      ["example-chat-small", true],
      ["example-chat-large", false],
    ]);
    // The chat proxy resolves through the same predicate.
    const alpha = snapshot.domains.find((d) => d.id === DOMAIN_A_ID)!;
    expect(findRoutableBinding(alpha, "example-chat-small")?.servingUrl).toBe(
      "http://127.0.0.1:8001",
    );
    expect(findRoutableBinding(alpha, "example-chat-large")).toBeNull();
    expect(findRoutableBinding(alpha, "missing")).toBeNull();
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
    // Every domain is a reported standby candidate, ranked.
    expect(intent.standbys.map((s) => s.domainId)).toEqual([
      DOMAIN_A_ID,
      DOMAIN_B_ID,
    ]);
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

describe("rankStandbys", () => {
  const GAMMA_ID = "00000000-0000-4000-8000-00000000000c";

  it("ranks ready over degraded, then most recent heartbeat, then slug", () => {
    const snapshot = fleet({
      domains: [
        domain(DOMAIN_A_ID, "alpha"),
        domain(DOMAIN_B_ID, "beta", {
          state: "degraded",
          lastSeenAt: "2026-01-01T00:00:09.000Z",
        }),
        domain(GAMMA_ID, "gamma", {
          state: "ready",
          lastSeenAt: "2026-01-01T00:00:01.000Z",
        }),
      ],
    });
    // gamma (ready) outranks beta (degraded) despite the older
    // heartbeat: state dominates freshness.
    expect(rankStandbys(snapshot).map((d) => d.slug)).toEqual([
      "gamma",
      "beta",
    ]);
  });

  it("prefers the most recently seen among equal states; never-seen last", () => {
    const snapshot = fleet({
      domains: [
        domain(DOMAIN_A_ID, "alpha"),
        domain(DOMAIN_B_ID, "beta", { lastSeenAt: null }),
        domain(GAMMA_ID, "gamma", {
          lastSeenAt: "2026-01-01T00:00:01.000Z",
        }),
      ],
    });
    expect(rankStandbys(snapshot).map((d) => d.slug)).toEqual([
      "gamma",
      "beta",
    ]);
  });
});
