import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Publishability gate. AGENTS.md requires this repo carry no specific
 * model or GPU names in code, seeds, or example layouts (workloads are
 * pure data). That rule was enforced by human review only; this scans
 * the source + shipped data for a denylist so a leak fails CI.
 *
 * The forbidden identifiers live in `publishability-denylist.txt`, a
 * governed policy DATA file - NOT a scanned source file - so no specific
 * model or GPU name is embedded in this (or any) code the gate governs.
 * The denylists are necessarily heuristic (a gate, not a proof) but cover
 * the current-generation datacenter accelerators and common open-weight
 * model families, so the obvious leaks fail loudly.
 *
 * Deliberately NOT flagged: `nvidia-smi` (a required CLI tool name) and
 * `vLLM` (the inference engine). The private-repo/infra half of the rule
 * stays human-reviewed: the only org name in the tree is the repo's own
 * publisher (in LICENSE/CONTRIBUTING).
 */
const DENYLIST_PATH = fileURLToPath(
  new URL("publishability-denylist.txt", import.meta.url),
);

const DENYLIST: readonly {
  readonly label: string;
  readonly pattern: RegExp;
}[] = readFileSync(DENYLIST_PATH, "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "" && !line.startsWith("#"))
  .map((line) => {
    const tab = line.indexOf("\t");
    return {
      label: line.slice(0, tab),
      pattern: new RegExp(line.slice(tab + 1), "i"),
    };
  });

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCAN_ROOTS = ["packages", "services"];
const SKIP_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".turbo",
  "drizzle",
]);
// Every module extension the repo ships (nodenext ESM/CJS + the .mjs
// generator scripts), so the gate governs ALL code, not only .ts.
const SOURCE_EXTENSIONS = [".ts", ".mts", ".cts", ".mjs", ".cjs", ".js"];

function isScannable(name: string): boolean {
  if (SOURCE_EXTENSIONS.some((extension) => name.endsWith(extension))) {
    return true;
  }
  // Shipped data (layouts, seeds, generated schemas), but not the
  // build/config JSON, which carries no workload data.
  return (
    name.endsWith(".json") &&
    name !== "package.json" &&
    !name.startsWith("tsconfig")
  );
}

function scannableFiles(directory: string): string[] {
  const found: string[] = [];
  const entries = readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) {
        found.push(...scannableFiles(path));
      }
    } else if (isScannable(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

function violationsInFile(file: string): string[] {
  const content = readFileSync(file, "utf8");
  // Fast path: almost every file matches nothing, so test the whole file
  // once and only walk lines (to name the offending line) on a real hit.
  // Patterns carry no `g` flag, so `.test` and `.exec` share no lastIndex.
  if (DENYLIST.every(({ pattern }) => !pattern.test(content))) {
    return [];
  }
  const relative = file.slice(REPO_ROOT.length);
  const found: string[] = [];
  for (const [index, line] of content.split("\n").entries()) {
    // Escape hatch: a line with a legitimate token that collides with a
    // denylist word opts out with a `publishability-allow` marker. None
    // exist today.
    if (line.includes("publishability-allow")) {
      continue;
    }
    for (const { label, pattern } of DENYLIST) {
      const match = pattern.exec(line);
      if (match) {
        found.push(`${relative}:${String(index + 1)} ${label}: "${match[0]}"`);
      }
    }
  }
  return found;
}

describe("publishability", () => {
  it("carries no specific GPU or LLM model names in code or layouts", () => {
    const violations = SCAN_ROOTS.flatMap((root) =>
      scannableFiles(`${REPO_ROOT}${root}`).flatMap((file) =>
        violationsInFile(file),
      ),
    );
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("scans the governed roots and its matcher is non-vacuous (positive control)", () => {
    // A green `toEqual([])` above must mean "no leaks", not "scanned
    // nothing" or "the matcher is vacuous". Prove coverage with explicit
    // sentinels - representative governed files that MUST be scanned,
    // spanning both roots and every kind (.ts, .mjs, .json data) - so a
    // REPO_ROOT / isScannable regression cannot silently scan nothing.
    const scanned = new Set(
      SCAN_ROOTS.flatMap((root) => scannableFiles(`${REPO_ROOT}${root}`)),
    );
    for (const relative of [
      "packages/db/src/seed.ts",
      "packages/protocol/scripts/generate-schemas.mjs",
      "services/haru-server/src/environment.ts",
      "packages/db/examples/fleet.example.json",
      "packages/protocol/schemas/fleet-layout.schema.json",
    ]) {
      expect(
        scanned.has(`${REPO_ROOT}${relative}`),
        `scanner must cover ${relative}`,
      ).toBe(true);
    }
    // The policy file itself is intentionally NOT scanned (it is the one
    // governed home for the names) yet the matcher must be non-vacuous:
    // every pattern matches the tokens on its own policy line.
    expect(scanned.has(DENYLIST_PATH)).toBe(false);
    const policy = readFileSync(DENYLIST_PATH, "utf8");
    for (const { label, pattern } of DENYLIST) {
      expect(
        pattern.test(policy),
        `${label} pattern must match its own policy line`,
      ).toBe(true);
    }
  });
});
