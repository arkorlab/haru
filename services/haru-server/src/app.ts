import {
  buildRouteIntent,
  decideDemotion,
  decidePromotion,
  findRoutableBinding,
  isRoutableDomainState,
  routableModels,
} from "@haru/core";
import {
  appendEvent,
  createOperation,
  getFleetRoutePointer,
  getFleetSnapshot,
  isFleetIdShaped,
  toOperationSnapshot,
} from "@haru/db";
import {
  chatCompletionRequestSchema,
  demoteRequestSchema,
  errorBody,
  promoteRequestSchema,
  readJsonBody,
  type FleetSnapshot,
  type OperationAcceptedResponse,
  type OperationKind,
  type PromoteNoopResponse,
} from "@haru/protocol";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import { bearerAuth } from "./auth.js";
import {
  DEFAULT_CHAT_HEADER_TIMEOUT_MS,
  DEFAULT_CHAT_MAX_BODY_BYTES,
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
  /**
   * Max chat request body size in bytes (413 above it). The proxy must
   * buffer the whole body to extract `model` and forward it
   * byte-identically, so this caps per-request memory instead of
   * leaving it unbounded.
   */
  chatMaxBodyBytes?: number;
}

export interface AppDependencies {
  database: HaruDatabase;
  config?: AppConfig;
  fetchFn?: typeof fetch;
  /**
   * fetch used ONLY by the chat proxy; defaults to fetchFn. main.ts
   * passes createChatFetch() here so undici's own 300s headers/body
   * timers never cap chatHeaderTimeoutMs or cut a quiet SSE stream
   * (see chat-fetch.ts). Kept separate from fetchFn so control-plane
   * calls retain undici's default timeouts as a backstop.
   */
  chatFetchFn?: typeof fetch;
  now?: () => Date;
}

interface SnapshotCacheEntry {
  snapshot: FleetSnapshot;
  routeRevision: number;
  expiresAtMs: number;
}

/**
 * Outcome of resolving a fleet reference for the chat hot path.
 * `isStale` marks a snapshot served from cache because the state store
 * was unreachable (fail-open); `unavailable` is the cold-cache case,
 * where there is nothing to serve.
 */
type SnapshotLookup =
  | { ok: true; snapshot: FleetSnapshot; isStale: boolean }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "unavailable"; detail: string };

/** Marks a chat response served from a stale (fail-open) snapshot. */
const STALE_ROUTING_HEADER = "x-haru-routing";

/** Lowercase a UUID-shaped reference. The fail-open cache is keyed by the
 * canonical (lowercase) ids Postgres returns, while the database itself
 * accepts a uuid in any case, so both spellings must reach the same entry. */
function canonicalReference(reference: string): string {
  return isFleetIdShaped(reference) ? reference.toLowerCase() : reference;
}

export function createApp(dependencies: AppDependencies) {
  const database = dependencies.database;
  const config = dependencies.config ?? {};
  const fetchFunction = dependencies.fetchFn ?? fetch;
  const chatFetchFunction = dependencies.chatFetchFn ?? fetchFunction;
  const now = dependencies.now ?? (() => new Date());
  const chatHeaderTimeoutMs =
    config.chatHeaderTimeoutMs ?? DEFAULT_CHAT_HEADER_TIMEOUT_MS;
  const snapshotCacheTtlMs = config.snapshotCacheTtlMs ?? 2000;
  const chatMaxBodyBytes =
    config.chatMaxBodyBytes ?? DEFAULT_CHAT_MAX_BODY_BYTES;

  // Tiny read cache for the chat hot path so per-request DB load stays
  // bounded. Keyed by fleet id (slug and UUID references share one
  // entry) and revalidated per request against the fleet's route
  // revision (one narrow SELECT), so an active-pointer move surfaces
  // immediately no matter which process moved it; the TTL only bounds
  // non-routing staleness (slot states).
  const snapshotCache = new Map<string, SnapshotCacheEntry>();
  // Reference (slug or uuid) -> fleet id, learned from every successful
  // lookup. The cache above is keyed by fleet id, which is the RESULT of
  // the very query that fails when the state store is down, so the
  // fail-open path needs this index to resolve the caller's raw
  // reference without a database. `cachedFor` reads it with the same
  // id-first rule the database uses.
  const fleetIdByReference = new Map<string, string>();
  // Fleets currently being served from a stale snapshot. Only used to
  // log the transitions (entering / leaving fail-open) instead of once
  // per request, which would flood the log on a busy fleet.
  const staleFleetIds = new Set<string>();

  const reconcilerDependencies = {
    database,
    fetchFn: fetchFunction,
    now,
    supervisorToken: config.supervisorToken,
  };

  /**
   * Resolve a fleet reference for the chat hot path, FAILING OPEN when
   * the state store is UNREACHABLE: rather than 5xx-ing the data path
   * because the control-plane database is sick, serve the last snapshot
   * this process saw.
   *
   * Why that is safe (and not merely convenient): the routing pointer
   * cannot move while the database is down, because `switchActive` is
   * its only writer and a promotion needs the very CAS that is failing.
   * So during an outage the cached pointer is not just tolerable, it is
   * still CORRECT. The remaining case is a partition where another
   * process CAN write while this one cannot: the pointer may then move
   * under us, but the old active it moved away from is being demoted
   * (put to sleep), so requests routed there fail upstream - exactly
   * what failing closed would have produced anyway. Fail-open therefore
   * strictly dominates.
   *
   * That argument rests entirely on "we have no evidence the routing
   * changed", so unreachability is the ONLY failure it licenses, and a
   * failing POINTER READ is what evidences it. Once the pointer read
   * succeeds the store is demonstrably reachable, and the two ways the
   * snapshot load can still fail are handled by `snapshotLoadFailed`
   * instead: a pointer whose revision MOVED (serving the old route
   * would defeat the promotion that just committed) and malformed
   * state (`fleetSnapshotSchema` rejecting corrupt jsonb) both fail
   * CLOSED.
   *
   * The TTL deliberately does NOT bound the stale path: capping it
   * would take a perfectly healthy inference path down because the
   * control database is unwell, which is the failure this exists to
   * prevent. A process with no cached snapshot for the fleet has
   * nothing to serve and reports `unavailable`.
   */
  async function cachedSnapshot(rawReference: string): Promise<SnapshotLookup> {
    // Cache keys and aliases are canonical: the database accepts a uuid
    // in either case but stores (and returns) the lowercase id, which is
    // what the cache is keyed by, so an uppercase reference must not miss
    // a warm cache. The STORE lookup keeps the raw string: its slug
    // fallback is case-SENSITIVE (slugs are lowercase by schema), so
    // lowercasing first would let an uppercase uuid that names no fleet
    // resolve to a fleet merely using the lowercase form as its slug.
    const reference = canonicalReference(rawReference);
    let pointer;
    try {
      pointer = await getFleetRoutePointer(database, rawReference);
    } catch (error) {
      // The state store is unreachable. This is the one failure the
      // fail-open argument covers, because it is also the proof that
      // the routing pointer cannot have moved.
      return failOpen(reference, error);
    }
    if (!pointer) {
      // The fleet genuinely does not exist. NOT the same signal as a
      // throw: never treat this as an outage. Forget it wholesale, or a
      // later outage would resurrect a deleted fleet's routing through
      // an alias this request did not use.
      forgetFleetByReference(reference);
      return { ok: false, reason: "not_found" };
    }
    if (isFleetIdShaped(reference) && pointer.id !== reference) {
      // A UUID-shaped reference that did NOT resolve by id proves no
      // fleet holds that id any more (the lookup is id-first), so it
      // fell through to a fleet that merely uses the string as its slug.
      // Anything still cached under that id belongs to a fleet that is
      // gone: quarantine it, or cachedFor's id-first fast path would
      // serve it during the next outage instead of the slug owner.
      forgetFleet(reference);
    }
    rememberFleetReference(reference, pointer.id);

    const nowMs = now().getTime();
    const hit = snapshotCache.get(pointer.id);
    // A number comparison on hit?.routeRevision narrows hit: equality
    // with a number can only hold when the entry exists.
    if (
      hit?.routeRevision === pointer.routeRevision &&
      hit.expiresAtMs > nowMs
    ) {
      markFresh(pointer.id);
      return { ok: true, snapshot: hit.snapshot, isStale: false };
    }

    let snapshot;
    try {
      snapshot = await getFleetSnapshot(database, pointer.id);
    } catch (error) {
      return snapshotLoadFailed(reference, pointer, hit, error);
    }
    if (!snapshot) {
      // The fleet vanished between the two reads.
      forgetFleet(pointer.id);
      return { ok: false, reason: "not_found" };
    }
    snapshotCache.set(pointer.id, {
      snapshot,
      routeRevision: snapshot.routeRevision,
      expiresAtMs: nowMs + snapshotCacheTtlMs,
    });
    // The snapshot reveals the fleet's other accepted reference form, so
    // a slug-warmed cache is reachable by uuid during an outage and vice
    // versa. A UUID-SHAPED slug is deliberately NOT indexed: the healthy
    // lookup resolves such a string by id first, and letting it alias the
    // slug's owner would route the id owner's traffic to the wrong fleet
    // during an outage (see isFleetIdShaped in @haru/db).
    if (!isFleetIdShaped(snapshot.slug)) {
      rememberFleetReference(snapshot.slug, snapshot.id);
    }
    markFresh(snapshot.id);
    return { ok: true, snapshot, isStale: false };
  }

  /** The store ANSWERED the pointer read, so it is reachable and the
   * fail-open argument does not apply. Only one narrow case may still
   * serve the cache. */
  function snapshotLoadFailed(
    reference: string,
    pointer: { id: string; routeRevision: number },
    hit: SnapshotCacheEntry | undefined,
    error: unknown,
  ): SnapshotLookup {
    const detail = error instanceof Error ? error.message : String(error);
    // Malformed state (fleetSnapshotSchema rejecting corrupt jsonb) is
    // deliberately surfaced by the repo layer. Serving stale routing on
    // top of it would mask a reachable-but-broken fleet indefinitely.
    // Matched by name, not `instanceof`, to keep zod out of the server's
    // dependencies for a single check.
    const isMalformedState =
      error instanceof Error && error.name === "ZodError";
    if (!isMalformedState && hit?.routeRevision === pointer.routeRevision) {
      // The pointer we just read matches the cached snapshot, so the
      // ROUTING is provably current: only the refresh of non-routing
      // state (slot states) failed. Serving it is the same trade the TTL
      // already makes.
      return markStale(reference, pointer.id, hit, detail);
    }
    // Either the pointer MOVED (a promotion committed; serving the old
    // active would defeat the very failover the pointer records) or the
    // state is corrupt, or we cached nothing. Fail closed - and QUARANTINE
    // the entry: we have now LEARNED that its routing is superseded (or
    // its fleet unusable), so a later pure outage must not resurrect it
    // through failOpen, which cannot tell a trustworthy entry from one we
    // already know is wrong.
    forgetFleet(pointer.id);
    console.error(
      `cannot load a fresh snapshot for fleet ${reference} (pointer revision ${String(pointer.routeRevision)}): ${detail}`,
    );
    return { ok: false, reason: "unavailable", detail };
  }

  /** Serve the last known snapshot for `reference`, or report that the
   * state store is unreachable and this process cached nothing usable
   * for that fleet. */
  function failOpen(reference: string, error: unknown): SnapshotLookup {
    const detail = error instanceof Error ? error.message : String(error);
    const cached = cachedFor(reference);
    if (!cached) {
      // Nothing cached for THIS fleet: a process that never saw it cannot
      // invent its routing. This is why the server must NOT be restarted
      // during a state-store outage, and why /healthz stays green (a
      // failing liveness probe would destroy the cache that is keeping
      // traffic alive).
      console.error(
        `state store unreachable and no cached routing for fleet ${reference}: ${detail}`,
      );
      return { ok: false, reason: "unavailable", detail };
    }
    return markStale(reference, cached.fleetId, cached.entry, detail);
  }

  /** Resolve a reference against the cache with the SAME id-first rule
   * the database lookup uses: a UUID-shaped reference is a fleet id
   * before it is anybody's slug. */
  function cachedFor(
    reference: string,
  ): { fleetId: string; entry: SnapshotCacheEntry } | undefined {
    if (isFleetIdShaped(reference)) {
      const byId = snapshotCache.get(reference);
      if (byId) {
        return { fleetId: reference, entry: byId };
      }
    }
    const fleetId = fleetIdByReference.get(reference);
    const entry =
      fleetId === undefined ? undefined : snapshotCache.get(fleetId);
    return fleetId !== undefined && entry !== undefined
      ? { fleetId, entry }
      : undefined;
  }

  function rememberFleetReference(reference: string, fleetId: string): void {
    const previous = fleetIdByReference.get(reference);
    if (previous !== undefined && previous !== fleetId) {
      // The reference now names a DIFFERENT fleet (the old one was
      // deleted and its slug reused). Whatever we cached for the previous
      // fleet is no longer reachable by any live reference, but it is
      // still keyed by its id - which cachedFor's id-first fast path
      // would happily serve during an outage.
      forgetFleet(previous);
    }
    fleetIdByReference.set(reference, fleetId);
  }

  /** Drop a fleet from every index. Used when the store reports the
   * fleet gone, and to quarantine an entry we have learned is unusable. */
  function forgetFleet(fleetId: string): void {
    snapshotCache.delete(fleetId);
    staleFleetIds.delete(fleetId);
    for (const [reference, id] of fleetIdByReference) {
      if (id === fleetId) {
        fleetIdByReference.delete(reference);
      }
    }
  }

  /** The store says this reference names no fleet. Leave NOTHING behind
   * that a later outage could serve: the alias, the entry keyed by the
   * reference itself (a uuid-shaped reference IS a fleet id), and any
   * cached fleet whose SLUG is that reference - uuid-shaped slugs are
   * deliberately never aliased, so only the snapshots know them. */
  function forgetFleetByReference(reference: string): void {
    const fleetId = fleetIdByReference.get(reference);
    fleetIdByReference.delete(reference);
    if (fleetId !== undefined) {
      forgetFleet(fleetId);
    }
    if (isFleetIdShaped(reference)) {
      forgetFleet(reference);
    }
    const slugOwners = [...snapshotCache]
      .filter(([, entry]) => entry.snapshot.slug === reference)
      .map(([id]) => id);
    for (const id of slugOwners) {
      forgetFleet(id);
    }
  }

  function markStale(
    reference: string,
    fleetId: string,
    hit: SnapshotCacheEntry,
    detail: string,
  ): SnapshotLookup {
    if (!staleFleetIds.has(fleetId)) {
      staleFleetIds.add(fleetId);
      console.warn(
        `serving fleet ${reference} from the last known routing (revision ${String(hit.routeRevision)}): ${detail}`,
      );
    }
    return { ok: true, snapshot: hit.snapshot, isStale: true };
  }

  function markFresh(fleetId: string): void {
    if (staleFleetIds.delete(fleetId)) {
      console.warn(`state store reachable again; fleet ${fleetId} is fresh`);
    }
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
        } satisfies PromoteNoopResponse,
      };
    }
    if (decision.type === "invalid_target") {
      return {
        status: 422,
        body: errorBody("invalid_target", decision.reason),
      };
    }
    // The old-active pointer (sourceDomainId) is captured atomically
    // inside the insert; passing this handler's snapshot value could
    // record a stale active if another operation just completed.
    const result = await createOperation(database, {
      fleetId: snapshot.id,
      kind,
      targetDomainId,
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
      } satisfies OperationAcceptedResponse,
    };
  }

  app.post("/v1/fleets/:fleetId/promote", async (c) => {
    const body: unknown = await readJsonBody(c.req, null);
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
    const body: unknown = await readJsonBody(c.req, null);
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

  app.post(
    "/v1/chat/completions",
    // Bound the body BEFORE the handler buffers it (runs after the
    // /v1/* bearer gate, so unauthenticated requests never allocate).
    bodyLimit({
      maxSize: chatMaxBodyBytes,
      onError: (c) =>
        c.json(
          errorBody(
            "payload_too_large",
            `request body exceeds the ${String(chatMaxBodyBytes)}-byte limit`,
          ),
          413,
        ),
    }),
    async (c) => {
      const fleetReference =
        c.req.header("x-haru-fleet") ?? config.defaultFleet;
      if (fleetReference === undefined || fleetReference === "") {
        return c.json(
          errorBody(
            "fleet_not_found",
            "no fleet specified: set the X-Haru-Fleet header or configure a default fleet",
          ),
          404,
        );
      }
      const lookup = await cachedSnapshot(fleetReference);
      if (!lookup.ok) {
        if (lookup.reason === "not_found") {
          return c.json(errorBody("fleet_not_found", "no such fleet"), 404);
        }
        // Fail-open had nothing usable to fall back on.
        return c.json(
          errorBody(
            "state_store_unavailable",
            `cannot resolve routing for fleet ${fleetReference} from the state store, and this process has no usable cached routing for it`,
          ),
          503,
        );
      }
      const { snapshot, isStale } = lookup;
      if (isStale) {
        // Applies to every c.json() response below; the proxied and 499
        // responses set it on their own Response objects.
        c.header(STALE_ROUTING_HEADER, "stale");
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
      if (!active || !isRoutableDomainState(active)) {
        return c.json(
          errorBody(
            "no_active_domain",
            "the fleet has no routable active domain",
          ),
          503,
        );
      }

      // Same per-model routability predicate route intent reports, so
      // haru's own ingress and external routing consumers agree.
      const binding = findRoutableBinding(active, model);
      if (!binding) {
        const available = routableModels(active)
          .filter((m) => m.eligible)
          .map((m) => m.name)
          .join(", ");
        return c.json(
          errorBody(
            "model_not_found",
            `model ${model} is not served by the active domain (available: ${available})`,
          ),
          404,
        );
      }

      const result = await proxyChatCompletion(
        chatFetchFunction,
        binding.servingUrl,
        bodyText,
        chatHeaderTimeoutMs,
        // Propagate a pre-header client disconnect to the upstream so an
        // abandoned request stops generating immediately.
        c.req.raw.signal,
      );
      if (!result.ok) {
        if (result.status === 499) {
          // The client is gone; a bare nginx-style 499 for logs/tests.
          const aborted = new Response(null, { status: 499 });
          if (isStale) {
            aborted.headers.set(STALE_ROUTING_HEADER, "stale");
          }
          return aborted;
        }
        return c.json(result.body, result.status);
      }
      if (isStale) {
        // The proxy CONSTRUCTS this Response (it does not hand back the
        // upstream one), so its headers are mutable.
        result.response.headers.set(STALE_ROUTING_HEADER, "stale");
      }
      return result.response;
    },
  );

  return app;
}
