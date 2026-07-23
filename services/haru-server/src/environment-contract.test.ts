import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { serverEnvironmentSchema } from "./environment.js";

/**
 * Drift gate for the README's documented env-var contract. The JSON
 * Schemas and the drizzle migrations are already drift-checked in CI;
 * the prose "haru-server environment" table was not, so a var added to
 * or removed from `serverEnvironmentSchema` could silently desync from
 * the docs. This asserts the table's variable names match the schema
 * keys exactly, in both directions. (Defaults/prose are intentionally
 * not asserted - they change wording too often to gate mechanically.)
 */
function documentedServerVariables(): Set<string> {
  const readmePath = fileURLToPath(
    new URL("../../../README.md", import.meta.url),
  );
  const readme = readFileSync(readmePath, "utf8");
  const lines = readme.split("\n");
  const start = lines.findIndex((line) =>
    line.startsWith("### haru-server environment"),
  );
  if (start === -1) {
    throw new Error("README is missing the 'haru-server environment' section");
  }
  const documented = new Set<string>();
  // Walk to the end of THIS section: the next same-or-higher-level heading
  // (`# `/`## `/`### `). A `####` sub-note stays inside the section, and a
  // `#`-prefixed line inside a fenced code block (e.g. a shell comment) is
  // not a heading at all, so track fence state and ignore it.
  let isInFence = false;
  const body = lines.slice(start + 1);
  for (const line of body) {
    if (line.startsWith("```")) {
      isInFence = !isInFence;
      continue;
    }
    // Everything inside a fenced code block is a sample, not section
    // structure: a `#`-comment there is not a heading AND a pipe-shaped
    // line there is not a documented-var row, so skip the whole line.
    if (isInFence) {
      continue;
    }
    if (/^#{1,3} /.test(line)) {
      break;
    }
    // First table cell of a data row: | `VARIABLE_NAME` | ... |
    const name = /^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|/.exec(line)?.[1];
    if (name !== undefined) {
      documented.add(name);
    }
  }
  return documented;
}

describe("haru-server environment docs", () => {
  it("documents exactly the vars serverEnvironmentSchema reads", () => {
    const documented = documentedServerVariables();
    const inSchema = new Set(Object.keys(serverEnvironmentSchema.shape));

    const undocumented = [...inSchema.difference(documented)];
    const stale = [...documented.difference(inSchema)];

    expect(
      undocumented,
      "env vars in serverEnvironmentSchema but missing from the README table",
    ).toEqual([]);
    expect(
      stale,
      "env vars in the README table but not read by serverEnvironmentSchema",
    ).toEqual([]);
  });
});
