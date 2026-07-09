import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

import * as schema from "./schema/index.js";

import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

/**
 * Driver-agnostic database handle. Production uses the Neon HTTP
 * driver; tests use PGlite. Both drivers satisfy this type, which is
 * why the repository layer sticks to single-statement queries: the
 * Neon HTTP transport has no interactive transactions, so every state
 * transition is a compare-and-swap UPDATE that behaves identically on
 * both drivers.
 */
export type HaruDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

/** Create a Neon-backed database handle (the documented production target). */
export function createDatabase(databaseUrl: string): HaruDatabase {
  const sql = neon(databaseUrl);
  return drizzle({ client: sql, schema });
}
