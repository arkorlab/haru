import { describe, expect, it } from "vitest";

import { isBearerTokenValid, isSameSecret } from "./auth.js";

describe("isSameSecret", () => {
  it("matches equal secrets and rejects different ones", () => {
    expect(isSameSecret("s3cret", "s3cret")).toBe(true);
    expect(isSameSecret("s3cret", "other")).toBe(false);
  });

  it("handles different lengths without throwing", () => {
    expect(isSameSecret("short", "a-much-longer-secret")).toBe(false);
  });
});

describe("isBearerTokenValid", () => {
  it("is open when no token is configured", () => {
    expect(isBearerTokenValid(undefined, undefined)).toBe(true);
    expect(isBearerTokenValid("Bearer whatever", "")).toBe(true);
  });

  it("accepts the exact bearer token", () => {
    expect(isBearerTokenValid("Bearer s3cret", "s3cret")).toBe(true);
  });

  it("rejects a wrong, missing, or non-bearer credential", () => {
    expect(isBearerTokenValid("Bearer wrong", "s3cret")).toBe(false);
    expect(isBearerTokenValid(undefined, "s3cret")).toBe(false);
    expect(isBearerTokenValid("", "s3cret")).toBe(false);
    expect(isBearerTokenValid("Basic s3cret", "s3cret")).toBe(false);
    expect(isBearerTokenValid("Bearer ", "s3cret")).toBe(false);
  });
});
