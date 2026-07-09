# Known issues and deferred work

This file tracks defects and debt that were **found and deliberately
deferred** during the initial-slice review, so they don't have to be
rediscovered. Operator-facing behavioral limits live in the README's
"Known limitations" section; this file is the contributor-facing
companion with file references and suggested fixes.

[日本語版](KNOWN_ISSUES.ja.md)

Conventions: each entry states the current behavior, why it was
deferred, and the intended fix. Entries should be deleted when fixed.

## Correctness-adjacent (behavioral limits, by design for this slice)

### No auto-failover when the active domain's vLLM dies but its supervisor survives

- Where: `services/haru-server/src/reconciler/reconciler.ts`
  (`pollHeartbeats`, `detectFailover` in `packages/core/src/failover.ts`).
- Current: a reachable-but-not-ready ACTIVE domain is transitioned to
  `degraded` (visible in route-intent eligibility), and nothing ever
  writes domain state `failed`, so `detectFailover`'s `failed` branch
  is currently unreachable; auto-failover fires only on heartbeat
  staleness.
- Why deferred: promoting away from a *transiently* not-ready active
  needs a debounce policy (a `degradedGraceMs`-style knob and/or a
  `failed` escalation rule) that deserves its own design pass;
  reacting to route-intent eligibility externally covers the gap.
- Intended fix: add a policy-driven escalation
  (`degraded for > N ms` → `failed`) so the existing `failed` trigger
  becomes reachable, then delete this entry.

### Client aborts are not propagated upstream before response headers

- Where: `services/haru-server/src/chat-proxy.ts`,
  `services/haru-server/src/app.ts` (chat route).
- Current: the upstream fetch is aborted only by the TTFB timer; a
  client that disconnects pre-headers (notably during a long
  non-streaming generation) leaves the upstream request running until
  headers arrive or the timer fires. Mid-stream disconnects DO
  propagate (the passthrough body stream is cancelled).
- Why deferred: needs `AbortSignal.any([timer.signal, c.req.raw.signal])`
  plus tests for both phases; bounded waste in the meantime (one TTFB
  window per abandoned request).
- Intended fix: combine the request signal with the timeout signal in
  `proxyChatCompletion`.

### Slot/domain state tables in @haru/core are not enforced at runtime

- Where: `packages/core/src/slot-state.ts`,
  `packages/core/src/domain-state.ts` vs the literal from-state lists
  in `services/haru-server/src/reconciler/steps.ts` and
  `packages/db/src/repo/slots.ts` / `domains.ts`.
- Current: `canTransitionSlot` / `assertSlotTransition` have no
  production callers, and the reconciler intentionally performs edges
  the tables do not list: `failed → waking` (wake retry after a failed
  promotion), `probing|waking|starting → sleeping` (demote cleanup),
  `stopping|training → idle` (stop completion). The DB CAS guards
  ("from" lists) are the executed truth.
- Why deferred: naively wiring `assertSlotTransition` into the repo
  layer would break promotion retry and demote cleanup. The tables
  and the executors must be reconciled together (either add the
  recovery/cleanup edges to the tables and derive the executors'
  from-lists from them, or drop the tables' claim to authority).
- Intended fix: extend the core tables with the recovery edges, derive
  every `transitionDomainSlots` from-list via
  "states with an edge to X", and enforce in the repo layer. Until
  then, treat the executors as the source of truth.

### Route-intent eligibility and chat-proxy routing use different predicates

- Where: `packages/core/src/route-intent.ts` (`isDomainRoutable`:
  every inference slot serving + `servingBaseUrl` set) vs the chat
  route in `services/haru-server/src/app.ts` (domain ready|degraded +
  the *requested model's* slot serving).
- Current: a domain with one failed slot is `eligible: false` in route
  intent while the chat proxy still serves its healthy models, so
  external routing consumers and haru's own ingress can disagree.
- Why deferred: which semantic is right is a product decision
  (all-or-nothing routability vs per-model degradation); the chat
  proxy's per-model behavior is arguably the better one.
- Intended fix: make core own a per-binding routability helper used by
  both, and extend `RouteIntent` with per-model eligibility.

### Auto-failover picks the first promotable standby in slug order

- Where: `packages/core/src/failover.ts` (`detectFailover`),
  ordering supplied by `packages/db/src/repo/snapshots.ts`
  (`orderBy(domains.slug)`); `buildRouteIntent`'s single `standby`
  field has the same first-non-active bias.
- Current: standby choice (and the reported standby target) is an
  implicit artifact of slug sort, not a health/readiness ranking.
- Why deferred: fine for the two-domain slice (there is only one
  standby); a ranking policy belongs with 3+-domain support.
- Intended fix: explicit standby ranking in core (state, last seen,
  optionally probe freshness) and a `standbys: RouteTarget[]` shape.

## Test validity

### PGlite serializes "concurrent" CAS tests

- Where: `packages/db/src/cas.test.ts`,
  `packages/db/src/operations.test.ts` (Promise.all races),
  harness in `packages/db/src/testing/index.ts`.
- Current: PGlite is single-connection, so the `Promise.all` races
  execute sequentially; the tests prove winner/loser CAS semantics
  under interleaving but NOT row-lock wait + predicate re-evaluation
  under true concurrency. The production statements are single
  `UPDATE ... WHERE` (atomic under READ COMMITTED on Neon), so the
  design is sound, but the tests cannot catch a refactor that splits
  a CAS into read-then-write.
- Intended fix: an optional integration lane against a real Postgres
  (service container in CI) running the same suites.

## Efficiency backlog (correctness unaffected)

All are Neon-HTTP round-trip or wall-clock waste; none corrupt state.

- **Sequential heartbeat polls** — `reconciler.ts pollHeartbeats`
  awaits domains one by one (5s timeout each): N unreachable domains
  cost N×5s per tick. Fix: `Promise.allSettled` over domains.
- **Snapshot loaded twice per tick** — `reconcileFleet` reloads the
  full snapshot after heartbeats even when nothing changed. Fix:
  patch the in-memory snapshot with the heartbeat results, or reload
  only when a CAS changed a row.
- **getFleetSnapshot is 3 sequential SELECTs** — fleet → domains →
  slots (`packages/db/src/repo/snapshots.ts`); the chat proxy pays
  this on every cache miss. Fix: subquery/join for slots, parallelize
  with the domains query.
- **Operation row re-read up to 3× per tick** —
  `advanceInFlightOperation` re-selects what `getInFlightOperation`
  returned and re-reads again for the return value. Fix: widen
  `claimOperation`'s `.returning()` to the full row and reuse rows.
- **Unconditional mirror UPDATEs per nudge** — `stop_training` /
  `wake_vllm` issue their DB mirror transition on every retry (0-row
  UPDATE per tick while pending). Fix: consult the tick's snapshot
  slot states before writing.
- **Supervisor status polls are sequential across slots** —
  `services/haru-supervisor/src/app.ts slotStatuses` runs
  `Promise.all` per slot but slots serially. Fix: flatten to a single
  `Promise.all`.
- **Sleep/wake fan-out is sequential per model** — the supervisor
  awaits each model's sleep/wake; multi-model hosts can exceed the
  reconciler's 10s nudge timeout and rely on idempotent retries. Fix:
  `Promise.allSettled` over models (keep the collect-all-failures
  behavior added for error envelopes).
- **PGlite boot per test** — every DB-backed test's `beforeEach` boots
  a fresh PGlite and replays migrations (~1s each; the dominant cost
  of `pnpm test`). Fix: per-file `beforeAll` + per-test TRUNCATE, or
  `dumpDataDir`/`loadDataDir` cloning.

## Duplication / dead code backlog

- **Bearer auth duplicated across the two services** —
  `services/haru-server/src/auth.ts` vs the inline middleware +
  `isSameSecret` in `services/haru-supervisor/src/app.ts`. This is a
  security boundary: hardening one side can silently miss the other.
  Fix: hoist `isSameSecret` + a framework-agnostic bearer check into
  `@haru/protocol` (node:crypto only, respects the supervisor's
  protocol-only dependency rule).
- **readJsonBody duplicated with a load-bearing difference** —
  haru-server maps malformed JSON to `null` (required-field schemas
  reject it), the supervisor maps it to `{}` (all-optional schemas
  accept body-less POSTs). Fix: one helper in `@haru/protocol` with
  the fallback as a parameter, so the difference is explicit.
- **`runSky` + temp-YAML writer + timeout defaults duplicated across
  drivers** — `packages/driver-skypilot/src/driver.ts` vs
  `packages/driver-skyserve/src/driver.ts`. Fix: hoist a
  `createSkyRunner(exec, timeouts)` and `writeTempYaml` next to the
  shared exec module.
- **execFile wrapper duplicated** — `packages/driver-skypilot/src/exec.ts`
  (`defaultExec`) vs `services/haru-supervisor/src/main.ts`
  (`realExec`); options already diverge (maxBuffer vs timeout). Fix:
  hoist into `@haru/protocol` (builtin-only).
- **AbortController+timer fetch scaffolding hand-rolled 4×** —
  supervisor-client, chat-proxy, vllm-client, probe. Fix: a
  `fetchWithTimeout` helper in `@haru/protocol`; keep per-site error
  mapping local.
- **Test helpers duplicated** — `requestTarget` (haru-server fake
  helper vs supervisor app.test) and the fleet-example JSON loader
  (three db test files). Fix: shared test util next to
  `@haru/db/testing`.
- **Write-only `operations.attempt` column** — incremented per pending
  nudge (`bumpAttempt`), reset on claim/advance, read by nothing
  (step give-up is wall-clock). Fix: drop it, or record nudges in the
  events stream if the observability is wanted.
- **Unused protocol exports** — `promoteNoopResponseSchema`,
  `operationAcceptedResponseSchema`, `readyResponseSchema`,
  `apiErrorBodySchema` have no consumers; the servers build response
  literals inline. Fix: type the literals with
  `satisfies`-based checks against these schemas' types, or delete
  them (they are the published wire contract, so prefer wiring).
- **`snapshotCacheTtlMs` knob has no setter** — `AppConfig` exposes it
  but no env var wires it (unlike `chatHeaderTimeoutMs`); the cache is
  also keyed by the raw fleet reference, so slug and UUID entries
  expire independently. Fix: wire an env var or inline the constant;
  canonicalize the cache key.
- **Reconciler timeout path duplicates the outcome switch** —
  `handleStepTimeout`'s advance/complete and fail/cleanup blocks
  mirror the `executeStep` outcome handling. Fix: convert timeouts
  into a `StepOutcome` and flow through one path (audit events then
  become uniform; today a timeout-advanced best-effort step emits no
  `operation.step.done`).
- **SupervisorError→outcome mapping repeated per executor** — the
  try/catch in every step executor (8×) funnels through
  `supervisorFailure` now, but the targetDomain/options preamble is
  still copied per executor. Fix: a `withTargetSupervisor` wrapper.
