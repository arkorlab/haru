import { describe, expect, it } from "vitest";

import { loadSupervisorEnvironment } from "./environment.js";

describe("loadSupervisorEnvironment", () => {
  const base = { HARU_SUPERVISOR_CONFIG: "/etc/haru/supervisor.json" };

  it("treats a blank PORT as unset and uses the default", () => {
    expect(loadSupervisorEnvironment({ ...base, PORT: "" }).PORT).toBe(8701);
    expect(
      loadSupervisorEnvironment({ ...base, PORT: " ".repeat(3) }).PORT,
    ).toBe(8701);
    expect(loadSupervisorEnvironment({ ...base, PORT: "9100" }).PORT).toBe(
      9100,
    );
  });

  it("rejects an out-of-range PORT instead of coercing a blank to 0", () => {
    expect(() => loadSupervisorEnvironment({ ...base, PORT: "0" })).toThrow();
    expect(() => loadSupervisorEnvironment({ ...base, PORT: "-1" })).toThrow();
  });

  it("trims and blank-normalises HARU_SUPERVISOR_TOKEN", () => {
    // A whitespace-only token must read as unset (so the control plane
    // stays loopback-bound) rather than a set-but-unmatchable token that
    // binds publicly; a trailing newline (common from a secret file) must
    // resolve to the same credential the server presents after its trim.
    expect(
      loadSupervisorEnvironment({
        ...base,
        HARU_SUPERVISOR_TOKEN: " ".repeat(3),
      }).HARU_SUPERVISOR_TOKEN,
    ).toBeUndefined();
    expect(
      loadSupervisorEnvironment({ ...base, HARU_SUPERVISOR_TOKEN: "s3cret\n" })
        .HARU_SUPERVISOR_TOKEN,
    ).toBe("s3cret");
    expect(
      loadSupervisorEnvironment({ ...base, HARU_SUPERVISOR_TOKEN: "\ttok\t" })
        .HARU_SUPERVISOR_TOKEN,
    ).toBe("tok");
  });

  it("requires HARU_SUPERVISOR_CONFIG", () => {
    expect(() => loadSupervisorEnvironment({})).toThrow();
  });
});
