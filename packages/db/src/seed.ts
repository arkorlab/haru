import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
  return fileURLToPath(
    new URL("../examples/fleet.example.json", import.meta.url),
  );
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
  if (!result.createdFleet) {
    console.log(
      "  note: the fleet already existed; layout policy/displayName changes are NOT applied to existing rows",
    );
  }
  for (const domain of result.domains) {
    console.log(`  ${domain.slug}: ${domain.id}`);
  }
}

try {
  process.loadEnvFile("../../.env");
} catch {
  // No .env file; rely on the process environment.
}

try {
  await main();
} catch (error) {
  // A missing/invalid layout file (readFileSync/JSON.parse) or a schema
  // validation failure (applyFleetLayout) should exit like the
  // DATABASE_URL guard - a clean one-line message, not a raw stack trace.
  // Collapse embedded newlines (multi-issue Zod / JSON.parse errors carry
  // them) so the output stays a single line.
  const message = error instanceof Error ? error.message : String(error);
  console.error(`seed failed: ${message.replaceAll(/[\r\n]+/g, " ")}`);
  process.exit(1);
}
