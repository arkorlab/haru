import { z } from "zod";

import { fleetLayoutSchema } from "./layout.js";
import { MAX_PROBE_PROMPT_CODE_POINTS, probePromptSchema } from "./policy.js";
import { supervisorConfigSchema } from "./supervisor.js";

/**
 * The operator-authored config schemas, keyed by the basename of the
 * bundled JSON Schema file that describes them. `scripts/generate-
 * schemas.mjs` writes these files; `json-schema.test.ts` drift-checks the
 * committed output against a fresh conversion so the two never diverge.
 */
export const configSchemasByFile: Record<string, z.ZodType> = {
  "fleet-layout.schema.json": fleetLayoutSchema,
  "supervisor-config.schema.json": supervisorConfigSchema,
};

/**
 * Convert one operator-config schema to a JSON Schema with haru's fixed
 * options, so the generator and the drift test always agree.
 *
 * `io: "input"` is essential: these schemas validate the config an
 * operator AUTHORS, where a field with a `.default()` (provider,
 * useSpot, sleepLevel, ...) is OPTIONAL. The default "output" mode
 * describes the PARSED value, where every defaulted field is always
 * present and thus `required` - which would make an editor wrongly flag
 * a valid layout that omits a default (including the shipped example).
 *
 * `unrepresentable: "any"` degrades the cross-field refinements JSON
 * Schema cannot express (dup-slug, dup-(gpuIndex,kind), unique model
 * names) to an unconstrained node rather than throwing - the structural
 * shape is what an editor needs; the loader still enforces the rest.
 */
export function toConfigJsonSchema(schema: z.ZodType): unknown {
  return z.toJSONSchema(schema, {
    io: "input",
    unrepresentable: "any",
    // probePromptSchema uses a custom runtime refinement because
    // JavaScript string.length counts UTF-16 code units while JSON
    // Schema maxLength counts Unicode code points. Preserve the
    // representable standard keyword on every reuse of this exact
    // schema (fleet policy and supervisor probe request).
    override: ({ zodSchema, jsonSchema }) => {
      if (zodSchema === probePromptSchema) {
        jsonSchema.maxLength = MAX_PROBE_PROMPT_CODE_POINTS;
      }
    },
  });
}

/** Byte-exact serialization the generator writes and the test asserts. */
export function serializeJsonSchema(schema: z.ZodType): string {
  return `${JSON.stringify(toConfigJsonSchema(schema), null, 2)}\n`;
}
