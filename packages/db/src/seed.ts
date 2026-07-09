import { readFileSync } from "node:fs";

import { createDatabase } from "./client.js";
import { applyFleetLayout } from "./repo/layout.js";

/**
 * Seed a fleet from a declarative layout file.
 *
 * Usage: pnpm db:seed [-- --config path/to/fleet.json]
 * The layout path can also be set via HARU_FLEET_LAYOUT. With neither,
 * the bundled generic example layout is used.
 */
function layoutPath(): string {
  const argumentIndex = process.argv.indexOf("--config");
  const fromArgument =
    argumentIndex === -1 ? undefined : process.argv[argumentIndex + 1];
  if (fromArgument !== undefined && fromArgument !== "") {
    return fromArgument;
  }
  const fromEnvironment = process.env.HARU_FLEET_LAYOUT;
  if (fromEnvironment !== undefined && fromEnvironment !== "") {
    return fromEnvironment;
  }
  return new URL("../examples/fleet.example.json", import.meta.url).pathname;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === "") {
    console.error("DATABASE_URL is required to seed");
    process.exit(1);
  }
  const path = layoutPath();
  const layout: unknown = JSON.parse(readFileSync(path, "utf8"));
  const database = createDatabase(databaseUrl);
  const result = await applyFleetLayout(database, layout);
  console.log(
    `seeded fleet ${result.fleetId} (${result.createdFleet ? "created" : "existing"}) with domains:`,
  );
  for (const domain of result.domains) {
    console.log(`  ${domain.slug}: ${domain.id}`);
  }
}

try {
  process.loadEnvFile("../../.env");
} catch {
  // No .env file; rely on the process environment.
}
await main();
