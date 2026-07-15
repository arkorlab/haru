/**
 * Regenerate the bundled JSON Schemas for the operator-authored config
 * files (fleet layout, supervisor config) from their zod schemas - the
 * single source of truth. Operators point a `$schema` key at these so an
 * editor can validate / autocomplete their config.
 *
 * Runs on plain node (no tsx dependency) by importing the BUILT helpers
 * from dist, so `pnpm build` must run first - the `schemas:generate`
 * script does that. The committed output is drift-checked by
 * `json-schema.test.ts` (and in CI).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  configSchemasByFile,
  serializeJsonSchema,
} from "../dist/json-schema.js";

const schemasDirectory = fileURLToPath(new URL("../schemas/", import.meta.url));
mkdirSync(schemasDirectory, { recursive: true });

for (const [file, schema] of Object.entries(configSchemasByFile)) {
  writeFileSync(`${schemasDirectory}${file}`, serializeJsonSchema(schema));
  console.log(`wrote schemas/${file}`);
}
