import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { transitionDomain, markDomainSeen } from "./repo/domains.js";
import { switchActive } from "./repo/fleets.js";
import { applyFleetLayout } from "./repo/layout.js";
import { transitionDomainSlots, transitionSlot } from "./repo/slots.js";
import { getFleetSnapshot } from "./repo/snapshots.js";
import { createTestDatabase, loadExampleFleetLayout } from "./testing/index.js";

import type { HaruDatabase } from "./client.js";
import type { FleetSnapshot } from "@haru/protocol";

let database: HaruDatabase;
let close: () => Promise<void>;
let fleet: FleetSnapshot;

beforeEach(async () => {
  ({ db: database, close } = await createTestDatabase());
  await applyFleetLayout(database, loadExampleFleetLayout());
  const snapshot = await getFleetSnapshot(database, "default");
  if (!snapshot) throw new Error("seed failed");
  fleet = snapshot;
});

afterEach(async () => {
  await close();
});

const alpha = () => fleet.domains.find((d) => d.slug === "alpha")!;
const beta = () => fleet.domains.find((d) => d.slug === "beta")!;

describe("switchActive", () => {
  it("moves the pointer and bumps the revision when the CAS holds", async () => {
    const result = await switchActive(
      database,
      fleet.id,
      alpha().id,
      beta().id,
    );
    expect(result).toEqual({ routeRevision: fleet.routeRevision + 1 });
    const after = await getFleetSnapshot(database, "default");
    expect(after?.activeDomainId).toBe(beta().id);
  });

  it("loses cleanly when the expected pointer is stale", async () => {
    const result = await switchActive(
      database,
      fleet.id,
      beta().id,
      alpha().id,
    );
    expect(result).toBeNull();
    const after = await getFleetSnapshot(database, "default");
    expect(after?.activeDomainId).toBe(alpha().id);
    expect(after?.routeRevision).toBe(fleet.routeRevision);
  });

  it("two concurrent switches produce exactly one winner", async () => {
    const [a, b] = await Promise.all([
      switchActive(database, fleet.id, alpha().id, beta().id),
      switchActive(database, fleet.id, alpha().id, beta().id),
    ]);
    const winners = [a, b].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    const after = await getFleetSnapshot(database, "default");
    expect(after?.routeRevision).toBe(fleet.routeRevision + 1);
  });
});

describe("transitionDomain", () => {
  it("wins only from an expected state", async () => {
    expect(
      await transitionDomain(database, alpha().id, ["ready"], "degraded"),
    ).toBe(true);
    // Second identical transition finds state=degraded and loses.
    expect(
      await transitionDomain(database, alpha().id, ["ready"], "degraded"),
    ).toBe(false);
    expect(
      await transitionDomain(database, alpha().id, ["degraded"], "ready"),
    ).toBe(true);
  });

  it("rejects from-lists that violate the core state table", async () => {
    // ready -> ready is not an edge: the repo layer enforces the core
    // tables at call time instead of silently matching zero rows.
    await expect(
      transitionDomain(database, alpha().id, ["ready", "degraded"], "ready"),
    ).rejects.toThrow(/invalid domain transition/);
  });

  it("markDomainSeen records the heartbeat", async () => {
    const at = new Date("2026-01-02T03:04:05.000Z");
    await markDomainSeen(database, alpha().id, at);
    const after = await getFleetSnapshot(database, "default");
    expect(after?.domains.find((d) => d.slug === "alpha")?.lastSeenAt).toBe(
      at.toISOString(),
    );
  });
});

describe("slot transitions", () => {
  it("transitionSlot is guarded by the expected state", async () => {
    const servingSlot = alpha().slots.find(
      (s) => s.kind === "inference" && s.state === "serving",
    )!;
    expect(
      await transitionSlot(
        database,
        servingSlot.id,
        "inference",
        ["serving"],
        "sleeping",
      ),
    ).toBe(true);
    expect(
      await transitionSlot(
        database,
        servingSlot.id,
        "inference",
        ["serving"],
        "sleeping",
      ),
    ).toBe(false);
  });

  it("transitionDomainSlots moves every matching slot at once", async () => {
    // Beta's two inference slots are sleeping after seed.
    const moved = await transitionDomainSlots(
      database,
      beta().id,
      "inference",
      ["sleeping"],
      "waking",
    );
    expect(moved).toBe(2);
    // Training slots were untouched.
    const after = await getFleetSnapshot(database, "default");
    const betaAfter = after?.domains.find((d) => d.slug === "beta");
    expect(
      betaAfter?.slots
        .filter((s) => s.kind === "training")
        .every((s) => s.state === "idle"),
    ).toBe(true);
    // Second bulk move from the consumed state matches nothing.
    expect(
      await transitionDomainSlots(
        database,
        beta().id,
        "inference",
        ["sleeping"],
        "waking",
      ),
    ).toBe(0);
  });
});
