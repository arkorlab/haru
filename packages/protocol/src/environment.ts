import { z } from "zod";

/**
 * Environment-variable parsing helpers shared by both services' boot
 * schemas. They exist because an env var is either absent (`undefined`)
 * or a string, and a *present-but-blank* string (empty or
 * whitespace-only, e.g. an unexpanded `${VAR}` left by a manifest
 * templating step) must be treated as unset rather than as data - which
 * neither zod's `.optional()`/`.default()` nor `z.coerce.number()` do on
 * their own.
 */

/**
 * An optional string env var where a blank value reads as unset, and a
 * non-blank value is trimmed. Trimming matters for secrets too: a
 * trailing newline from a secret file must resolve to the same
 * credential a `\S+` bearer capture presents, and a whitespace-only
 * token must not count as "set" (it would open a public bind while being
 * unmatchable).
 */
export const blankableString = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed === "" ? undefined : trimmed;
  });

/**
 * Wrap a numeric env schema so a present-but-blank value is treated as
 * unset. Without it, `z.coerce.number()` coerces `""` to 0, which then
 * fails a `.positive()` / `.min()` bound and crashes boot with a
 * confusing "must be greater than 0" instead of falling back to the
 * field's default (or staying optional).
 */
export function blankableNumber<Schema extends z.ZodType>(schema: Schema) {
  return z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? undefined : value,
    schema,
  );
}
