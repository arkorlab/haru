import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { MAX_PROBE_PROMPT_CODE_POINTS, MAX_PROBE_TOKENS } from "@haru/protocol";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";

import type { MigrationMeta } from "drizzle-orm/migrator";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

async function applyMigration(
  client: PGlite,
  migration: MigrationMeta,
): Promise<void> {
  for (const statement of migration.sql) {
    await client.exec(statement);
  }
}

describe("0003 legacy policy preflight", () => {
  it("stops on each dirty upper bound and succeeds after explicit repair", async () => {
    const client = new PGlite();
    try {
      const migrations = readMigrationFiles({ migrationsFolder });
      const legacyMigrations = migrations.slice(0, 3);
      const migration = migrations[3];
      if (!migration) throw new Error("0003 migration missing");
      for (const legacyMigration of legacyMigrations) {
        await applyMigration(client, legacyMigration);
      }

      await client.query(
        `INSERT INTO fleets (slug, policy)
         VALUES ($1, $2::jsonb), ($3, $4::jsonb)`,
        [
          "oversized-prompt",
          JSON.stringify({
            probe: {
              prompt: "x".repeat(MAX_PROBE_PROMPT_CODE_POINTS + 1),
            },
          }),
          "oversized-tokens",
          JSON.stringify({
            probe: { maxTokens: MAX_PROBE_TOKENS + 1 },
          }),
        ],
      );

      const preflight = migration.sql[0];
      if (!preflight) throw new Error("0003 preflight missing");
      await expect(client.exec(preflight)).rejects.toThrow(
        /probe.prompt exceeds 8192 Unicode code points/,
      );

      // The migration never truncates operator data. Repair the first
      // row explicitly at the astral-character boundary, then the next
      // incompatible row becomes the reported blocker.
      await client.query(
        "UPDATE fleets SET policy = $1::jsonb WHERE slug = $2",
        [
          JSON.stringify({
            probe: {
              prompt: "😀".repeat(MAX_PROBE_PROMPT_CODE_POINTS),
            },
          }),
          "oversized-prompt",
        ],
      );
      await expect(client.exec(preflight)).rejects.toThrow(
        /probe.maxTokens exceeds 256/,
      );

      await client.query(
        "UPDATE fleets SET policy = $1::jsonb WHERE slug = $2",
        [
          JSON.stringify({
            probe: { maxTokens: MAX_PROBE_TOKENS },
          }),
          "oversized-tokens",
        ],
      );
      await applyMigration(client, migration);

      const constraints = await client.query<{ name: string }>(
        `SELECT conname AS name
         FROM pg_constraint
         WHERE conname = 'fleets_probe_policy_limits'`,
      );
      expect(constraints.rows).toEqual([
        { name: "fleets_probe_policy_limits" },
      ]);
    } finally {
      await client.close();
    }
  });
});
