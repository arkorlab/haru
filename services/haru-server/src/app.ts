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
  MalformedFleetStateError,
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

/**
 * Body cap for the control POSTs (promote/demote). They carry a tiny
 * JSON object ({ targetDomainId }), but like the chat path they buffer
 * the whole body before validating it, so an authenticated caller could
 * otherwise stream an unbounded body straight into memory. 16 KiB is
 * generous for a UUID payload; the chat path keeps its own, larger,
 * configurable cap.
 */
const CONTROL_MAX_BODY_BYTES = 16 * 1024;

/** Shared 413 gate for the control POSTs, mirroring the chat path. */
const controlBodyLimit = bodyLimit({
  maxSize: CONTROL_MAX_BODY_BYTES,
  onError: (c) =>
    c.json(
      errorBody(
        "payload_too_large",
        `request body exceeds the ${String(CONTROL_MAX_BODY_BYTES)}-byte limit`,
      ),
      413,
    ),
});

/** Lowercase a UUID-shaped reference. Licensed ONLY for uuid-ID identity:
 * the database accepts a uuid in any case and returns the lowercase id the
 * fail-open cache is keyed by. Slug and alias identity is case-SENSITIVE
 * (slugs are lowercase by schema), so a store verdict about one spelling
 * says nothing about a fleet whose SLUG is the lowercase form - never
 * canonicalize a reference before a slug-side operation. */
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
  // Bumped per fleet by forgetFleet. A snapshot load that started
  // before a forget of ITS fleet must not publish its result: the
  // forget was a store verdict (fleet gone, routing superseded) that
  // the in-flight read predates. Scoped per fleet so an unrelated
  // eviction cannot suppress a concurrent publish - a suppressed
  // publish is only a cache miss, but a miss right before an outage is
  // a lost fail-open. Grows with distinct forgotten fleet ids, the
  // same order as the cache itself (see KNOWN_ISSUES: no size cap).
  const forgottenGenerations = new Map<string, number>();
  // The same later-knowledge-wins rule for the ALIAS map: bumped per
  // REFERENCE whenever a pointer-read verdict is applied for that
  // spelling (an alias learned/rebound, or the spelling reported gone).
  // A pointer read that started before a newer request applied its
  // verdict for the same reference must not apply its own - a delayed
  // stale read for a reused slug would otherwise evict (and
  // generation-quarantine) the LIVE fleet's cache the newer request
  // just published, losing fail-open for it. The response is still
  // built from the stale read's own data; only the map keeps the later
  // knowledge. Same lifetime/growth class as the maps above.
  const referenceVerdictGenerations = new Map<string, number>();

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
    // The raw spelling and the canonical (lowercased-if-uuid-shaped) form
    // are deliberately BOTH in play, per role: uuid-ID identity is
    // case-insensitive, so id-keyed cache operations use the canonical
    // form; slug and alias identity is case-sensitive, so the store
    // lookup, the alias map and slug-side evictions always use the raw
    // string. Mixing them up lets a verdict about one spelling evict or
    // serve a fleet the store was never asked about.
    const canonical = canonicalReference(rawReference);
    // Captured BEFORE the pointer read: a verdict this read yields is
    // applied to the alias map only if no newer request applied its own
    // verdict for the same spelling while ours was in flight.
    const referenceGenerationBeforeRead =
      referenceVerdictGenerations.get(rawReference) ?? 0;
    const isReferenceVerdictStale = () =>
      (referenceVerdictGenerations.get(rawReference) ?? 0) !==
      referenceGenerationBeforeRead;
    let pointer;
    try {
      pointer = await getFleetRoutePointer(database, rawReference);
    } catch (error) {
      // The state store is unreachable. This is the one failure the
      // fail-open argument covers, because it is also the proof that
      // the routing pointer cannot have moved.
      return failOpen(rawReference, error);
    }
    if (!pointer) {
      // The fleet genuinely does not exist. NOT the same signal as a
      // throw: never treat this as an outage. Forget everything this RAW
      // spelling can name, or a later outage would resurrect a deleted
      // fleet's routing through an alias this request did not use -
      // UNLESS a newer request already applied fresher knowledge for
      // this spelling (our delayed verdict must not evict it).
      if (!isReferenceVerdictStale()) {
        forgetFleetByReference(rawReference);
      }
      return { ok: false, reason: "not_found" };
    }
    if (isFleetIdShaped(rawReference) && pointer.id !== canonical) {
      // A UUID-shaped reference that did NOT resolve by id proves no
      // fleet holds that id any more (the lookup is id-first), so it
      // fell through to a fleet that merely uses the string as its slug.
      // Anything still cached under that id belongs to a fleet that is
      // gone: quarantine it, or cachedFor's id-first fast path would
      // serve it during the next outage instead of the slug owner.
      forgetFleet(canonical);
    }
    if (pointer.id !== canonical && !isReferenceVerdictStale()) {
      // Learn the alias only when the reference is not the fleet id
      // itself: cachedFor's id-first probe already reaches the entry
      // from either uuid spelling, so a self-alias would be dead weight.
      // Skipped when a newer request already applied its verdict for
      // this spelling: a delayed read for a rebound slug would rebind
      // the alias to a stale fleet and evict the live one's cache.
      rememberFleetReference(rawReference, pointer.id);
    }

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

    const generationBeforeLoad = forgottenGenerations.get(pointer.id) ?? 0;
    let snapshot;
    try {
      snapshot = await getFleetSnapshot(database, pointer.id);
    } catch (error) {
      return snapshotLoadFailed(rawReference, pointer, error);
    }
    if (snapshot?.id !== pointer.id) {
      // The fleet vanished between the two reads. A slug-fallback hit on
      // a DIFFERENT fleet proves the same thing (nobody holds this id),
      // and its snapshot must never be cached under an id it does not
      // own: nothing but a not_found observed through the right spelling
      // could ever evict it.
      forgetFleet(pointer.id);
      return { ok: false, reason: "not_found" };
    }
    // Publish only when this load did not lose a race: a forget while
    // our reads were in flight was a store verdict (fleet gone, routing
    // superseded) that the read predates, and a concurrent request may
    // have cached a NEWER revision than the one we started loading.
    // Either way the map must keep the later knowledge; the response
    // built from this snapshot is still fine.
    const existing = snapshotCache.get(pointer.id);
    const didLoseRace =
      (forgottenGenerations.get(pointer.id) ?? 0) !== generationBeforeLoad ||
      (existing !== undefined &&
        existing.routeRevision > snapshot.routeRevision);
    if (!didLoseRace) {
      snapshotCache.set(pointer.id, {
        snapshot,
        routeRevision: snapshot.routeRevision,
        expiresAtMs: nowMs + snapshotCacheTtlMs,
      });
      // The snapshot reveals the fleet's other accepted reference form,
      // so a slug-warmed cache is reachable by uuid during an outage and
      // vice versa. A UUID-SHAPED slug is deliberately NOT indexed: the
      // healthy lookup resolves such a string by id first, and letting
      // it alias the slug's owner would route the id owner's traffic to
      // the wrong fleet during an outage (see isFleetIdShaped in
      // @haru/db).
      if (!isFleetIdShaped(snapshot.slug)) {
        rememberFleetReference(snapshot.slug, snapshot.id);
      }
      markFresh(snapshot.id);
    }
    return { ok: true, snapshot, isStale: false };
  }

  /** The store ANSWERED the pointer read, so it is reachable and the
   * fail-open argument does not apply. Only one narrow case may still
   * serve the cache. */
  function snapshotLoadFailed(
    reference: string,
    pointer: { id: string; routeRevision: number },
    error: unknown,
  ): SnapshotLookup {
    const detail = error instanceof Error ? error.message : String(error);
    // Malformed state (fleetSnapshotSchema rejecting corrupt jsonb) is
    // deliberately surfaced by the repo layer as a typed error. Serving
    // stale routing on top of it would mask a reachable-but-broken fleet
    // indefinitely.
    const isMalformedState = error instanceof MalformedFleetStateError;
    // Judge the entry cached NOW, not one captured before the load: a
    // concurrent request may have refreshed it while our read was in
    // flight, and its fresh work must be neither bypassed nor evicted.
    const current = snapshotCache.get(pointer.id);
    if (!isMalformedState && current?.routeRevision === pointer.routeRevision) {
      // The pointer we just read matches the cached snapshot, so the
      // ROUTING is provably current: only the refresh of non-routing
      // state (slot states) failed. Serving it is the same trade the TTL
      // already makes.
      return markStale(reference, pointer.id, current, detail);
    }
    if (
      current === undefined ||
      current.routeRevision <= pointer.routeRevision
    ) {
      // Either the pointer MOVED (a promotion committed; serving the old
      // active would defeat the very failover the pointer records) or the
      // state is corrupt, or we cached nothing. Fail closed - and
      // QUARANTINE the entry: we have now LEARNED that its routing is
      // superseded (or its fleet unusable), so a later pure outage must
      // not resurrect it through failOpen, which cannot tell a
      // trustworthy entry from one we already know is wrong. An entry
      // whose revision is NEWER than the pointer we read is the one
      // exception: it was published from a later store state than ours,
      // and this verdict does not cover it.
      forgetFleet(pointer.id);
    }
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

  /** Resolve a RAW reference against the cache with the SAME rules the
   * database lookup uses: a UUID-shaped reference is a fleet id before
   * it is anybody's slug, and uuid identity alone is case-insensitive.
   * The alias fallback keeps the raw spelling because it stands in for
   * the store's case-SENSITIVE slug match: serving an uppercase
   * spelling the healthy store would 404 is inventing a resolution,
   * not preserving one. */
  function cachedFor(
    rawReference: string,
  ): { fleetId: string; entry: SnapshotCacheEntry } | undefined {
    if (isFleetIdShaped(rawReference)) {
      const canonical = rawReference.toLowerCase();
      const byId = snapshotCache.get(canonical);
      if (byId) {
        return { fleetId: canonical, entry: byId };
      }
    }
    const fleetId = fleetIdByReference.get(rawReference);
    const entry =
      fleetId === undefined ? undefined : snapshotCache.get(fleetId);
    return fleetId !== undefined && entry !== undefined
      ? { fleetId, entry }
      : undefined;
  }

  /** Record that a verdict was applied for this reference spelling, so
   * an in-flight pointer read that predates it will not apply its own. */
  function bumpReferenceVerdict(reference: string): void {
    referenceVerdictGenerations.set(
      reference,
      (referenceVerdictGenerations.get(reference) ?? 0) + 1,
    );
  }

  function rememberFleetReference(reference: string, fleetId: string): void {
    bumpReferenceVerdict(reference);
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
   * fleet gone, and to quarantine an entry we have learned is unusable.
   * Bumps the fleet's generation so an in-flight snapshot load that
   * predates the verdict cannot re-publish what was just dropped. */
  function forgetFleet(fleetId: string): void {
    forgottenGenerations.set(
      fleetId,
      (forgottenGenerations.get(fleetId) ?? 0) + 1,
    );
    snapshotCache.delete(fleetId);
    staleFleetIds.delete(fleetId);
    for (const [reference, id] of fleetIdByReference) {
      if (id === fleetId) {
        fleetIdByReference.delete(reference);
      }
    }
  }

  /** The store says this RAW reference spelling names no fleet. Leave
   * NOTHING behind that a later outage could serve through it: the
   * alias, the entry keyed by the id form (uuid identity is
   * case-insensitive, so that part of the verdict covers the canonical
   * spelling), and any cached fleet whose SLUG is that exact string -
   * uuid-shaped slugs are deliberately never aliased, so only the
   * snapshots know them. Slug identity is case-SENSITIVE: this must
   * receive the spelling the store actually judged, never a
   * canonicalized one, or a 404 for `0F5C...` would evict the live
   * fleet whose slug is the lowercase form. */
  function forgetFleetByReference(reference: string): void {
    bumpReferenceVerdict(reference);
    const fleetId = fleetIdByReference.get(reference);
    fleetIdByReference.delete(reference);
    if (fleetId !== undefined) {
      forgetFleet(fleetId);
    }
    if (isFleetIdShaped(reference)) {
      forgetFleet(reference.toLowerCase());
      // Only a UUID-SHAPED slug can be missing from the alias map (it is
      // never indexed); for any other spelling the alias above was the
      // only way in, so the scan would be dead work on every unknown-
      // fleet request.
      const slugOwners = [...snapshotCache]
        .filter(([, entry]) => entry.snapshot.slug === reference)
        .map(([id]) => id);
      for (const id of slugOwners) {
        forgetFleet(id);
      }
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
      // Neutral wording: a stale spell can also come from a failed
      // snapshot REFRESH while the store stayed reachable, so this must
      // not claim an outage ended.
      console.warn(`fleet ${fleetId} is serving fresh routing again`);
    }
  }

  const app = new Hono();

  // A client that aborts or truncates its upload before we respond
  // leaves nothing to send a body to. Reading such a request (in the
  // body-size gate or `c.req.text()`) rejects with the request signal
  // already aborted (@hono/node-server ties it to the socket), which
  // would otherwise reach Hono's default handler as a misleading 500;
  // answer with a bare nginx-style 499 instead. Still log it: a genuine
  // server fault that merely coincides with a client disconnect must not
  // vanish. Anything with a live client is a real 500.
  app.onError((error, c) => {
    if (c.req.raw.signal.aborted) {
      console.error("request aborted by the client:", error);
      return new Response(null, { status: 499 });
    }
    console.error("unhandled request error:", error);
    return c.json(errorBody("internal_error", "internal server error"), 500);
  });

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
    // Already lowercased by promote/demoteRequestSchema (uuids are
    // case-insensitive; core matches domain ids with strict `===`).
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

  app.post("/v1/fleets/:fleetId/promote", controlBodyLimit, async (c) => {
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

  app.post("/v1/fleets/:fleetId/demote", controlBodyLimit, async (c) => {
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
        // Fail-open had nothing usable to fall back on. The detail
        // distinguishes an unreachable store (transient, wait it out)
        // from malformed persisted state (permanent until repaired) for
        // the operator reading the response.
        return c.json(
          errorBody(
            "state_store_unavailable",
            `cannot resolve routing for fleet ${fleetReference} from the state store, and this process has no usable cached routing for it: ${lookup.detail}`,
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
      // parse only to extract the model name. A failed read here means
      // the client aborted/truncated the upload (the body-size gate above
      // has already buffered it, so this only rejects on a live abort);
      // the request signal is aborted, so app.onError maps it to a bare
      // 499, never the JSON-parse 400 below or a 500.
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
