/**
 * Format a seed failure for the CLI: one line, no stack trace, matching
 * the `DATABASE_URL is required to seed` guard's shape.
 *
 * Lives apart from `seed.ts` because that module is a script with a
 * top-level `await main()` - importing it to test the formatting would
 * run the seed. Collapsing ALL whitespace runs (not just line breaks)
 * matters: a multi-issue Zod message carries indented continuation
 * lines, so trimming only `\n` would leave wide gaps mid-sentence.
 */
export function formatSeedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const oneLine = message.replaceAll(/\s+/g, " ").trim();
  return `seed failed: ${oneLine}`;
}
