import { describe, expect, it } from "vitest";
import { z } from "zod";

import { formatSeedError } from "./seed-error.js";

describe("formatSeedError", () => {
  it("keeps a multi-issue validation error on one line", () => {
    // The realistic failure: a layout that violates several schema rules.
    // Zod's message is pretty-printed JSON, so it carries both newlines
    // AND indentation - the formatter must collapse the lot.
    const parsed = z
      .object({ slug: z.string(), domains: z.array(z.string()).min(1) })
      .safeParse({ slug: 7, domains: [] });
    expect(parsed.success).toBe(false);

    const formatted = formatSeedError(parsed.error);
    expect(formatted.startsWith("seed failed: ")).toBe(true);
    expect(formatted).not.toContain("\n");
    expect(formatted).not.toContain("  ");
  });

  it("collapses newlines from a plain Error", () => {
    expect(formatSeedError(new Error("line one\nline two\r\nline three"))).toBe(
      "seed failed: line one line two line three",
    );
  });

  it("handles a non-Error throw", () => {
    expect(formatSeedError("boom")).toBe("seed failed: boom");
    expect(formatSeedError(undefined)).toBe("seed failed: undefined");
  });
});
