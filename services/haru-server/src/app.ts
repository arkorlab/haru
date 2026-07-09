import { buildRouteIntent, decideDemotion, decidePromotion } from "@haru/core";
import {
  appendEvent,
  createOperation,
  getFleetSnapshot,
  toOperationSnapshot,
} from "@haru/db";
import {
  chatCompletionRequestSchema,
  demoteRequestSchema,
  errorBody,
  promoteRequestSchema,
  type FleetSnapshot,
  type OperationKind,
} from "@haru/protocol";
import { Hono } from "hono";

import { bearerAuth } from "./auth.js";
import {
  DEFAULT_CHAT_HEADER_TIMEOUT_MS,
  proxyChatCompletion,
} from "./chat-proxy.js";
import { reconcileFleet } from "./reconciler/reconciler.js";

import type { HaruDatabase } from "@haru/db";

export interface AppConfig {
  /** Bearer token for the public API; unset = open (local dev only). */
  apiToken?: string;
  /** Bearer token presented to domain supervisors. */
  supervisorToken?: string;
  /** Fleet used by /v1/chat/completions when no X-Haru-Fleet header. */
  defaultFleet?: string;
  /** TTFB bound for the chat proxy. */
  chatHeaderTimeoutMs?: number;
  /** Fleet snapshot cache TTL for the chat hot path. */
  snapshotCacheTtlMs?: number;
}

export interface AppDependencies {
  database: HaruDatabase;
  config?: AppConfig;
  fetchFn?: typeof fetch;
  now?: () => Date;
}

interface SnapshotCacheEntry {
  snapshot: FleetSnapshot;
  expiresAtMs: number;
}

/** Parse a request body as JSON, mapping malformed JSON to null. */
async function readJsonBody(c: {
  req: { json: () => Promise<unknown> };
}): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

export function createApp(dependencies: AppDependencies) {
  const database = dependencies.database;
  const config = dependencies.config ?? {};
  const fetchFunction = dependencies.fetchFn ?? fetch;
  const now = dependencies.now ?? (() => new Date());
  const chatHeaderTimeoutMs =
    config.chatHeaderTimeoutMs ?? DEFAULT_CHAT_HEADER_TIMEOUT_MS;
  const snapshotCacheTtlMs = config.snapshotCacheTtlMs ?? 2000;

  const reconcilerDependencies = {
    database,
    fetchFn: fetchFunction,
    now,
    supervisorToken: config.supervisorToken,
  };

  // Tiny read cache for the chat hot path so per-request DB load stays
  // bounded. Route changes surface within the TTL.
  const snapshotCache = new Map<string, SnapshotCacheEntry>();
  async function cachedSnapshot(
    reference: string,
  ): Promise<FleetSnapshot | null> {
    const nowMs = now().getTime();
    const hit = snapshotCache.get(reference);
    if (hit && hit.expiresAtMs > nowMs) {
      return hit.snapshot;
    }
    const snapshot = await getFleetSnapshot(database, reference);
    if (snapshot) {
      snapshotCache.set(reference, {
        snapshot,
        expiresAtMs: nowMs + snapshotCacheTtlMs,
      });
    }
    return snapshot;
  }

  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.use("/v1/*", bearerAuth(config.apiToken));

  app.get("/v1/fleets/:fleetId", async (c) => {
    const snapshot = await getFleetSnapshot(database, c.req.param("fleetId"));
    if (!snapshot) {
      return c.json(errorBody("fleet_not_found", "no such fleet"), 404);
    }
    return c.json(snapshot);
  });

  app.get("/v1/fleets/:fleetId/route-intent", async (c) => {
    const snapshot = await getFleetSnapshot(database, c.req.param("fleetId"));
    if (!snapshot) {
      return c.json(errorBody("fleet_not_found", "no such fleet"), 404);
    }
    return c.json(buildRouteIntent(snapshot, now()));
  });

  app.post("/v1/fleets/:fleetId/reconcile", async (c) => {
    const result = await reconcileFleet(
      reconcilerDependencies,
      c.req.param("fleetId"),
    );
    if (!result) {
      return c.json(errorBody("fleet_not_found", "no such fleet"), 404);
    }
    return c.json(result);
  });

  async function handleOperationRequest(
    fleetReference: string,
    kind: OperationKind,
    targetDomainId: string,
  ): Promise<{ status: 200 | 202 | 404 | 409 | 422; body: unknown }> {
    const snapshot = await getFleetSnapshot(database, fleetReference);
    if (!snapshot) {
      return {
        status: 404,
        body: errorBody("fleet_not_found", "no such fleet"),
      };
    }
    const decision =
      kind === "promote"
        ? decidePromotion(snapshot, targetDomainId)
        : decideDemotion(snapshot, targetDomainId);
    if (decision.type === "already_active") {
      return {
        status: 200,
        body: {
          status: "already_active",
          routeRevision: decision.routeRevision,
        },
      };
    }
    if (decision.type === "invalid_target") {
      return {
        status: 422,
        body: errorBody("invalid_target", decision.reason),
      };
    }
    const result = await createOperation(database, {
      fleetId: snapshot.id,
      kind,
      targetDomainId,
      // Recorded so post-commit cleanup steps know the actual old
      // active, independent of fleet size and iteration order.
      sourceDomainId: snapshot.activeDomainId,
    });
    const isSameIntent =
      result.operation.kind === kind &&
      result.operation.targetDomainId === targetDomainId;
    if (!result.created && !isSameIntent) {
      return {
        status: 409,
        body: errorBody(
          "operation_conflict",
          `another operation (${result.operation.kind} -> ${result.operation.targetDomainId}) is in flight for this fleet`,
        ),
      };
    }
    if (result.created) {
      await appendEvent(database, {
        fleetId: snapshot.id,
        operationId: result.operation.id,
        type: `operation.requested.${kind}`,
        payload: { targetDomainId },
      });
    }
    return {
      status: 202,
      body: {
        status: "accepted",
        operation: toOperationSnapshot(result.operation),
      },
    };
  }

  app.post("/v1/fleets/:fleetId/promote", async (c) => {
    const body: unknown = await readJsonBody(c);
    const parsed = promoteRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(errorBody("invalid_request", parsed.error.message), 400);
    }
    const result = await handleOperationRequest(
      c.req.param("fleetId"),
      "promote",
      parsed.data.targetDomainId,
    );
    return c.json(result.body as Record<string, unknown>, result.status);
  });

  app.post("/v1/fleets/:fleetId/demote", async (c) => {
    const body: unknown = await readJsonBody(c);
    const parsed = demoteRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(errorBody("invalid_request", parsed.error.message), 400);
    }
    const result = await handleOperationRequest(
      c.req.param("fleetId"),
      "demote",
      parsed.data.targetDomainId,
    );
    return c.json(result.body as Record<string, unknown>, result.status);
  });

  app.post("/v1/chat/completions", async (c) => {
    const fleetReference = c.req.header("x-haru-fleet") ?? config.defaultFleet;
    if (fleetReference === undefined || fleetReference === "") {
      return c.json(
        errorBody(
          "fleet_not_found",
          "no fleet specified: set the X-Haru-Fleet header or configure a default fleet",
        ),
        404,
      );
    }
    const snapshot = await cachedSnapshot(fleetReference);
    if (!snapshot) {
      return c.json(errorBody("fleet_not_found", "no such fleet"), 404);
    }

    // Keep the raw text so unknown fields forward byte-identically;
    // parse only to extract the model name.
    const bodyText = await c.req.text();
    let model: string;
    try {
      model = chatCompletionRequestSchema.parse(JSON.parse(bodyText)).model;
    } catch {
      return c.json(
        errorBody("invalid_request", "body must be JSON with a model field"),
        400,
      );
    }

    const active =
      snapshot.activeDomainId === null
        ? undefined
        : snapshot.domains.find((d) => d.id === snapshot.activeDomainId);
    const isRoutable =
      active !== undefined &&
      (active.state === "ready" || active.state === "degraded");
    if (!active || !isRoutable) {
      return c.json(
        errorBody(
          "no_active_domain",
          "the fleet has no routable active domain",
        ),
        503,
      );
    }

    const bindings = active.slots.flatMap((slot) =>
      slot.spec.kind === "inference" && slot.state === "serving"
        ? slot.spec.models
        : [],
    );
    const binding = bindings.find((b) => b.name === model);
    if (!binding) {
      const available = bindings.map((b) => b.name).join(", ");
      return c.json(
        errorBody(
          "model_not_found",
          `model ${model} is not served by the active domain (available: ${available})`,
        ),
        404,
      );
    }

    const result = await proxyChatCompletion(
      fetchFunction,
      binding.servingUrl,
      bodyText,
      chatHeaderTimeoutMs,
    );
    if (!result.ok) {
      return c.json(result.body, result.status);
    }
    return result.response;
  });

  return app;
}
