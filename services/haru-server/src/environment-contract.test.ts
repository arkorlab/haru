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
 *
 * The parser takes README TEXT (I/O stays at the test boundary) so its
 * section-walking can be exercised with inline fixtures below.
 */
function readReadme(): string {
  return readFileSync(
    fileURLToPath(new URL("../../../README.md", import.meta.url)),
    "utf8",
  );
}

function documentedServerVariables(markdown: string): Set<string> {
  const lines = markdown.split("\n");
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
  let isEnded = false;
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
      isEnded = true;
      break;
    }
    // First table cell of a data row: | `VARIABLE_NAME` | ... |
    const name = /^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|/.exec(line)?.[1];
    if (name !== undefined) {
      documented.add(name);
    }
  }
  // An unbalanced fence would silently swallow the rest of the section
  // (and the heading that ends it), under-reporting the documented vars
  // as a confusing "undocumented var" diff. Name the real cause instead.
  if (isInFence) {
    throw new Error(
      "README 'haru-server environment' section has an unterminated code fence",
    );
  }
  // Reaching EOF is fine only if the section really is last; today it is
  // not, so a missing terminator means the walk overran.
  if (!isEnded && documented.size === 0) {
    throw new Error(
      "README 'haru-server environment' section documented no variables",
    );
  }
  return documented;
}

describe("haru-server environment docs", () => {
  it("documents exactly the vars serverEnvironmentSchema reads", () => {
    const documented = documentedServerVariables(readReadme());
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

  it("walks only the section, ignoring sub-notes and fenced samples", () => {
    const markdown = [
      "### haru-server environment",
      "",
      "| `DATABASE_URL` | conn |",
      "#### A sub-note (still inside the section)",
      "| `PORT` | port |",
      "```sh",
      "# a fenced shell comment, not a heading",
      "| `FENCED_NOT_A_VAR` | ignored |",
      "```",
      "| `HARU_API_TOKEN` | token |",
      "### Consumer contract (ends the section)",
      "| `AFTER_SECTION` | ignored |",
    ].join("\n");
    expect([...documentedServerVariables(markdown)]).toEqual([
      "DATABASE_URL",
      "PORT",
      "HARU_API_TOKEN",
    ]);
  });

  it("ends the section at a higher-level heading too", () => {
    // `## ` and `# ` terminate the section just like `### `; only `####`
    // (deeper) stays inside it.
    const markdown = [
      "### haru-server environment",
      "| `DATABASE_URL` | conn |",
      "## Some parent section",
      "| `AFTER_SECTION` | ignored |",
    ].join("\n");
    expect([...documentedServerVariables(markdown)]).toEqual(["DATABASE_URL"]);
  });

  it("names an unterminated code fence instead of under-reporting", () => {
    // An odd number of fences would otherwise swallow the rest of the
    // section AND its terminating heading, surfacing as a baffling
    // "undocumented env var" diff rather than the markdown typo it is.
    const markdown = [
      "### haru-server environment",
      "| `DATABASE_URL` | conn |",
      "```sh",
      "echo unterminated",
      "### Consumer contract",
    ].join("\n");
    expect(() => documentedServerVariables(markdown)).toThrow(
      /unterminated code fence/,
    );
  });

  it("throws when the section heading is absent", () => {
    expect(() => documentedServerVariables("# Something else\n")).toThrow(
      /haru-server environment/,
    );
  });
});
