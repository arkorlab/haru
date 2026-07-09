import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import * as schema from "../schema/index.js";

import type { HaruDatabase } from "../client.js";

/**
 * In-memory Postgres (PGlite) database with the committed migrations
 * applied. This runs the exact SQL the production Neon database runs,
 * so compare-and-swap repository tests exercise real statements.
 *
 * Note: `@electric-sql/pglite` is a devDependency of @haru/db; this
 * subpath is for tests inside this workspace only.
 */
export async function createTestDatabase(): Promise<{
  db: HaruDatabase;
  close: () => Promise<void>;
}> {
  const client = new PGlite();
  const database = drizzle({ client, schema });
  const migrationsFolder = fileURLToPath(
    new URL("../../drizzle", import.meta.url),
  );
  await migrate(database, { migrationsFolder });
  return {
    db: database as unknown as HaruDatabase,
    close: () => client.close(),
  };
}
