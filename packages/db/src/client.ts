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
 *
 * `transaction` is OMITTED on purpose: `db.transaction()` typechecks on
 * a raw drizzle handle, works on PGlite AND real Postgres in tests, and
 * throws at runtime ONLY on Neon HTTP - which nothing in CI exercises.
 * Removing it from the handle turns any interactive-transaction attempt
 * into a compile error with no runtime surprise. (The full drizzle
 * instance is still assignable here: it is a supertype.)
 */
export type HaruDatabase = Omit<
  PgDatabase<PgQueryResultHKT, typeof schema>,
  "transaction"
>;

/** Create a Neon-backed database handle (the documented production target). */
export function createDatabase(databaseUrl: string): HaruDatabase {
  const sql = neon(databaseUrl);
  return drizzle({ client: sql, schema });
}
