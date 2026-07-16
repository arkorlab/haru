import { describe, expect, it } from "vitest";

import {
  loadSupervisorEnvironment,
  trainerEnvironment,
} from "./environment.js";

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

describe("trainerEnvironment", () => {
  it("strips the supervisor's own secrets but keeps everything else", () => {
    const child = trainerEnvironment({
      PATH: "/usr/bin",
      CUDA_VISIBLE_DEVICES: "0",
      HOME: "/home/op",
      HARU_SUPERVISOR_TOKEN: "s3cret",
      HARU_SUPERVISOR_CONFIG: "/etc/haru/supervisor.json",
    });
    // The bearer credential for the network-exposed control API (and
    // the config path) must never reach an operator workload.
    expect(child.HARU_SUPERVISOR_TOKEN).toBeUndefined();
    expect(child.HARU_SUPERVISOR_CONFIG).toBeUndefined();
    // The workload still needs its toolchain environment.
    expect(child.PATH).toBe("/usr/bin");
    expect(child.CUDA_VISIBLE_DEVICES).toBe("0");
    expect(child.HOME).toBe("/home/op");
  });

  it("does not mutate the source environment", () => {
    const base = { HARU_SUPERVISOR_TOKEN: "s3cret", PATH: "/usr/bin" };
    trainerEnvironment(base);
    expect(base.HARU_SUPERVISOR_TOKEN).toBe("s3cret");
  });
});
