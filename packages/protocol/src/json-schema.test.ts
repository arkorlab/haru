import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  configSchemasByFile,
  serializeJsonSchema,
  toConfigJsonSchema,
} from "./json-schema.js";
import { MAX_PROBE_PROMPT_CODE_POINTS, probePromptSchema } from "./policy.js";

type JsonNode = Record<string, unknown>;

/** Every JSON Schema node that declares `properties`, reachable anywhere
 * in the tree (through properties, items, oneOf/anyOf, ...). */
function objectNodes(node: unknown): JsonNode[] {
  if (node === null || typeof node !== "object") {
    return [];
  }
  const record = node as JsonNode;
  const found: JsonNode[] = [];
  if (typeof record.properties === "object" && record.properties !== null) {
    found.push(record);
  }
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        found.push(...objectNodes(item));
      }
    } else {
      found.push(...objectNodes(value));
    }
  }
  return found;
}

describe("bundled config JSON Schemas", () => {
  for (const [file, schema] of Object.entries(configSchemasByFile)) {
    it(`schemas/${file} is committed byte-for-byte in sync with its zod schema`, () => {
      const path = fileURLToPath(
        new URL(`../schemas/${file}`, import.meta.url),
      );
      const committed = readFileSync(path, "utf8");
      // oxfmt ignores schemas/, so the committed bytes ARE the generator's.
      // Regenerate with `pnpm schemas:generate` if this fails.
      expect(committed).toBe(serializeJsonSchema(schema));
    });

    it(`schemas/${file} keeps defaulted (optional) fields out of "required"`, () => {
      // io:"input" mode: a field with a zod .default() is OPTIONAL for the
      // author, so it must never be marked required - otherwise an editor
      // flags a valid config (incl. the shipped example) that omits it.
      const nodes = objectNodes(toConfigJsonSchema(schema));
      for (const node of nodes) {
        const properties = node.properties as Record<string, JsonNode>;
        const required = Array.isArray(node.required) ? node.required : [];
        const defaultedButRequired = required.filter(
          (key: unknown) =>
            typeof key === "string" && properties[key]?.default !== undefined,
        );
        expect(defaultedButRequired).toEqual([]);
      }
    });
  }

  it("uses the same Unicode code-point prompt limit at runtime and in JSON Schema", () => {
    expect(
      probePromptSchema.safeParse("😀".repeat(MAX_PROBE_PROMPT_CODE_POINTS))
        .success,
    ).toBe(true);
    expect(
      probePromptSchema.safeParse("😀".repeat(MAX_PROBE_PROMPT_CODE_POINTS + 1))
        .success,
    ).toBe(false);

    const fleetLayout = configSchemasByFile["fleet-layout.schema.json"];
    if (!fleetLayout) throw new Error("fleet layout schema missing");
    const promptSchemas = objectNodes(toConfigJsonSchema(fleetLayout))
      .map((node) => node.properties as Record<string, JsonNode>)
      .map((properties) => properties.prompt)
      .filter((schema) => schema !== undefined);
    expect(promptSchemas).not.toHaveLength(0);
    expect(
      promptSchemas.every(
        (schema) => schema.maxLength === MAX_PROBE_PROMPT_CODE_POINTS,
      ),
    ).toBe(true);
  });
});
