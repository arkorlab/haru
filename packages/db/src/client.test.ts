import { fleetPolicySchema } from "@haru/protocol";
import { neon, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { describe, expect, it } from "vitest";

import { DEFAULT_QUERY_BUDGET_MS, withQueryBudget } from "./client.js";
import { fleets } from "./schema/index.js";

interface RecordedCall {
  readonly query: string;
  readonly params: unknown[] | undefined;
  readonly options: Record<string, unknown> | undefined;
}

/**
 * A stand-in for the Neon HTTP client that records what it was handed.
 * The budget is asserted against the call the driver would really make,
 * so a wrapper that misses the path drizzle takes cannot pass.
 */
function fakeClient(
  behavior: (signal: AbortSignal | undefined) => Promise<unknown> = () =>
    Promise.resolve([]),
) {
  const calls: RecordedCall[] = [];
  const client = {
    query: async (
      query: string,
      parameters?: unknown[],
      options?: Record<string, unknown>,
    ): Promise<unknown> => {
      calls.push({ query, params: parameters, options });
      const fetchOptions = options?.fetchOptions as
        | { signal?: AbortSignal }
        | undefined;
      return behavior(fetchOptions?.signal);
    },
    // Present so the "everything else passes through" assertion has
    // something to reach for, and to mirror the real client's shape.
    unsafe: (text: string) => text,
  };
  return { client, calls };
}

/** Reject when the signal aborts, mirroring how fetch behaves. */
async function hangUntilAborted(signal: AbortSignal | undefined) {
  return new Promise<never>((_resolve, reject) => {
    signal?.addEventListener("abort", () => {
      reject(signal.reason as Error);
    });
  });
}

function activeTimerCount(): number {
  return process
    .getActiveResourcesInfo()
    .filter((resource) => resource === "Timeout").length;
}

/**
 * Read the fetch options off a recorded call, failing the test rather
 * than returning undefined: every assertion below is about what the
 * wrapper HANDED the client, so a missing call is a failure, not a
 * nullable value to thread around.
 */
function fetchOptionsOf(call: RecordedCall | undefined): {
  readonly signal: AbortSignal;
  readonly [key: string]: unknown;
} {
  const options = call?.options?.fetchOptions;
  expect(options).toBeDefined();
  return options as { readonly signal: AbortSignal };
}

describe("withQueryBudget", () => {
  it("attaches a per-call AbortSignal to the query drizzle actually issues", async () => {
    const { client, calls } = fakeClient();
    const budgeted = withQueryBudget(client, 5000);

    await budgeted.query("select 1", []);

    expect(calls).toHaveLength(1);
    const fetchOptions = fetchOptionsOf(calls[0]);
    expect(fetchOptions.signal).toBeInstanceOf(AbortSignal);
    expect(fetchOptions.signal.aborted).toBe(false);
  });

  it("gives each call its own signal", async () => {
    const { client, calls } = fakeClient();
    const budgeted = withQueryBudget(client, 5000);

    await budgeted.query("select 1", []);
    await budgeted.query("select 2", []);

    const first = fetchOptionsOf(calls[0]).signal;
    const second = fetchOptionsOf(calls[1]).signal;
    // A shared signal would abort every later query the moment the first
    // budget expired.
    expect(first).not.toBe(second);
  });

  // A tiny real budget rather than fake timers: the assertion is that a
  // promise rejects, and a 20ms wait states that more directly than
  // driving the clock would.
  it("rejects once the budget elapses, so a hung store surfaces as a throw", async () => {
    const { client } = fakeClient(hangUntilAborted);
    const budgeted = withQueryBudget(client, 20);

    await expect(budgeted.query("select 1", [])).rejects.toThrow();
  });

  it("leaves a query that answers inside the budget untouched", async () => {
    const { client, calls } = fakeClient(() => Promise.resolve([{ ok: true }]));
    const budgeted = withQueryBudget(client, 10_000);

    await expect(budgeted.query("select 1", [])).resolves.toEqual([
      { ok: true },
    ]);
    const fetchOptions = fetchOptionsOf(calls[0]);
    // The signal is scoped to the attempt: a query that answered is never
    // reported as aborted, whatever the budget was.
    expect(fetchOptions.signal.aborted).toBe(false);
  });

  it("preserves the options drizzle sets and merges caller fetchOptions", async () => {
    const { client, calls } = fakeClient();
    const budgeted = withQueryBudget(client, 5000);

    await budgeted.query("select 1", ["a"], {
      arrayMode: true,
      fullResults: true,
      authToken: "token",
      fetchOptions: { priority: "high" },
    });

    const options = calls[0]?.options;
    expect(options?.arrayMode).toBe(true);
    expect(options?.fullResults).toBe(true);
    expect(options?.authToken).toBe("token");
    const fetchOptions = fetchOptionsOf(calls[0]);
    // Replacing fetchOptions instead of merging would silently drop
    // whatever the caller had set.
    expect(fetchOptions.priority).toBe("high");
    expect(fetchOptions.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]?.params).toEqual(["a"]);
  });

  it("composes a caller-supplied signal instead of dropping it", async () => {
    const { client, calls } = fakeClient();
    const budgeted = withQueryBudget(client, 5000);
    const callerController = new AbortController();

    await budgeted.query("select 1", [], {
      fetchOptions: { signal: callerController.signal },
    });

    const { signal } = fetchOptionsOf(calls[0]);
    expect(signal.aborted).toBe(false);
    // Overwriting the caller's signal would make their cancellation a
    // no-op, silently.
    callerController.abort(new Error("caller cancelled"));
    expect(signal.aborted).toBe(true);
  });

  it("clears the budget timer once the query settles", async () => {
    const { client } = fakeClient();
    const budgeted = withQueryBudget(client, 60_000);
    const timersBefore = activeTimerCount();

    for (let attempt = 0; attempt < 5; attempt++) {
      await budgeted.query("select 1", []);
    }

    // Measured as a delta because the test runner keeps timers of its
    // own. A leak would hold one 60s timer per query, so five queries
    // would leave five behind and keep the event loop alive.
    expect(activeTimerCount()).toBe(timersBefore);
  });

  it("passes every other property through untouched", () => {
    const { client } = fakeClient();
    const budgeted = withQueryBudget(client, 5000);

    expect(budgeted.unsafe("raw")).toBe("raw");
  });

  // The load-bearing test: drizzle resolves `client.query ?? client` once
  // at construction, so a wrapper that budgets the wrong path compiles,
  // passes every unit test above, and never applies to a real query.
  // Only driving real drizzle proves which path is taken.
  it("applies the budget to the query real drizzle issues", async () => {
    // A real `fullResults` envelope rather than the default []: drizzle
    // then completes normally, so the query is awaited without a catch.
    // Swallowing "the response shape was wrong" would also swallow a
    // wrapper that threw after recording the call.
    const { client, calls } = fakeClient(() => Promise.resolve({ rows: [] }));
    const database = drizzle({
      client: withQueryBudget(client, 5000) as never,
      schema: { fleets },
    });

    await expect(database.select().from(fleets).limit(1)).resolves.toEqual([]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.query).toContain("fleets");
    expect(fetchOptionsOf(calls[0]).signal).toBeInstanceOf(AbortSignal);
  });

  it("defaults to a budget no wider than the tightest step it runs inside", () => {
    // Pinning the exact number would only restate the source and would
    // fail on any deliberate tuning. What the constant's comment claims
    // is a relationship: the budget does not exceed
    // `switchActiveTimeoutMs`, the step whose work is a single pointer
    // CAS. Assert that against the live policy default, so raising
    // either number without the other fails here.
    //
    // The relationship is a bound, not a containment guarantee: this
    // budget restarts at each query while the step timeout runs from
    // step entry, so only a read issued AT entry is covered by it.
    const { switchActiveTimeoutMs } = fleetPolicySchema.parse({});

    expect(DEFAULT_QUERY_BUDGET_MS).toBeGreaterThan(0);
    expect(DEFAULT_QUERY_BUDGET_MS).toBeLessThanOrEqual(switchActiveTimeoutMs);
  });

  it("rejects a budget setTimeout would silently round to 1ms", () => {
    const { client } = fakeClient();
    // setTimeout coerces all of these rather than refusing them, which
    // would abort every query almost immediately and read as a total
    // outage. 0.5 and 2^31 are the two that look plausible in a config
    // file, and are exactly what a finite-and-positive check misses.
    for (const budget of [0, -1, NaN, Infinity, 0.5, 2_147_483_648]) {
      // Asserted on the CONSTRUCTOR, not on a query: a budget rejected
      // only once someone runs a statement reports the misconfiguration
      // from an arbitrary call site instead of from the wiring.
      expect(() => withQueryBudget(client, budget)).toThrow(RangeError);
    }
  });

  it("does not crash or strand a timer when the driver returns nothing", () => {
    const client = {
      query: (_query: string, _parameters?: unknown[]): Promise<unknown> =>
        null as unknown as Promise<unknown>,
    };
    const budgeted = withQueryBudget(client, 60_000);
    const before = activeTimerCount();

    expect(budgeted.query("select 1", [])).toBeNull();
    expect(activeTimerCount()).toBe(before);
  });

  it("budgets the transaction the batch path actually sends", async () => {
    let received: Record<string, unknown> | undefined;
    const client = {
      query: () => Promise.resolve([]),
      transaction: (
        _queriesOrFunction: unknown[] | ((...arguments_: unknown[]) => unknown),
        options?: Record<string, unknown>,
      ) => {
        received = options;
        return Promise.resolve([]);
      },
    };
    const budgeted = withQueryBudget(client, 5000);

    await budgeted.transaction([], { isolationLevel: "Serializable" });

    const fetchOptions = received?.fetchOptions as { signal: AbortSignal };
    expect(fetchOptions.signal).toBeInstanceOf(AbortSignal);
    // The caller's own transaction options must survive the merge.
    expect(received?.isolationLevel).toBe("Serializable");
  });

  it("does not choke on the documented callback form of transaction", async () => {
    const client = {
      query: () => Promise.resolve([]),
      transaction: (_queriesOrFunction: unknown, _options?: unknown) =>
        Promise.resolve(["ok"]),
    };
    const budgeted = withQueryBudget(client, 5000);

    // Neon documents `transaction(txn => [...])` alongside the array
    // form. Iterating that callback for per-statement timers threw inside
    // `finally`, turning a SUCCESSFUL transaction into a failure.
    await expect(budgeted.transaction(() => [], {})).resolves.toEqual(["ok"]);
  });
});

/**
 * Everything above asserts what the wrapper HANDS the client, against a
 * fake. That is only meaningful while the fake reproduces the real
 * driver's contract, and nothing above checks THAT: a fake which invents
 * a parameter the driver ignores would keep every assertion green while
 * production stayed unbounded.
 *
 * So this pins the assumption itself against the installed driver: that
 * `fetchOptions` passed as the third argument to `query` reaches the
 * fetch layer. If a future release moves it to construction-time only,
 * this fails instead of the budget quietly becoming a no-op.
 */
describe("the driver contract the budget depends on", () => {
  it("keeps query() lazy so drizzle's batch path still works", () => {
    const originalFetchFunction = neonConfig.fetchFunction as unknown;
    // Never resolves: nothing here is awaited, only the returned shape
    // is inspected.
    neonConfig.fetchFunction = () => new Promise<Response>(() => undefined);
    try {
      const sql = neon("postgresql://user:pass@example.neon.tech/db");
      const options = { fullResults: true, arrayMode: false };
      const direct = sql.query("select 1", [], options) as {
        queryData?: unknown;
      };
      // A short budget: this test never executes the query, so nothing
      // clears the timer and a long one would add a real tail to the run.
      const budgeted = withQueryBudget(
        sql as unknown as Parameters<typeof withQueryBudget>[0],
        20,
      ).query("select 1", [], options) as { queryData?: unknown };

      // `batch` hands these objects to `client.transaction`, which reads
      // `queryData` off them. An async wrapper would return a bare
      // promise here and break batch with nothing else failing.
      expect(direct.queryData).toBeDefined();
      expect(budgeted.queryData).toBeDefined();
      expect(budgeted.constructor.name).toBe(direct.constructor.name);

      // Deliberately NOT subscribed: a lazy Neon query is a thenable, so
      // even `.catch()` would call `execute` and fire the request this
      // test claims never runs.
    } finally {
      neonConfig.fetchFunction = originalFetchFunction;
    }
  });

  it("releases the per-statement budgets that batch never executes", async () => {
    const originalFetchFunction = neonConfig.fetchFunction as unknown;
    neonConfig.fetchFunction = () => new Promise<Response>(() => undefined);
    try {
      const sql = neon("postgresql://user:pass@example.neon.tech/db");
      // Stubbed so this measures timer bookkeeping, not the request.
      (sql as unknown as { transaction: unknown }).transaction = () =>
        Promise.resolve([]);
      const budgeted = withQueryBudget(
        sql as unknown as Parameters<typeof withQueryBudget>[0],
        60_000,
      );
      const before = activeTimerCount();

      const statements = [1, 2, 3].map((n) =>
        budgeted.query(`select ${String(n)}`, [], {
          fullResults: true,
          arrayMode: false,
        }),
      );
      // Each build starts a budget, and batch hands them off unexecuted,
      // so the execute hook never runs for any of them.
      expect(activeTimerCount() - before).toBe(statements.length);

      await budgeted.transaction?.(statements, {});

      expect(activeTimerCount()).toBe(before);
    } finally {
      neonConfig.fetchFunction = originalFetchFunction;
    }
  });

  it("delivers query-level fetchOptions to the fetch layer", async () => {
    const originalFetchFunction = neonConfig.fetchFunction as unknown;
    let received: RequestInit | undefined;
    neonConfig.fetchFunction = (_url: string, options: RequestInit) => {
      received = options;
      return Promise.resolve(
        Response.json(
          {
            command: "SELECT",
            fields: [],
            rows: [],
            rowCount: 0,
          },
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    };
    try {
      const sql = neon("postgresql://user:pass@example.neon.tech/db");
      const controller = new AbortController();

      await sql.query("select 1", [], {
        fetchOptions: { signal: controller.signal },
      });

      expect(received?.signal).toBe(controller.signal);
    } finally {
      // `neonConfig` is process-global; leaving a stub installed would
      // silently rewrite every later query in this worker.
      neonConfig.fetchFunction = originalFetchFunction;
    }
  });
});
