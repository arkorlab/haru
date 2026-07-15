# Known issues and deferred work

This file tracks defects and debt that were **found and deliberately
deferred** during review, so they don't have to be rediscovered.
Operator-facing behavioral limits live in the README's "Known
limitations" section; this file is the contributor-facing companion
with file references and suggested fixes.

[日本語版](KNOWN_ISSUES.ja.md)

Conventions: each entry states the current behavior, why it was
deferred, and the intended fix. Entries should be deleted when fixed.

## Deferred (post-review backlog)

### Chat snapshot cache has no size cap

- Where: `services/haru-server/src/app.ts` (`snapshotCache`, plus the
  `fleetIdByReference` and `forgottenGenerations` maps that share its
  lifetime).
- Current: entries are dropped when the store reports the fleet gone,
  and quarantined when they are learned to be unusable (`forgetFleet`),
  but a fleet that simply stops being queried pins its last
  FleetSnapshot for process lifetime. Bounded by the number of distinct
  fleets ever served.
- Why deferred: fleets are few and long-lived in this slice.
- Intended fix: a small LRU cap. Careful: eviction must stay driven by
  what the store SAYS (a null lookup, an unusable snapshot), never by a
  lookup that THROWS - a throw means the store is unreachable and the
  entry is exactly what the chat proxy's fail-open path serves from
  (see `failOpen` in the same file).

### Outage detection latency on the chat path is unbounded

- Where: `services/haru-server/src/app.ts` (`cachedSnapshot` calling
  `getFleetRoutePointer`).
- Current: the pointer read has no timeout or AbortSignal and there is
  no memoized outage state, so during a hang-mode outage (the store
  accepts TCP but never answers) every chat request waits for the
  transport's own failure before fail-open engages, potentially the
  full undici header timeout, paid per request as time-to-first-byte.
  A fast-fail outage (connection refused) is near-instant and
  unaffected.
- Why deferred: a detection bound is a design decision (fixed budget
  vs config knob vs circuit breaker) and this slice deliberately adds
  no new env knobs; the common outage mode (endpoint down) fails fast.
- Intended fix: a small fixed AbortSignal budget around the pointer
  read (well above healthy p99), optionally with a short-lived "store
  is down" memo so consecutive requests skip straight to the cache.
  Both must preserve the rule that only a FAILING pointer read
  licenses fail-open.

### Fail-closed chat errors log once per request

- Where: `services/haru-server/src/app.ts` (`failOpen` cold-cache
  branch and `snapshotLoadFailed`).
- Current: stale-serving transitions are deduplicated via
  `staleFleetIds`, but the two fail-closed 503 paths `console.error`
  on every request: an outage with a cold (or quarantined) fleet logs
  per request, and a fleet with corrupt persisted state logs per
  reload attempt until the data is repaired.
- Why deferred: dedup needs per-reference bookkeeping with a clearing
  rule; the flood only occurs while requests are already failing.
- Intended fix: transition-style logging keyed by reference (log on
  first failure, clear on the next success), mirroring
  `staleFleetIds`.

### A partial pointer read discards the id-disclaimed half of its verdict

- Where: `packages/db/src/repo/snapshots.ts` (`lookupFleetByReference`)
  as consumed by `cachedSnapshot` / `failOpen` in
  `services/haru-server/src/app.ts`.
- Current: a UUID-shaped reference runs two sequential queries. When
  the by-id query succeeds with an empty result (the store just
  disclaimed the id) and the slug-fallback query then throws, the
  caller sees only a throw and fails open, so the id-first cache probe
  can serve a fleet the store disclaimed one query earlier.
- Why deferred: it needs the store to die between the two sub-queries
  of a single request AND the reference to name a just-deleted fleet
  this process still has cached; the next successful read heals the
  cache.
- Intended fix: surface partial evidence from the pointer read (a
  typed error carrying "the id half was disclaimed") so `failOpen` can
  skip the id-keyed probe while still honoring the alias path.

### Cache-miss path refetches the fleet row

- Where: `services/haru-server/src/app.ts` (`cachedSnapshot`) calling
  `getFleetSnapshot` after `getFleetRoutePointer`.
- Current: on a cache miss the fleet row is read twice (once narrow,
  once full inside the snapshot); one extra SELECT per fleet per TTL
  window.
- Why deferred: the hot path (cache hit) is already minimal; misses
  are bounded by the TTL.
- Intended fix: an internal snapshot loader that accepts the
  already-fetched fleet row.

### A failed promotion leaves the target out of standby posture

- Where: `services/haru-server/src/reconciler/reconciler.ts`
  (`applyStepResolution` failure path, `markFailedPromotionSlots`).
- Current: a promote that failed AFTER waking the target (e.g.
  `probe_failed`) marks the target's inference slots failed and
  finishes. Nothing automatically puts the target back into standby
  posture (vLLM asleep + training running); a manual `POST
  /v1/fleets/:id/demote` of the target restores it. (A failure AT
  `stop_training` is now handled:
  `failOperationWithPromotionCleanup` restores the target's `stopping`
  training slots to `training` in the same statement, so only the
  post-wake inference-slot case remains.)
- Why deferred: an automatic restore is a small operation of its own
  (sleep + start training with proofs); bolting it onto the failure
  path would run long supervisor calls outside the step machinery.
- Intended fix: enqueue a demote of the failed target after the
  operation fails (reusing the existing demote steps), or an operator
  runbook note until then.

### Re-applying a fleet layout never removes dropped domains or slots

- Where: `packages/db/src/repo/layout.ts` (`applyFleetLayout`).
- Current: layout apply is idempotent-additive (`ON CONFLICT DO
  NOTHING`): existing rows are left untouched and new ones inserted, so
  re-running a seed never resets live state. But a re-apply that DROPS
  a domain or slot from the layout does not delete the removed rows -
  they linger and can still be counted (e.g. a stale standby domain by
  `detectFailover`'s viable-standby predicate).
- Why deferred: deletion is not simple additive seeding - a dropped
  domain might be the live active pointer or mid-operation, so safe
  removal needs its own guarded teardown flow (and the drivers to
  release the cloud resource). The seed path is deliberately
  non-destructive.
- Intended fix: a separate declarative reconcile that diffs the layout
  against live rows and tears down removed domains/slots through the
  guarded state machine (never a bare DELETE), or an operator runbook
  for decommissioning until then.

### Postgres test lane replays migrations per test

- Where: `packages/db/src/testing/index.ts`
  (`createPostgresTestDatabase`).
- Current: every test creates a database and replays the full
  committed migration set; the PGlite lane got the migrate-once
  optimization but the CI lane did not.
- Why deferred: the migration set is currently a single squashed file,
  so the per-test cost is small.
- Intended fix: migrate one seed database per run, then
  `CREATE DATABASE ... TEMPLATE seed` per test (file-level copy skips
  the replay), dropping the seed in a global teardown.

### SkyServe status is scraped from the human CLI table

- Where: `packages/driver-skyserve/src/driver.ts`
  (`getServiceStatus`).
- Current: `sky serve status` has no machine-readable output flag
  (unlike `sky status --output json`), so the driver strips ANSI
  codes and matches the service's table row against the documented
  status vocabulary. A table-layout change across SkyPilot releases
  could break the row match (an unrecognized status already surfaces
  as a typed error).
- Why deferred: upstream offers nothing better today, and the
  reconciler does not drive SkyServe provisioning yet.
- Intended fix: switch to an output-format flag the moment upstream
  adds one to `sky serve status` (track the SkyPilot CLI reference).

### SkyPilot getDomainStatus may throw instead of returning null for an unknown cluster

- Where: `packages/driver-skypilot/src/driver.ts` (`getDomainStatus`).
- Current: the method returns `null` only when the cluster is absent
  from a SUCCESSFUL `sky status --output json` array. If `sky status`
  exits non-zero for an unknown cluster (unverified against the pinned
  version), `createSkyRunner` throws `SkyCliError` first, so a caller
  treating "not found" as `null` would instead see an exception.
- Why deferred: the exit semantics depend on the pinned SkyPilot
  version, and the reconciler does not drive SkyPilot provisioning yet.
- Intended fix: pin the "unknown cluster" behavior with a test against
  the documented version and, if it exits non-zero, map that one case
  to `null`.
