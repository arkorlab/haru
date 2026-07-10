import { fleetPolicySchema } from "@haru/protocol";
import { describe, expect, it } from "vitest";

import { detectDegradedEscalation, detectFailover } from "./failover.js";
import {
  DOMAIN_A_ID,
  DOMAIN_B_ID,
  domain,
  fleet,
  inferenceSlot,
  trainingSlot,
} from "./fixtures.test-helper.js";

const NOW_MS = Date.parse("2026-01-01T00:10:00.000Z");
const FRESH = new Date(NOW_MS - 1000).toISOString();
const STALE = new Date(NOW_MS - 120_000).toISOString();

const autoFailoverPolicy = fleetPolicySchema.parse({ autoFailover: true });

describe("detectFailover", () => {
  it("returns null when autoFailover is off, even with a failed active", () => {
    const snapshot = fleet({
      domains: [
        domain(DOMAIN_A_ID, "alpha", { state: "failed" }),
        domain(DOMAIN_B_ID, "beta"),
      ],
    });
    expect(detectFailover(snapshot, NOW_MS)).toBeNull();
  });

  it("promotes the standby when the active heartbeat is stale", () => {
    const snapshot = fleet({
      policy: autoFailoverPolicy,
      domains: [
        domain(DOMAIN_A_ID, "alpha", { lastSeenAt: STALE }),
        domain(DOMAIN_B_ID, "beta"),
      ],
    });
    const intent = detectFailover(snapshot, NOW_MS);
    expect(intent?.targetDomainId).toBe(DOMAIN_B_ID);
    expect(intent?.reason).toContain("stale");
  });

  it("promotes the standby when the active domain is failed", () => {
    const snapshot = fleet({
      policy: autoFailoverPolicy,
      domains: [
        domain(DOMAIN_A_ID, "alpha", { state: "failed", lastSeenAt: FRESH }),
        domain(DOMAIN_B_ID, "beta"),
      ],
    });
    expect(detectFailover(snapshot, NOW_MS)?.targetDomainId).toBe(DOMAIN_B_ID);
  });

  it("returns null while the active heartbeat is fresh", () => {
    const snapshot = fleet({
      policy: autoFailoverPolicy,
      domains: [
        domain(DOMAIN_A_ID, "alpha", { lastSeenAt: FRESH }),
        domain(DOMAIN_B_ID, "beta"),
      ],
    });
    expect(detectFailover(snapshot, NOW_MS)).toBeNull();
  });

  it("a never-seen active does not trigger failover", () => {
    const snapshot = fleet({
      policy: autoFailoverPolicy,
      domains: [
        domain(DOMAIN_A_ID, "alpha", { lastSeenAt: null }),
        domain(DOMAIN_B_ID, "beta"),
      ],
    });
    expect(detectFailover(snapshot, NOW_MS)).toBeNull();
  });

  it("returns null when no standby is promotable", () => {
    const snapshot = fleet({
      policy: autoFailoverPolicy,
      domains: [
        domain(DOMAIN_A_ID, "alpha", { state: "failed" }),
        domain(DOMAIN_B_ID, "beta", { state: "provisioning" }),
      ],
    });
    expect(detectFailover(snapshot, NOW_MS)).toBeNull();
  });

  it("returns null when the fleet has no active pointer", () => {
    const snapshot = fleet({
      policy: autoFailoverPolicy,
      activeDomainId: null,
    });
    expect(detectFailover(snapshot, NOW_MS)).toBeNull();
  });

  it("prefers a viable standby over a higher-ranked dud", () => {
    const GAMMA_ID = "00000000-0000-4000-8000-00000000000c";
    const snapshot = fleet({
      policy: autoFailoverPolicy,
      domains: [
        domain(DOMAIN_A_ID, "alpha", { state: "failed" }),
        // beta ranks first (slug) but has no supervisor to drive the
        // promotion; repeatedly picking it would starve gamma forever.
        domain(DOMAIN_B_ID, "beta", { supervisorUrl: null }),
        domain(GAMMA_ID, "gamma", { lastSeenAt: FRESH }),
      ],
    });
    expect(detectFailover(snapshot, NOW_MS)?.targetDomainId).toBe(GAMMA_ID);
  });

  it("falls back to a promotable-state standby when nothing is viable", () => {
    const snapshot = fleet({
      policy: autoFailoverPolicy,
      domains: [
        domain(DOMAIN_A_ID, "alpha", { state: "failed" }),
        domain(DOMAIN_B_ID, "beta", { supervisorUrl: null }),
      ],
    });
    // A dead active serves nothing; any attempt beats none.
    expect(detectFailover(snapshot, NOW_MS)?.targetDomainId).toBe(DOMAIN_B_ID);
  });

  it("never falls back to a training-only standby (promotion cannot succeed)", () => {
    const snapshot = fleet({
      policy: autoFailoverPolicy,
      domains: [
        domain(DOMAIN_A_ID, "alpha", { state: "failed" }),
        domain(DOMAIN_B_ID, "beta", { slots: [trainingSlot(DOMAIN_B_ID)] }),
      ],
    });
    expect(detectFailover(snapshot, NOW_MS)).toBeNull();
  });

  it("prefers a ready standby over a degraded one (ranking)", () => {
    const GAMMA_ID = "00000000-0000-4000-8000-00000000000c";
    const snapshot = fleet({
      policy: autoFailoverPolicy,
      domains: [
        domain(DOMAIN_A_ID, "alpha", { state: "failed" }),
        // beta sorts first by slug but is degraded; gamma is ready.
        domain(DOMAIN_B_ID, "beta", { state: "degraded" }),
        domain(GAMMA_ID, "gamma", { state: "ready" }),
      ],
    });
    expect(detectFailover(snapshot, NOW_MS)?.targetDomainId).toBe(GAMMA_ID);
  });
});

describe("detectDegradedEscalation", () => {
  const graceMs = fleetPolicySchema.parse({}).degradedGraceMs;
  const degradedActive = (stateUpdatedAt: string) =>
    fleet({
      policy: autoFailoverPolicy,
      domains: [
        domain(DOMAIN_A_ID, "alpha", { state: "degraded", stateUpdatedAt }),
        // A viable failover target: promotable, supervised, bound
        // models, and a fresh heartbeat.
        domain(DOMAIN_B_ID, "beta", { lastSeenAt: FRESH }),
      ],
    });
  const PAST_GRACE = new Date(NOW_MS - graceMs - 1000).toISOString();
  const WITHIN_GRACE = new Date(NOW_MS - graceMs + 1000).toISOString();

  it("escalates the active once degraded outlasts the grace", () => {
    const escalation = detectDegradedEscalation(
      degradedActive(PAST_GRACE),
      NOW_MS,
    );
    expect(escalation?.domainId).toBe(DOMAIN_A_ID);
    expect(escalation?.reason).toContain("degraded for");
  });

  it("does nothing within the grace window", () => {
    expect(
      detectDegradedEscalation(degradedActive(WITHIN_GRACE), NOW_MS),
    ).toBeNull();
  });

  it("does nothing when autoFailover is off", () => {
    const snapshot = fleet({
      domains: [
        domain(DOMAIN_A_ID, "alpha", {
          state: "degraded",
          stateUpdatedAt: PAST_GRACE,
        }),
        domain(DOMAIN_B_ID, "beta"),
      ],
    });
    expect(detectDegradedEscalation(snapshot, NOW_MS)).toBeNull();
  });

  it("does nothing while no standby is a VIABLE failover target", () => {
    // Escalating would 503 the active's remaining healthy models with
    // nobody able to take over. Viability = promotable state AND a
    // supervisor URL AND inference bindings AND a fresh heartbeat.
    const nonViableStandbys = [
      // Not promotable.
      domain(DOMAIN_B_ID, "beta", {
        state: "provisioning",
        lastSeenAt: FRESH,
      }),
      // Unreachable supervisor (stale heartbeat / never seen).
      domain(DOMAIN_B_ID, "beta", { lastSeenAt: STALE }),
      domain(DOMAIN_B_ID, "beta", { lastSeenAt: null }),
      // Degraded = its most recent heartbeat FAILED; lastSeenAt still
      // records the last success, so freshness alone would misread a
      // just-unreachable standby as viable.
      domain(DOMAIN_B_ID, "beta", { state: "degraded", lastSeenAt: FRESH }),
      // No supervisor to drive the promotion.
      domain(DOMAIN_B_ID, "beta", {
        supervisorUrl: null,
        lastSeenAt: FRESH,
      }),
      // Local vLLM observed unreachable (heartbeat marked the standby
      // slot failed): waking it would stall.
      domain(DOMAIN_B_ID, "beta", {
        lastSeenAt: FRESH,
        slots: [inferenceSlot(DOMAIN_B_ID, { state: "failed" })],
      }),
    ];
    for (const standby of nonViableStandbys) {
      const snapshot = fleet({
        policy: autoFailoverPolicy,
        domains: [
          domain(DOMAIN_A_ID, "alpha", {
            state: "degraded",
            stateUpdatedAt: PAST_GRACE,
          }),
          standby,
        ],
      });
      expect(detectDegradedEscalation(snapshot, NOW_MS)).toBeNull();
    }
  });

  it("never escalates a degraded standby", () => {
    const snapshot = fleet({
      policy: autoFailoverPolicy,
      domains: [
        domain(DOMAIN_A_ID, "alpha"),
        domain(DOMAIN_B_ID, "beta", {
          state: "degraded",
          stateUpdatedAt: PAST_GRACE,
        }),
      ],
    });
    expect(detectDegradedEscalation(snapshot, NOW_MS)).toBeNull();
  });
});
