import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyFleetLayout } from "./repo/layout.js";
import { getFleetSnapshot } from "./repo/snapshots.js";
import { createTestDatabase } from "./testing/index.js";

import type { HaruDatabase } from "./client.js";

const exampleLayout = (): unknown =>
  JSON.parse(
    readFileSync(
      new URL("../examples/fleet.example.json", import.meta.url),
      "utf8",
    ),
  );

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
    const result = await applyFleetLayout(database, exampleLayout());
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
    await applyFleetLayout(database, exampleLayout());
    const before = await getFleetSnapshot(database, "default");
    const second = await applyFleetLayout(database, exampleLayout());
    expect(second.createdFleet).toBe(false);
    const after = await getFleetSnapshot(database, "default");
    expect(after).toEqual(before);
  });

  it("never steals the active pointer from a live fleet", async () => {
    await applyFleetLayout(database, exampleLayout());
    const snapshot = await getFleetSnapshot(database, "default");
    const beta = snapshot?.domains.find((d) => d.slug === "beta");

    // Simulate an earlier promotion to beta, then re-apply the layout
    // that says alpha should be active.
    const { switchActive } = await import("./repo/fleets.js");
    const alphaId = snapshot?.activeDomainId ?? null;
    await switchActive(database, snapshot!.id, alphaId, beta!.id);

    await applyFleetLayout(database, exampleLayout());
    const after = await getFleetSnapshot(database, "default");
    expect(after?.activeDomainId).toBe(beta?.id);
  });

  it("resolves fleets by slug and by id", async () => {
    const { fleetId } = await applyFleetLayout(database, exampleLayout());
    expect((await getFleetSnapshot(database, fleetId))?.id).toBe(fleetId);
    expect((await getFleetSnapshot(database, "default"))?.id).toBe(fleetId);
    expect(await getFleetSnapshot(database, "missing")).toBeNull();
  });

  it("rejects a layout with an unknown active domain", async () => {
    const layout = exampleLayout() as { activeDomainSlug: string };
    layout.activeDomainSlug = "ghost";
    await expect(applyFleetLayout(database, layout)).rejects.toThrow();
  });
});
