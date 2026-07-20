import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PGlite boot + migration replay in beforeEach can exceed the
    // default hook timeout when every suite runs in parallel under
    // turbo; these bounds keep the full-workspace run deterministic.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Each file gets its own PGlite seed database. Letting Vitest use
    // every CPU here competes with the server package's PGlite workers
    // under Turbo and can push otherwise healthy setup hooks past 30s.
    maxWorkers: 2,
    reporters: ["default", "junit"],
    outputFile: {
      junit: "./coverage/junit.xml",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts"],
    },
  },
});
