import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import * as schema from "../schema/index.js";

import type { HaruDatabase } from "../client.js";

const migrationsFolder = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);

export interface TestDatabase {
  db: HaruDatabase;
  close: () => Promise<void>;
}

/**
 * Migrated-data-dir snapshot, built once per vitest worker: the first
 * database boots PGlite and replays the committed migrations, every
 * later one clones the dumped data dir instead of re-running them
 * (migration replay dominates test wall-clock otherwise).
 */
async function buildMigratedDataDirectory(): Promise<Blob | File> {
  const seed = new PGlite();
  const seedDatabase = drizzle({ client: seed, schema });
  await migrate(seedDatabase, { migrationsFolder });
  const dump = await seed.dumpDataDir("none");
  await seed.close();
  return dump;
}

const migratedDataDirectory = (() => {
  let cached: Promise<Blob | File> | null = null;
  return (): Promise<Blob | File> => {
    cached ??= buildMigratedDataDirectory();
    return cached;
  };
})();

async function createPgliteTestDatabase(): Promise<TestDatabase> {
  const client = new PGlite({ loadDataDir: await migratedDataDirectory() });
  const database = drizzle({ client, schema });
  return {
    db: database as unknown as HaruDatabase,
    close: () => client.close(),
  };
}

/**
 * Real-Postgres lane: one throwaway database per call on the server
 * behind HARU_TEST_DATABASE_URL (CI service container), dropped on
 * close. Unlike single-connection PGlite, the node-postgres pool runs
 * concurrent statements for real, so the Promise.all CAS races in the
 * suites exercise row-lock waits and predicate re-evaluation. The
 * `pg` dependency is imported lazily so the default PGlite path never
 * loads it.
 */
async function createPostgresTestDatabase(
  adminUrl: string,
): Promise<TestDatabase> {
  const { default: pg } = await import("pg");
  const { drizzle: drizzleNodePostgres } =
    await import("drizzle-orm/node-postgres");
  const { migrate: migrateNodePostgres } =
    await import("drizzle-orm/node-postgres/migrator");

  const databaseName = `haru_test_${randomBytes(8).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  // Generated identifier (hex only), no injection surface.
  await admin.query(`CREATE DATABASE ${databaseName}`);
  await admin.end();

  const testUrl = new URL(adminUrl);
  testUrl.pathname = `/${databaseName}`;
  const pool = new pg.Pool({ connectionString: testUrl.href });
  const database = drizzleNodePostgres({ client: pool, schema });
  await migrateNodePostgres(database, { migrationsFolder });

  return {
    db: database as unknown as HaruDatabase,
    close: async () => {
      await pool.end();
      const cleanup = new pg.Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
      await cleanup.end();
    },
  };
}

/**
 * Isolated test database with the committed migrations applied,
 * running the exact SQL the production Neon database runs.
 *
 * Default: in-memory PGlite (no external services). When
 * HARU_TEST_DATABASE_URL is set (the CI integration lane), a real
 * Postgres database is created per call instead.
 *
 * Note: this subpath is for tests inside this workspace only; PGlite
 * and pg are devDependencies of @haru/db.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = process.env.HARU_TEST_DATABASE_URL;
  if (adminUrl !== undefined && adminUrl !== "") {
    return createPostgresTestDatabase(adminUrl);
  }
  return createPgliteTestDatabase();
}

/**
 * The bundled generic example fleet layout, shared by the db test
 * suites and anything else that needs a valid two-domain layout.
 * Returns a fresh object per call (tests mutate it).
 */
export function loadExampleFleetLayout(): unknown {
  const examplePath = fileURLToPath(
    new URL("../../examples/fleet.example.json", import.meta.url),
  );
  return JSON.parse(readFileSync(examplePath, "utf8"));
}
