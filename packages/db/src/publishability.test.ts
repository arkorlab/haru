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

interface DenylistRule {
  readonly label: string;
  readonly pattern: RegExp;
}

/**
 * Parse the policy text into rules. Pure (text in, rules out) so the
 * malformed-input handling below is testable without filesystem I/O.
 *
 * Every failure mode here THROWS rather than dropping a rule: a policy
 * file that silently parses to fewer (or zero) rules would leave the gate
 * green while enforcing nothing, which is the one outcome a guardrail
 * must never have. The `\r` strip matters for the same reason - on a CRLF
 * checkout the carriage return would otherwise land inside every pattern
 * and make each rule match nothing.
 */
function parseDenylist(text: string): readonly DenylistRule[] {
  const rules: DenylistRule[] = [];
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "" || line.startsWith("#")) {
      continue;
    }
    const where = `publishability denylist line ${String(index + 1)}`;
    const tab = line.indexOf("\t");
    if (tab === -1) {
      throw new Error(
        `${where} has no TAB separator (expected ${String.raw`"label\tregex"`})`,
      );
    }
    const source = line.slice(tab + 1);
    if (source === "") {
      throw new Error(`${where} has an empty pattern`);
    }
    const label = line.slice(0, tab).trim();
    // An empty label would make the per-rule coverage check below match
    // anything, so a dead pattern could still look covered.
    if (label === "") {
      throw new Error(`${where} has an empty label`);
    }
    rules.push({ label, pattern: new RegExp(source, "i") });
  }
  if (rules.length === 0) {
    throw new Error("publishability denylist parsed to zero rules");
  }
  return rules;
}

const DENYLIST = parseDenylist(readFileSync(DENYLIST_PATH, "utf8"));

const SAMPLES_PATH = fileURLToPath(
  new URL("publishability-samples.txt", import.meta.url),
);

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
// Governed trees, scanned recursively. Root-level files (README, AGENTS,
// KNOWN_ISSUES, configs) are added separately, non-recursively, so the
// walk never descends into the workspace root's node_modules or .git.
const SCAN_ROOTS = ["packages", "services", ".github"];
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
// Prose and workflow files: AGENTS.md scopes model/GPU names to code,
// seeds and layouts, but the surrounding publishability rule also covers
// comments and docs, so they are governed too.
const DOCUMENT_EXTENSIONS = [".md", ".yaml", ".yml"];

/**
 * Which files the gate reads. Deliberate exclusions, asserted below:
 * `package.json`/`tsconfig*.json` (build config, no workload data) and
 * `.txt` (the governed home for the policy and its samples - scanning
 * them would flag the policy by its own rules). Everything else with a
 * governed extension is in scope.
 */
function isScannable(name: string): boolean {
  if (
    [...SOURCE_EXTENSIONS, ...DOCUMENT_EXTENSIONS].some((extension) =>
      name.endsWith(extension),
    )
  ) {
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

/** Every governed file: the scan roots plus the root-level files. */
function governedFiles(): string[] {
  const rootLevel = readdirSync(REPO_ROOT, { withFileTypes: true })
    .filter((entry) => !entry.isDirectory() && isScannable(entry.name))
    .map((entry) => `${REPO_ROOT}${entry.name}`);
  return [
    ...SCAN_ROOTS.flatMap((root) => scannableFiles(`${REPO_ROOT}${root}`)),
    ...rootLevel,
  ];
}

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly label: string;
  readonly match: string;
}

function formatViolation({ file, line, label, match }: Violation): string {
  return `${file}:${String(line)} ${label}: "${match}"`;
}

/**
 * Pure matcher (relative path + content in, violations out), so the
 * per-token coverage test below can exercise the real detection logic
 * without writing fixture files to disk. Returns STRUCTURED violations:
 * the coverage check compares labels exactly, which a formatted string
 * could not (a substring or empty label would match anything).
 */
function violationsInText(relative: string, content: string): Violation[] {
  // Fast path: almost every file matches nothing, so test the whole file
  // once and only walk lines (to name the offending line) on a real hit.
  // Patterns carry no `g` flag, so `.test` and `.exec` share no lastIndex.
  if (DENYLIST.every(({ pattern }) => !pattern.test(content))) {
    return [];
  }
  const found: Violation[] = [];
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
        found.push({
          file: relative,
          line: index + 1,
          label,
          match: match[0],
        });
      }
    }
  }
  return found;
}

function violationsInFile(file: string): Violation[] {
  return violationsInText(
    file.slice(REPO_ROOT.length),
    readFileSync(file, "utf8"),
  );
}

/** The identifiers the gate must detect, one per line (governed data). */
function parseSamples(text: string): readonly string[] {
  const samples = text
    .split("\n")
    .map((line) => line.replace(/\r$/, "").trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  if (samples.length === 0) {
    throw new Error("publishability samples parsed to zero entries");
  }
  return samples;
}

describe("publishability", () => {
  it("carries no specific GPU or LLM model names in code or layouts", () => {
    const violations = governedFiles().flatMap((file) =>
      violationsInFile(file),
    );
    const report = violations
      .map((violation) => formatViolation(violation))
      .join("\n");
    expect(violations, report).toEqual([]);
  });

  it("scans the governed roots and its matcher is non-vacuous (positive control)", () => {
    // A green `toEqual([])` above must mean "no leaks", not "scanned
    // nothing" or "the matcher is vacuous". Prove coverage with explicit
    // sentinels - representative governed files that MUST be scanned,
    // spanning every root and kind (.ts, .mjs, .json data, root-level and
    // .github prose) - so a REPO_ROOT / isScannable regression cannot
    // silently scan nothing.
    const scanned = new Set(governedFiles());
    for (const relative of [
      "packages/db/src/seed.ts",
      "packages/protocol/scripts/generate-schemas.mjs",
      "services/haru-server/src/environment.ts",
      "packages/db/examples/fleet.example.json",
      "packages/protocol/schemas/fleet-layout.schema.json",
      "AGENTS.md",
      "README.md",
      ".github/workflows/ci.yaml",
    ]) {
      expect(
        scanned.has(`${REPO_ROOT}${relative}`),
        `scanner must cover ${relative}`,
      ).toBe(true);
    }
    // The policy file itself is intentionally NOT scanned (it is the one
    // governed home for the names).
    expect(scanned.has(DENYLIST_PATH)).toBe(false);
    // ...which makes it the perfect end-to-end probe: it CONTAINS the very
    // tokens, so running the REAL pipeline (readFileSync -> whole-file fast
    // path -> allow-marker skip -> per-line matcher -> report) over it must
    // produce a hit for every rule. Asserting through `violationsInFile`,
    // not the raw regexes, is what fails if the scanner itself regresses.
    const detected = violationsInFile(DENYLIST_PATH);
    expect(detected.length).toBeGreaterThan(0);
    const reported = new Set(detected.map((violation) => violation.label));
    for (const { label } of DENYLIST) {
      // Exact label equality, not a substring test: a label that is a
      // substring of another rule's could otherwise ride on that rule's
      // hits and look covered while its own pattern is dead.
      expect(
        reported.has(label),
        `${label} must be reported through the scan pipeline`,
      ).toBe(true);
    }
  });

  it("rejects a malformed policy file instead of silently disabling itself", () => {
    // Each of these once produced a SILENTLY weaker gate: no rules at all,
    // or a rule whose pattern is dead (the whole line compiled as the
    // regex, or a \r glued onto it) yet still self-consistent enough to
    // look fine. They must throw instead.
    expect(() => parseDenylist("# comments only\n")).toThrow(/zero rules/);
    expect(() => parseDenylist("")).toThrow(/zero rules/);
    expect(() => parseDenylist("label with spaces not a tab\n")).toThrow(/TAB/);
    expect(() => parseDenylist("label\t\n")).toThrow(/empty pattern/);
    // An empty label would make the per-rule coverage check vacuous
    // (every violation string "contains" it), hiding a dead pattern.
    expect(() => parseDenylist("\t\\bTEST-ACCEL\\b\n")).toThrow(/empty label/);
    expect(() => parseDenylist("   \t\\bTEST-ACCEL\\b\n")).toThrow(
      /empty label/,
    );
    // A CRLF checkout must still yield a WORKING pattern, not one with a
    // trailing carriage return that can never match real source.
    const [rule] = parseDenylist("gpu\t\\bTEST-ACCEL\\b\r\n");
    expect(rule?.pattern.test('const a = "TEST-ACCEL";')).toBe(true);
  });

  it("detects every sampled identifier (per-token coverage)", () => {
    // The rules are large alternations, so "the pattern matches the policy
    // text" stays true even when individual alternatives are deleted. Each
    // sample pins ONE branch: delete a branch from a rule and its sample
    // stops being detected here, where the per-rule check above would not
    // notice. (No identifier is named in this comment on purpose - the two
    // .txt data files are the only sanctioned home for them.)
    const samples = parseSamples(readFileSync(SAMPLES_PATH, "utf8"));
    // EXACT count, not a floor: a floor lets branches be deleted in pairs
    // (the branch AND its sample) until it is reached, which is precisely
    // the silent weakening the samples exist to prevent. Adding a branch
    // means adding a sample and bumping this number, all in one visible
    // diff.
    expect(samples.length).toBe(41);
    const undetected = samples.filter(
      (sample) =>
        violationsInText("<sample>", `const value = "${sample}";`).length === 0,
    );
    expect(
      undetected,
      `samples the gate no longer detects: ${String(undetected)}`,
    ).toEqual([]);
    // The samples file is governed data, never itself scanned.
    expect(new Set(governedFiles()).has(SAMPLES_PATH)).toBe(false);
    expect(() => parseSamples("# nothing\n")).toThrow(/zero entries/);
  });

  it("covers the governed extensions and documents its exclusions", () => {
    // The extension list is otherwise aspirational: only .ts and one .mjs
    // exist today, so nothing would notice if .cjs/.mts fell out.
    for (const name of [
      "a.ts",
      "a.mts",
      "a.cts",
      "a.mjs",
      "a.cjs",
      "a.js",
      "a.md",
      "a.yaml",
      "a.yml",
      "fleet.example.json",
    ]) {
      expect(isScannable(name), `${name} must be scanned`).toBe(true);
    }
    // Deliberate exclusions: build config carries no workload data, and
    // .txt is the sanctioned home for the policy and its samples.
    for (const name of [
      "package.json",
      "tsconfig.json",
      "tsconfig.build.json",
      "publishability-denylist.txt",
      "publishability-samples.txt",
      "pnpm-lock.yaml.license",
    ]) {
      expect(isScannable(name), `${name} must be excluded`).toBe(false);
    }
  });
});
