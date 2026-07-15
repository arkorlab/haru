import { describe, expect, it } from "vitest";

import { loadServerEnvironment } from "./environment.js";

describe("loadServerEnvironment", () => {
  const base = { DATABASE_URL: "postgres://localhost/haru" };

  it("treats a blank HARU_RECONCILE_FLEETS as unset (does not shadow the fallback)", () => {
    expect(
      loadServerEnvironment({ ...base, HARU_RECONCILE_FLEETS: "" })
        .HARU_RECONCILE_FLEETS,
    ).toBeUndefined();
    expect(
      loadServerEnvironment({ ...base, HARU_RECONCILE_FLEETS: " ".repeat(3) })
        .HARU_RECONCILE_FLEETS,
    ).toBeUndefined();
  });

  it("treats a blank HARU_DEFAULT_FLEET as unset", () => {
    expect(
      loadServerEnvironment({ ...base, HARU_DEFAULT_FLEET: "" })
        .HARU_DEFAULT_FLEET,
    ).toBeUndefined();
  });

  it("trims and keeps a configured value", () => {
    expect(
      loadServerEnvironment({ ...base, HARU_RECONCILE_FLEETS: " a, b " })
        .HARU_RECONCILE_FLEETS,
    ).toBe("a, b");
    expect(
      loadServerEnvironment({ ...base, HARU_DEFAULT_FLEET: "prod" })
        .HARU_DEFAULT_FLEET,
    ).toBe("prod");
  });

  it("treats a blank numeric var as unset instead of crashing on coerced 0", () => {
    // z.coerce.number() turns "" into 0, which fails .min(1)/.positive();
    // a blank var must fall back to the default (PORT) or stay optional.
    expect(loadServerEnvironment({ ...base, PORT: "" }).PORT).toBe(8700);
    expect(loadServerEnvironment({ ...base, PORT: " ".repeat(3) }).PORT).toBe(
      8700,
    );
    expect(
      loadServerEnvironment({ ...base, HARU_CHAT_HEADER_TIMEOUT_MS: "" })
        .HARU_CHAT_HEADER_TIMEOUT_MS,
    ).toBeUndefined();
    expect(
      loadServerEnvironment({
        ...base,
        HARU_CHAT_MAX_BODY_BYTES: " ".repeat(2),
      }).HARU_CHAT_MAX_BODY_BYTES,
    ).toBeUndefined();
  });

  it("still parses a real numeric value", () => {
    expect(loadServerEnvironment({ ...base, PORT: "9000" }).PORT).toBe(9000);
  });

  it("trims and blank-normalises the bearer tokens", () => {
    // A whitespace-only token must read as unset (so the surface stays
    // loopback-bound) rather than a set-but-unmatchable token that binds
    // publicly; a trailing newline (common from a secret file) must
    // resolve to the same credential a `\\S+` bearer capture presents.
    expect(
      loadServerEnvironment({ ...base, HARU_API_TOKEN: " ".repeat(3) })
        .HARU_API_TOKEN,
    ).toBeUndefined();
    expect(
      loadServerEnvironment({ ...base, HARU_API_TOKEN: "s3cret\n" })
        .HARU_API_TOKEN,
    ).toBe("s3cret");
    expect(
      loadServerEnvironment({ ...base, HARU_SUPERVISOR_TOKEN: "\ttok\t" })
        .HARU_SUPERVISOR_TOKEN,
    ).toBe("tok");
  });
});
