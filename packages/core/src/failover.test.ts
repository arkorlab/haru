import { fleetPolicySchema } from "@haru/protocol";
import { describe, expect, it } from "vitest";

import { detectDegradedEscalation, detectFailover } from "./failover.js";
import {
  DOMAIN_A_ID,
  DOMAIN_B_ID,
  domain,
  fleet,
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
        domain(DOMAIN_B_ID, "beta"),
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

  it("does nothing while no standby is promotable", () => {
    // Escalating would 503 the active's remaining healthy models with
    // nobody to fail over to.
    const snapshot = fleet({
      policy: autoFailoverPolicy,
      domains: [
        domain(DOMAIN_A_ID, "alpha", {
          state: "degraded",
          stateUpdatedAt: PAST_GRACE,
        }),
        domain(DOMAIN_B_ID, "beta", { state: "provisioning" }),
      ],
    });
    expect(detectDegradedEscalation(snapshot, NOW_MS)).toBeNull();
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
