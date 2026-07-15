import { applyFleetLayout, getFleetSnapshot } from "@haru/db";
import { createTestDatabase } from "@haru/db/testing";
import { fleetSnapshotSchema, routeIntentSchema } from "@haru/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import {
  buildFakeFetch,
  fakeSupervisorState,
  testLayout,
  ALPHA_SUPERVISOR,
  BETA_SUPERVISOR,
} from "./fake-supervisor.test-helper.js";

import type { HaruDatabase } from "@haru/db";
import type { FleetSnapshot } from "@haru/protocol";

let database: HaruDatabase;
let close: () => Promise<void>;
let fleet: FleetSnapshot;

beforeEach(async () => {
  ({ db: database, close } = await createTestDatabase());
  await applyFleetLayout(database, testLayout());
  const snapshot = await getFleetSnapshot(database, "default");
  if (!snapshot) throw new Error("seed failed");
  fleet = snapshot;
});

afterEach(async () => {
  await close();
});

function appWith(config: Record<string, unknown> = {}) {
  return createApp({
    database,
    config,
    fetchFn: buildFakeFetch({
      supervisors: {
        [ALPHA_SUPERVISOR]: fakeSupervisorState({ sleeping: false }),
        [BETA_SUPERVISOR]: fakeSupervisorState(),
      },
    }),
  });
}

const alpha = () => fleet.domains.find((d) => d.slug === "alpha")!;
const beta = () => fleet.domains.find((d) => d.slug === "beta")!;

describe("healthz and auth", () => {
  it("healthz is open even when a token is configured", async () => {
    const app = appWith({ apiToken: "secret" });
    const response = await app.request("/healthz");
    expect(response.status).toBe(200);
  });

  it("healthz never touches the database (stays 200 during a store outage)", async () => {
    // A liveness probe that read the DB would go red during a state-store
    // outage and get the process restarted - destroying the fail-open
    // cache that is keeping the data path alive. Prove /healthz answers
    // even when every query throws.
    const { breakableDatabase } =
      await import("./failing-database.test-helper.js");
    const broken = breakableDatabase(database);
    broken.breakIt();
    const app = createApp({ database: broken.database, config: {} });
    const response = await app.request("/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("rejects /v1 requests without the configured bearer token", async () => {
    const app = appWith({ apiToken: "secret" });
    const missing = await app.request("/v1/fleets/default");
    expect(missing.status).toBe(401);
    const wrong = await app.request("/v1/fleets/default", {
      headers: { authorization: "Bearer nope" },
    });
    expect(wrong.status).toBe(401);
    const right = await app.request("/v1/fleets/default", {
      headers: { authorization: "Bearer secret" },
    });
    expect(right.status).toBe(200);
  });

  it("is open when no token is configured", async () => {
    const app = appWith();
    const response = await app.request("/v1/fleets/default");
    expect(response.status).toBe(200);
  });
});

describe("GET /v1/fleets/:fleetId", () => {
  it("returns a schema-valid snapshot by slug and by id", async () => {
    const app = appWith();
    const bySlug = await app.request("/v1/fleets/default");
    expect(bySlug.status).toBe(200);
    const snapshot = fleetSnapshotSchema.parse(await bySlug.json());
    expect(snapshot.slug).toBe("default");
    const byId = await app.request(`/v1/fleets/${snapshot.id}`);
    expect(byId.status).toBe(200);
  });

  it("404s for an unknown fleet", async () => {
    const app = appWith();
    const response = await app.request("/v1/fleets/ghost");
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("fleet_not_found");
  });
});

describe("GET /v1/fleets/:fleetId/route-intent", () => {
  it("returns a schema-valid route intent with alpha active", async () => {
    const app = appWith();
    const response = await app.request("/v1/fleets/default/route-intent");
    expect(response.status).toBe(200);
    const intent = routeIntentSchema.parse(await response.json());
    expect(intent.active?.domainSlug).toBe("alpha");
    expect(intent.active?.eligible).toBe(true);
    expect(intent.standbys.map((s) => s.domainSlug)).toEqual(["beta"]);
    expect(intent.standbys[0]?.weight).toBe(0);
    // Seed bumps the revision when it sets the initial pointer.
    expect(intent.revision).toBe(2);
  });
});

describe("POST /v1/fleets/:fleetId/promote", () => {
  it("is a 200 no-op for the already-active domain", async () => {
    const app = appWith();
    const response = await app.request("/v1/fleets/default/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetDomainId: alpha().id }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "already_active",
      routeRevision: 2,
    });
  });

  it("202-accepts a standby target and joins duplicates", async () => {
    const app = appWith();
    const first = await app.request("/v1/fleets/default/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetDomainId: beta().id }),
    });
    expect(first.status).toBe(202);
    const firstBody = await first.json();
    expect(firstBody.status).toBe("accepted");

    const second = await app.request("/v1/fleets/default/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetDomainId: beta().id }),
    });
    expect(second.status).toBe(202);
    const secondBody = await second.json();
    expect(secondBody.operation.id).toBe(firstBody.operation.id);
  });

  it("accepts an UPPERCASE targetDomainId (uuids are case-insensitive)", async () => {
    const app = appWith();
    const response = await app.request("/v1/fleets/default/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // A client that re-cases the id it was handed (UUIDs are
      // case-insensitive) must not be spuriously 422'd against the
      // lowercase id Postgres stores.
      body: JSON.stringify({ targetDomainId: beta().id.toUpperCase() }),
    });
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.status).toBe("accepted");
    // The operation records the canonical (lowercase) id.
    expect(body.operation.targetDomainId).toBe(beta().id);
  });

  it("409s a conflicting in-flight operation", async () => {
    const app = appWith();
    await app.request("/v1/fleets/default/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetDomainId: beta().id }),
    });
    // A demote against the same fleet while the promote is in flight
    // carries a different intent and must conflict.
    const response = await app.request("/v1/fleets/default/demote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetDomainId: beta().id }),
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("operation_conflict");
  });

  it("422s an unknown or non-promotable target and 400s bad bodies", async () => {
    const app = appWith();
    const unknown = await app.request("/v1/fleets/default/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetDomainId: "00000000-0000-4000-8000-0000000000ff",
      }),
    });
    expect(unknown.status).toBe(422);

    const badBody = await app.request("/v1/fleets/default/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(badBody.status).toBe(400);
  });
});

describe("POST /v1/fleets/:fleetId/demote", () => {
  it("never demotes the active domain", async () => {
    const app = appWith();
    const response = await app.request("/v1/fleets/default/demote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetDomainId: alpha().id }),
    });
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("invalid_target");
  });

  it("202-accepts a standby demote", async () => {
    const app = appWith();
    const response = await app.request("/v1/fleets/default/demote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetDomainId: beta().id }),
    });
    expect(response.status).toBe(202);
  });
});
