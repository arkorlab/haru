import {
  MAX_PROBE_PROMPT_CODE_POINTS,
  MAX_PROBE_TOKENS,
  type FleetSnapshot,
} from "@haru/protocol";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyFleetLayout } from "./repo/layout.js";
import {
  getFleetSnapshot,
  MalformedFleetStateError,
} from "./repo/snapshots.js";
import { fleets, operations, slots } from "./schema/index.js";
import { createTestDatabase, loadExampleFleetLayout } from "./testing/index.js";

import type { HaruDatabase } from "./client.js";

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

async function seedOtherFleet(): Promise<FleetSnapshot> {
  const otherLayout = loadExampleFleetLayout() as { slug: string };
  otherLayout.slug = "other";
  await applyFleetLayout(database, otherLayout);
  const snapshot = await getFleetSnapshot(database, "other");
  if (!snapshot) throw new Error("second fleet seed failed");
  return snapshot;
}

describe("database ownership constraints", () => {
  it("rejects a direct cross-fleet active pointer write", async () => {
    const otherFleet = await seedOtherFleet();
    const otherDomain = otherFleet.domains[0]!;

    await expect(
      database
        .update(fleets)
        .set({ activeDomainId: otherDomain.id })
        .where(eq(fleets.id, fleet.id)),
    ).rejects.toThrow();
  });

  it("rejects a direct cross-fleet operation target", async () => {
    const otherFleet = await seedOtherFleet();
    const otherDomain = otherFleet.domains[0]!;

    await expect(
      database.insert(operations).values({
        fleetId: fleet.id,
        kind: "promote",
        targetDomainId: otherDomain.id,
        sourceDomainId: fleet.activeDomainId,
      }),
    ).rejects.toThrow();
  });

  it("rejects a direct cross-fleet operation source", async () => {
    const otherFleet = await seedOtherFleet();
    const targetDomain = fleet.domains[0]!;

    await expect(
      database.insert(operations).values({
        fleetId: fleet.id,
        kind: "promote",
        targetDomainId: targetDomain.id,
        sourceDomainId: otherFleet.activeDomainId,
      }),
    ).rejects.toThrow();
  });

  it("rejects slot states that do not belong to the slot kind", async () => {
    const inferenceSlot = fleet.domains
      .flatMap((domain) => domain.slots)
      .find((slot) => slot.kind === "inference");
    if (!inferenceSlot) throw new Error("inference slot missing");

    await expect(
      database
        .update(slots)
        .set({ state: "training" })
        .where(eq(slots.id, inferenceSlot.id)),
    ).rejects.toThrow();
  });
});

describe("stored probe policy constraints", () => {
  it("accepts the prompt and token limits, including astral code points", async () => {
    const rows = await database
      .update(fleets)
      .set({
        policy: {
          probe: {
            prompt: "😀".repeat(MAX_PROBE_PROMPT_CODE_POINTS),
            maxTokens: MAX_PROBE_TOKENS,
          },
        },
      })
      .where(eq(fleets.id, fleet.id))
      .returning({ id: fleets.id });
    expect(rows).toEqual([{ id: fleet.id }]);
  });

  it("rejects a prompt above the Unicode code-point limit", async () => {
    await expect(
      database
        .update(fleets)
        .set({
          policy: {
            probe: {
              prompt: "😀".repeat(MAX_PROBE_PROMPT_CODE_POINTS + 1),
            },
          },
        })
        .where(eq(fleets.id, fleet.id)),
    ).rejects.toThrow();
  });

  it("rejects maxTokens above the generation limit", async () => {
    await expect(
      database
        .update(fleets)
        .set({
          policy: {
            probe: {
              maxTokens: MAX_PROBE_TOKENS + 1,
            },
          },
        })
        .where(eq(fleets.id, fleet.id)),
    ).rejects.toThrow();
  });
});

describe("fleet snapshot persistence boundary", () => {
  it("rejects an invalid kind/state pair even without the DB CHECK", async () => {
    const inferenceSlot = fleet.domains
      .flatMap((domain) => domain.slots)
      .find((slot) => slot.kind === "inference");
    if (!inferenceSlot) throw new Error("inference slot missing");

    // Simulate an older or manually drifted database. The core-owned
    // state validation at the read boundary remains the last defense.
    await database.execute(
      sql`ALTER TABLE "slots" DROP CONSTRAINT "slots_kind_state_valid"`,
    );
    await database
      .update(slots)
      .set({ state: "training" })
      .where(eq(slots.id, inferenceSlot.id));

    await expect(getFleetSnapshot(database, fleet.id)).rejects.toBeInstanceOf(
      MalformedFleetStateError,
    );
  });

  it("wraps an out-of-fleet active pointer as malformed state", async () => {
    const otherFleet = await seedOtherFleet();
    const otherDomain = otherFleet.domains[0]!;

    // Exercise the protocol relationship check independently of the
    // new FK, as if this were data inherited from an older schema.
    await database.execute(
      sql`ALTER TABLE "fleets" DROP CONSTRAINT "fleets_active_domain_membership_fk"`,
    );
    await database
      .update(fleets)
      .set({ activeDomainId: otherDomain.id })
      .where(eq(fleets.id, fleet.id));

    await expect(getFleetSnapshot(database, fleet.id)).rejects.toBeInstanceOf(
      MalformedFleetStateError,
    );
  });
});
