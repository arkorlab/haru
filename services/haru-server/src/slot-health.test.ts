import { applyFleetLayout, getFleetSnapshot } from "@haru/db";
import { createTestDatabase } from "@haru/db/testing";
import { requestTargetUrl } from "@haru/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reconcileFleet } from "./reconciler/reconciler.js";

import type { HaruDatabase } from "@haru/db";
import type { FleetSnapshot, SupervisorSlotStatus } from "@haru/protocol";

/**
 * Heartbeat slot-health sync on a MULTI-GPU active domain: every
 * changed slot must be mirrored in the same tick (regression for a
 * short-circuit that only synced the first one), and a supervisor
 * omitting a configured model must fail that slot instead of
 * vacuously passing.
 */

const SUPERVISOR = "https://alpha-supervisor.test";
const STANDBY_SUPERVISOR = "https://beta-supervisor.test";

const TWO_SLOT_LAYOUT = {
  slug: "default",
  activeDomainSlug: "alpha",
  domains: [
    {
      slug: "alpha",
      provider: "static",
      placement: {
        cloud: "aws",
        region: "us-east-1",
        accelerator: "TEST-GPU",
      },
      supervisorUrl: SUPERVISOR,
      servingBaseUrl: "https://alpha-serving.test",
      slots: [
        {
          kind: "inference",
          gpuIndex: 0,
          models: [
            { name: "example-chat-small", servingUrl: "https://a.test" },
          ],
        },
        {
          kind: "inference",
          gpuIndex: 1,
          models: [
            { name: "example-chat-large", servingUrl: "https://b.test" },
          ],
        },
      ],
    },
    {
      slug: "beta",
      provider: "static",
      placement: {
        cloud: "aws",
        region: "us-west-2",
        accelerator: "TEST-GPU",
      },
      supervisorUrl: STANDBY_SUPERVISOR,
      servingBaseUrl: "https://beta-serving.test",
      slots: [
        {
          kind: "inference",
          gpuIndex: 0,
          models: [
            { name: "example-chat-small", servingUrl: "https://c.test" },
          ],
        },
      ],
    },
  ],
};

/** Per-model reported sleeping flags (null = local vLLM unreachable);
 * delete an entry to simulate a drifted supervisor omitting it. */
type ReportedModels = Map<string, boolean | null>;

function statusFetch(
  alphaReported: ReportedModels,
  betaReported: ReportedModels = new Map([["example-chat-small", true]]),
): typeof fetch {
  return (input) => {
    const url = new URL(requestTargetUrl(input));
    if (url.pathname !== "/v1/status") {
      return Promise.reject(new TypeError(`unrouted ${url.href}`));
    }
    if (url.origin === STANDBY_SUPERVISOR) {
      const sleeping = betaReported.get("example-chat-small");
      const slots: SupervisorSlotStatus[] = [
        {
          gpuIndex: 0,
          kind: "inference",
          models:
            sleeping === undefined
              ? []
              : [{ name: "example-chat-small", port: 9100, sleeping }],
        },
      ];
      return Promise.resolve(Response.json({ slots, ready: false }));
    }
    const slots: SupervisorSlotStatus[] = [0, 1].map((gpuIndex) => {
      const name = gpuIndex === 0 ? "example-chat-small" : "example-chat-large";
      const sleeping = alphaReported.get(name);
      return {
        gpuIndex,
        kind: "inference",
        models:
          sleeping === undefined
            ? []
            : [{ name, port: 9000 + gpuIndex, sleeping }],
      };
    });
    const isAllAwake = alphaReported.values().every((s) => s === false);
    return Promise.resolve(
      Response.json({ slots, ready: alphaReported.size === 2 && isAllAwake }),
    );
  };
}

let database: HaruDatabase;
let close: () => Promise<void>;
let fleet: FleetSnapshot;

beforeEach(async () => {
  ({ db: database, close } = await createTestDatabase());
  await applyFleetLayout(database, TWO_SLOT_LAYOUT);
  const snapshot = await getFleetSnapshot(database, "default");
  if (!snapshot) throw new Error("seed failed");
  fleet = snapshot;
});

afterEach(async () => {
  await close();
});

async function reconcileWith(
  reported: ReportedModels,
  betaReported?: ReportedModels,
): Promise<void> {
  await reconcileFleet(
    {
      database,
      fetchFn: statusFetch(reported, betaReported),
      now: () => new Date(),
      supervisorToken: undefined,
    },
    fleet.id,
  );
}

const HEALTHY_ALPHA: [string, boolean | null][] = [
  ["example-chat-small", false],
  ["example-chat-large", false],
];

async function standbyStates(): Promise<string[]> {
  const snapshot = await getFleetSnapshot(database, "default");
  const beta = snapshot?.domains.find((d) => d.slug === "beta");
  return (beta?.slots ?? [])
    .filter((s) => s.kind === "inference")
    .map((s) => s.state);
}

async function inferenceStates(): Promise<Map<number, string>> {
  const snapshot = await getFleetSnapshot(database, "default");
  const alpha = snapshot?.domains.find((d) => d.slug === "alpha");
  return new Map(
    (alpha?.slots ?? [])
      .filter((s) => s.kind === "inference")
      .map((s) => [s.gpuIndex, s.state]),
  );
}

describe("active slot-health sync", () => {
  it("fails EVERY dead slot in one tick and recovers them together", async () => {
    // Both models die at once.
    await reconcileWith(
      new Map([
        ["example-chat-small", true],
        ["example-chat-large", true],
      ]),
    );
    expect(await inferenceStates()).toEqual(
      new Map([
        [0, "failed"],
        [1, "failed"],
      ]),
    );

    // Both come back: one tick recovers both.
    await reconcileWith(
      new Map([
        ["example-chat-small", false],
        ["example-chat-large", false],
      ]),
    );
    expect(await inferenceStates()).toEqual(
      new Map([
        [0, "serving"],
        [1, "serving"],
      ]),
    );
  });

  it("marks an unreachable standby vLLM failed and recovers it when it reports back asleep", async () => {
    // The standby's supervisor answers, but its local vLLM is dead
    // (sleeping: null): the sleeping slot must go failed so the
    // degraded-escalation viability gate stops counting this standby
    // as a failover target.
    await reconcileWith(
      new Map(HEALTHY_ALPHA),
      new Map([["example-chat-small", null]]),
    );
    expect(await standbyStates()).toEqual(["failed"]);

    // The local vLLM comes back asleep: the slot rejoins the standby
    // posture.
    await reconcileWith(
      new Map(HEALTHY_ALPHA),
      new Map([["example-chat-small", true]]),
    );
    expect(await standbyStates()).toEqual(["sleeping"]);
  });

  it("fails a sleeping standby slot that reports unexpectedly awake", async () => {
    // An awake standby vLLM holds the VRAM verify_gpu expects freed:
    // counting it as a viable failover target would sacrifice the
    // active to a promotion that wedges. The posture is unproven, so
    // the slot goes failed until the models report back asleep.
    await reconcileWith(
      new Map(HEALTHY_ALPHA),
      new Map([["example-chat-small", false]]),
    );
    expect(await standbyStates()).toEqual(["failed"]);

    await reconcileWith(
      new Map(HEALTHY_ALPHA),
      new Map([["example-chat-small", true]]),
    );
    expect(await standbyStates()).toEqual(["sleeping"]);
  });

  it("treats a configured model the supervisor omits as unhealthy", async () => {
    // The supervisor reports gpu0's model awake but has dropped gpu1's
    // configured model entirely (config drift): the omitted slot must
    // not keep routing.
    const reported: ReportedModels = new Map([["example-chat-small", false]]);
    await reconcileWith(reported);
    expect(await inferenceStates()).toEqual(
      new Map([
        [0, "serving"],
        [1, "failed"],
      ]),
    );
  });
});
