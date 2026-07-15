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
});
