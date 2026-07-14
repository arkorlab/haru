import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { configSchemasByFile, toConfigJsonSchema } from "./json-schema.js";

describe("bundled config JSON Schemas", () => {
  for (const [file, schema] of Object.entries(configSchemasByFile)) {
    it(`schemas/${file} is committed in sync with its zod schema`, () => {
      const path = fileURLToPath(
        new URL(`../schemas/${file}`, import.meta.url),
      );
      const committed: unknown = JSON.parse(readFileSync(path, "utf8"));
      // Content, not formatting (oxfmt owns the file's whitespace). If
      // this fails, a config schema changed: run `pnpm schemas:generate`.
      expect(committed).toEqual(toConfigJsonSchema(schema));
    });
  }
});
