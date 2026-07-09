import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyFleetLayout } from "./repo/layout.js";
import { getFleetSnapshot } from "./repo/snapshots.js";
import { createTestDatabase, loadExampleFleetLayout } from "./testing/index.js";

import type { HaruDatabase } from "./client.js";

let database: HaruDatabase;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db: database, close } = await createTestDatabase());
});

afterEach(async () => {
  await close();
});

describe("applyFleetLayout", () => {
  it("materialises the example layout with derived initial states", async () => {
    const result = await applyFleetLayout(database, loadExampleFleetLayout());
    expect(result.createdFleet).toBe(true);
    expect(
      result.domains.map((d) => d.slug).toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(["alpha", "beta"]);

    const snapshot = await getFleetSnapshot(database, "default");
    expect(snapshot).not.toBeNull();
    const alpha = snapshot?.domains.find((d) => d.slug === "alpha");
    const beta = snapshot?.domains.find((d) => d.slug === "beta");

    // Static provider domains come up ready.
    expect(alpha?.state).toBe("ready");
    expect(beta?.state).toBe("ready");

    // Active domain serves; standby inference slots sleep (level 1).
    expect(snapshot?.activeDomainId).toBe(alpha?.id);
    expect(
      alpha?.slots
        .filter((s) => s.kind === "inference")
        .every((s) => s.state === "serving"),
    ).toBe(true);
    expect(
      beta?.slots
        .filter((s) => s.kind === "inference")
        .every((s) => s.state === "sleeping"),
    ).toBe(true);
    expect(
      snapshot?.domains
        .flatMap((d) => d.slots)
        .filter((s) => s.kind === "training")
        .every((s) => s.state === "idle"),
    ).toBe(true);
  });

  it("is idempotent: re-applying changes nothing", async () => {
    await applyFleetLayout(database, loadExampleFleetLayout());
    const before = await getFleetSnapshot(database, "default");
    const second = await applyFleetLayout(database, loadExampleFleetLayout());
    expect(second.createdFleet).toBe(false);
    const after = await getFleetSnapshot(database, "default");
    expect(after).toEqual(before);
  });

  it("never steals the active pointer from a live fleet", async () => {
    await applyFleetLayout(database, loadExampleFleetLayout());
    const snapshot = await getFleetSnapshot(database, "default");
    const beta = snapshot?.domains.find((d) => d.slug === "beta");

    // Simulate an earlier promotion to beta, then re-apply the layout
    // that says alpha should be active.
    const { switchActive } = await import("./repo/fleets.js");
    const alphaId = snapshot?.activeDomainId ?? null;
    await switchActive(database, snapshot!.id, alphaId, beta!.id);

    await applyFleetLayout(database, loadExampleFleetLayout());
    const after = await getFleetSnapshot(database, "default");
    expect(after?.activeDomainId).toBe(beta?.id);
  });

  it("derives new slots' states from the LIVE pointer after a promotion", async () => {
    await applyFleetLayout(database, loadExampleFleetLayout());
    const before = await getFleetSnapshot(database, "default");
    const alpha = before?.domains.find((d) => d.slug === "alpha");
    const beta = before?.domains.find((d) => d.slug === "beta");

    // Promotion moved routing to beta.
    const { switchActive } = await import("./repo/fleets.js");
    await switchActive(database, before!.id, alpha!.id, beta!.id);

    // Operator extends the ORIGINAL layout (which still declares alpha
    // active) with one more inference slot per domain and re-applies.
    const layout = loadExampleFleetLayout() as {
      domains: { slug: string; slots: unknown[] }[];
    };
    for (const domain of layout.domains) {
      domain.slots.push({
        kind: "inference",
        gpuIndex: 7,
        models: [
          {
            name: "example-chat-added",
            servingUrl: `https://${domain.slug}-added.test`,
          },
        ],
      });
    }
    await applyFleetLayout(database, layout);

    const after = await getFleetSnapshot(database, "default");
    const addedOn = (slug: string) =>
      after?.domains
        .find((d) => d.slug === slug)
        ?.slots.find((s) => s.gpuIndex === 7);
    // The ACTUAL active (beta) gets the serving slot; the layout's
    // stale activeDomainSlug (alpha) must not override live routing.
    expect(addedOn("beta")?.state).toBe("serving");
    expect(addedOn("alpha")?.state).toBe("sleeping");
  });

  it("resolves fleets by slug and by id", async () => {
    const { fleetId } = await applyFleetLayout(
      database,
      loadExampleFleetLayout(),
    );
    expect((await getFleetSnapshot(database, fleetId))?.id).toBe(fleetId);
    expect((await getFleetSnapshot(database, "default"))?.id).toBe(fleetId);
    expect(await getFleetSnapshot(database, "missing")).toBeNull();
  });

  it("prefers id over a colliding UUID-shaped slug", async () => {
    const { fleetId } = await applyFleetLayout(
      database,
      loadExampleFleetLayout(),
    );
    // The slug charset admits UUID-shaped strings: a second fleet
    // whose slug IS the first fleet's id must not shadow the id
    // lookup (nor win by planner whim).
    const collider = loadExampleFleetLayout() as { slug: string };
    collider.slug = fleetId;
    const { fleetId: colliderId } = await applyFleetLayout(database, collider);
    expect(colliderId).not.toBe(fleetId);
    expect((await getFleetSnapshot(database, fleetId))?.id).toBe(fleetId);
  });

  it("falls back to the slug lookup for a UUID-shaped reference matching no id", async () => {
    const uuidShapedSlug = "00000000-0000-4000-8000-000000000000";
    const layout = loadExampleFleetLayout() as { slug: string };
    layout.slug = uuidShapedSlug;
    const { fleetId } = await applyFleetLayout(database, layout);
    expect((await getFleetSnapshot(database, uuidShapedSlug))?.id).toBe(
      fleetId,
    );
  });

  it("rejects a layout with an unknown active domain", async () => {
    const layout = loadExampleFleetLayout() as { activeDomainSlug: string };
    layout.activeDomainSlug = "ghost";
    await expect(applyFleetLayout(database, layout)).rejects.toThrow();
  });
});
