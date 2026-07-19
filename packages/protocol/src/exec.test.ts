import { describe, expect, it } from "vitest";

import { defaultExec } from "./exec.js";

describe("defaultExec", () => {
  it("captures stdout, stderr, and the exit code", async () => {
    const result = await defaultExec("node", [
      "-e",
      'console.log("out"); console.error("err"); process.exit(3);',
    ]);
    expect(result.code).toBe(3);
    expect(result.stdout.trim()).toBe("out");
    expect(result.stderr.trim()).toBe("err");
  });

  it("merges the provided env over the process env", async () => {
    const result = await defaultExec(
      "node",
      ["-e", "console.log(process.env.HARU_EXEC_TEST)"],
      { env: { HARU_EXEC_TEST: "merged" } },
    );
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("merged");
  });

  it("kills a wedged child at the timeout", async () => {
    const result = await defaultExec(
      "node",
      ["-e", "setTimeout(() => {}, 60_000)"],
      { timeoutMs: 200 },
    );
    expect(result.code).not.toBe(0);
  });

  it("on a timeout kill surfaces the signal but NOT a stderr-embedding message", async () => {
    const result = await defaultExec(
      "node",
      [
        "-e",
        'process.stderr.write("E".repeat(2000)); setTimeout(() => {}, 60_000);',
      ],
      { timeoutMs: 200 },
    );
    expect(result.code).toBe(1);
    expect(result.signal).toBe("SIGTERM");
    // Node embeds the ENTIRE captured stderr in the kill message, which
    // the signal plus the separately-captured stderr already convey, so
    // it is dropped - otherwise a downstream cap could be defeated by a
    // multi-KB message.
    expect(result.errorMessage).toBeNull();
    expect(result.stderr).toContain("E");
  });

  it("on a spawn failure carries the short reason in errorMessage", async () => {
    const result = await defaultExec("haru-definitely-not-a-real-binary", []);
    expect(result.code).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.errorMessage).toContain("ENOENT");
  });
});
