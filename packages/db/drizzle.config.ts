import { defineConfig } from "drizzle-kit";

// Load the repo-root .env when present (local dev). Ignore a missing
// file: CI and drizzle-kit generate need no DATABASE_URL.
try {
  process.loadEnvFile("../../.env");
} catch {
  // No .env file; rely on the process environment.
}

export default defineConfig({
  out: "./drizzle",
  schema: "./src/schema/index.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
