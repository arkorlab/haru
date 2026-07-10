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

### Chat TTFB bound is silently capped by undici's headersTimeout

- Where: `services/haru-server/src/chat-proxy.ts` via
  `fetchWithTimeout`; documented at the `HARU_CHAT_HEADER_TIMEOUT_MS`
  row in the README.
- Current: Node's built-in fetch (undici) enforces its own 300s
  headersTimeout. A configured TTFB bound above that dies at 300s with
  a TypeError ("fetch failed"), which the proxy maps to 502
  `upstream_unreachable` instead of 504.
- Why deferred: exceeding it needs a custom undici dispatcher (an
  extra dependency surface); sub-300s configs (the default is 30s) are
  unaffected.
- Intended fix: when a >300s bound is a real need, inject a dispatcher
  with `headersTimeout: 0` into the chat proxy's fetch and map undici's
  HeadersTimeoutError explicitly.

### defaultExec collapses spawn failures and timeout kills into exit 1

- Where: `packages/protocol/src/exec.ts`.
- Current: a missing binary (ENOENT) or a child killed by `timeoutMs`
  resolves as `{code: 1, stdout: "", stderr: ""}`; callers (verify_gpu,
  sky wrappers) report an empty-stderr "exited 1" that hides WHY.
- Why deferred: pre-existing behavior faithfully hoisted; changing the
  result shape touches every exec consumer's error mapping.
- Intended fix: extend `ExecResult` with `signal`/`errorMessage` fields
  populated from the execFile error and include them in the SkyCliError
  / gpu error strings.

### Chat snapshot cache entries are never evicted

- Where: `services/haru-server/src/app.ts` (`snapshotCache`).
- Current: entries are overwritten on next access but never deleted;
  a fleet that stops existing (or stops being queried) pins its last
  FleetSnapshot for process lifetime. Bounded by the number of distinct
  fleets ever served.
- Why deferred: fleets are few and long-lived in this slice; there is
  no fleet-delete API yet to hook.
- Intended fix: drop the entry when the per-request pointer lookup
  returns null, plus a small LRU cap.

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
- Current: a promote that stopped the target's training and then
  failed before `switch_active` (e.g. `probe_failed`) marks the
  target's inference slots failed and finishes. Nothing automatically
  puts the target back into standby posture (vLLM asleep + training
  running); a manual `POST /v1/fleets/:id/demote` of the target
  restores it.
- Why deferred: an automatic restore is a small operation of its own
  (sleep + start training with proofs); bolting it onto the failure
  path would run long supervisor calls outside the step machinery.
- Intended fix: enqueue a demote of the failed target after the
  operation fails (reusing the existing demote steps), or an operator
  runbook note until then.

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
