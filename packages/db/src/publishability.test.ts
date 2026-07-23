import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Publishability gate. AGENTS.md requires this repo carry no specific
 * model or GPU names in code, seeds, or example layouts (workloads are
 * pure data). That rule was enforced by human review only; this scans
 * the source + shipped data (any layout/seed/schema JSON, not just the
 * bundled example) for a denylist so a leak fails CI.
 *
 * The denylists are necessarily heuristic - a gate, not a proof - but
 * they cover the current-generation datacenter accelerators and the
 * common open-weight model families, so the obvious leaks fail loudly.
 *
 * Deliberately NOT flagged: `nvidia-smi` (a required CLI tool name, not
 * a GPU-model leak) and `vLLM` (the inference engine, referenced
 * throughout by design). The private-repo/infra half of the rule stays
 * human-reviewed: the only org name in the tree is the repo's own
 * publisher (in LICENSE/CONTRIBUTING), so a mechanical org denylist
 * would flag legitimate ownership references.
 */
const DENYLIST: readonly {
  readonly label: string;
  readonly pattern: RegExp;
}[] = [
  {
    label: "specific GPU model name",
    // Hopper/Blackwell (H100/H200/H800, B100/B200/B300, GH200/GB200/GB300),
    // Ampere (A100/A800/A40/A6000), Volta (V100), Ada (L40/L40S), AMD
    // Instinct (MI250/MI300A/MI300X/MI325X), and RTX consumer cards. The
    // MI branch allows a trailing A (APU) or X (accelerator) suffix.
    pattern:
      /\b(?:H100|H200|H800|B100|B200|B300|A100|A800|A6000|A40|V100|L40S|L40|GH200|GB200|GB300|MI\d{2,3}[AX]?|RTX ?\d{3,4})\b/i,
  },
  {
    label: "specific LLM model family",
    // Common open-weight families and the numbered proprietary lines. `yi`
    // is matched only as `yi-<n>` to avoid tripping on the bare syllable.
    pattern:
      /\b(?:code)?llama\b|\bmi[sx]tral\b|\bqwen\b|\bgemma\b|\bdeepseek\b|\bvicuna\b|\bstarcoder\b|\bfalcon\b|\bnemotron\b|\bgranite\b|\binternlm\b|\bbaichuan\b|\bcommand-r\b|\bdbrx\b|\bwizardlm\b|\byi-\d|\b(?:gpt|phi)-\d/i,
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

function isScannable(name: string): boolean {
  if (name === SELF) {
    return false;
  }
  if (name.endsWith(".ts")) {
    return true;
  }
  // All shipped data (layouts, seeds, generated schemas) - but not the
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
});
