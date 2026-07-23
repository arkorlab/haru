import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Publishability gate. AGENTS.md requires this repo carry no specific
 * model or GPU names in code, seeds, or example layouts (workloads are
 * pure data). That rule was enforced by human review only; this scans
 * the source + example layouts for a denylist so a leak fails CI.
 *
 * Deliberately NOT flagged: `nvidia-smi` (a required CLI tool name, not
 * a GPU-model leak) and `vLLM` (the inference engine, referenced
 * throughout by design). The private-repo/infra half of the rule stays
 * human-reviewed: the only org name in the tree is the repo's own
 * publisher (Arkor, in LICENSE/CONTRIBUTING), so a mechanical org
 * denylist would flag legitimate ownership references.
 */
const DENYLIST: readonly {
  readonly label: string;
  readonly pattern: RegExp;
}[] = [
  {
    label: "specific GPU model name",
    pattern:
      /\b(?:H100|H200|H800|A100|A800|A6000|A40|V100|L40S|L40|GH200|GB200|MI\d{2,3}X?|RTX ?\d{3,4})\b/i,
  },
  {
    label: "specific LLM model family",
    pattern:
      /\b(?:code)?llama\b|\bmi[sx]tral\b|\bqwen\b|\bgemma\b|\bdeepseek\b|\bvicuna\b|\bstarcoder\b|\b(?:gpt|phi)-\d/i,
  },
];

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCAN_ROOTS = ["packages", "services"];
const SKIP_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".turbo",
  "drizzle",
]);
// The scanner file names the very tokens it bans; excluding it keeps the
// gate from flagging itself.
const SELF = "publishability.test.ts";

function scannableFiles(directory: string): string[] {
  const found: string[] = [];
  const entries = readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) {
        found.push(...scannableFiles(path));
      }
      continue;
    }
    if (entry.name === SELF) {
      continue;
    }
    const isSource = entry.name.endsWith(".ts");
    // Only example/layout JSON is data we ship; package.json/tsconfig
    // are not workload layouts.
    const isExampleData =
      entry.name.endsWith(".json") && path.includes("/examples/");
    if (isSource || isExampleData) {
      found.push(path);
    }
  }
  return found;
}

describe("publishability", () => {
  it("carries no specific GPU or LLM model names in code or layouts", () => {
    const violations: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of scannableFiles(`${REPO_ROOT}${root}`)) {
        const lines = readFileSync(file, "utf8").split("\n");
        for (const [index, line] of lines.entries()) {
          for (const { label, pattern } of DENYLIST) {
            const match = pattern.exec(line);
            if (match) {
              const relative = file.slice(REPO_ROOT.length);
              violations.push(
                `${relative}:${String(index + 1)} ${label}: "${match[0]}"`,
              );
            }
          }
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });
});
