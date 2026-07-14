# Haru Development Guide

> **Note:** Claude Code loads this file via `CLAUDE.md`.

## Commands

Root scripts fan out via Turbo (`^build` ordering in [turbo.json](turbo.json)):

```bash
pnpm install
pnpm build          # tsc -p tsconfig.build.json per package, topological
pnpm typecheck      # tsc --noEmit (TypeScript 7)
pnpm lint           # oxlint --type-aware --deny-warnings, then strict ESLint 10
pnpm format         # oxfmt --write (config in oxfmt.config.ts; md/yaml excluded)
pnpm format:check   # CI gate
pnpm test           # vitest everywhere (PGlite-backed DB/server suites)

pnpm db:generate    # drizzle-kit generate -> committed under packages/db/drizzle
pnpm db:push        # apply schema to $DATABASE_URL (Neon)
pnpm db:seed        # seed a fleet from a layout JSON (--config path or HARU_FLEET_LAYOUT)

pnpm dev --filter=@haru/server       # via turbo (^build deps first), then tsx watch
pnpm dev --filter=@haru/supervisor   # GPU-host agent; same ^build-then-watch shape
```

Run a single test file: `pnpm --filter <pkg> exec vitest run src/foo.test.ts`
(filter by name with `-t "name"`).

**Tests assume workspace deps are built.** Every package's `exports` points at
`dist/` only; `pnpm test` handles this via Turbo's `^build`, but a standalone
`pnpm --filter <pkg> exec vitest run` in a clean checkout needs a prior
`pnpm build`.

**Schema edits require `pnpm db:generate` in the same change.** The PGlite test
harness replays the committed migrations in `packages/db/drizzle/`, while
deploys use `db:push` from the schema files; CI has a drift gate
(`db:generate && git diff --exit-code packages/db/drizzle`) that fails the PR
if they diverge.

## Architecture

Haru is a GPU HAL for Active/Standby LLM inference fleets: the active domain
serves OpenAI-compatible traffic; the standby keeps vLLM in level-1 sleep
(weights in CPU RAM) and runs preemptible LoRA training in the freed VRAM.
Promotion = stop training (SIGTERM → grace → SIGKILL, never wait for a perfect
checkpoint) → verify VRAM release → wake vLLM → synthetic probe → flip the
routing pointer. See [README.md](README.md) for the full model and
[KNOWN_ISSUES.md](KNOWN_ISSUES.md) for reviewed-and-deferred work (add new
deferrals there; delete entries when fixed).

Dependency graph (enforce it when adding imports):

```
@haru/protocol (zod + node builtins; source of type truth: schemas, enums,
   │              joinUrl/fetchWithTimeout/exec/bearer-auth shared helpers)
   ├── @haru/core            pure logic, NO I/O (state tables, plans, route intent)
   │      └── @haru/db       Drizzle schema + CAS repositories (they ENFORCE the
   │                         core state tables) + PGlite/Postgres test harness
   ├── @haru/driver-skypilot / driver-skyserve   YAML renderers + `sky` CLI wrappers
   ├── services/haru-server  Hono API + reconciler + chat proxy (uses core/db/drivers)
   └── services/haru-supervisor  depends on protocol ONLY (deliberate) - anything
       shared with the server must be hoisted into @haru/protocol, never a new dep
```

### The concurrency model (read before touching db/ or reconciler/)

- **Every state transition is a single-statement compare-and-swap**
  (`UPDATE ... WHERE state IN (...) RETURNING`, row-count checked). The Neon
  HTTP driver has NO interactive transactions - `db.transaction()` typechecks
  on `HaruDatabase`, works on PGlite in tests, and **throws at runtime on
  Neon**. Never introduce it; never hold external work (supervisor HTTP,
  `sky` exec) between a read and its dependent write.
- `fleets.activeDomainId` is the single routing pointer; `switchActive` is the
  only writer and takes an optional `requireRunningOperationId` (single-
  statement EXISTS + `FOR UPDATE` guard) so a tick racing a concurrent
  timeout-failure cannot commit routing for a failed operation. That same
  statement also sets `operations.routingCommitted` on the driving operation,
  atomically with the pointer move: the `failOperation` `target_not_routed`
  guard keys off THAT column (not a `fleets`-pointer subquery) because under
  READ COMMITTED a fail blocked on the locked operation row re-checks the row's
  own columns on unblock but keeps its snapshot for correlated subqueries - so
  a pointer subquery would let a fail land on a promotion that already went
  live (the switch-commits-first race).
- `operations` has a partial unique index enforcing one in-flight operation
  per fleet; `createOperation` joins the in-flight row on conflict.
  `sourceDomainId` records the active pointer at creation - post-commit
  cleanup steps act on it, never on "the other domain".
- The reconciler is **re-entrant check-and-nudge**: one step nudge per tick,
  every executor safe to re-run, long operations converge via status polls.
  Executor outcomes and step timeouts both map into one `StepResolution`
  applied by a single CAS-then-audit path (`applyStepResolution`); only the
  tick whose advance/complete/fail CAS lands degrades domains, cleans up
  slots, and writes audit events. A `pending` nudge writes nothing to the
  OPERATION row (executors may still issue their guarded slot mirror CAS on
  the way to pending).
  `stepStartedAt` and `domains.stateUpdatedAt` are written with the injected
  app clock (not `sql\`now()\``) because step timeouts and the degraded
  escalation compare against `dependencies.now()` - keep it that way or
  DB/host clock skew shifts every budget.
- Supervisor call failures map through `withSupervisor`: 401/403 on a target
  domain fail the step immediately (`supervisor_unauthorized`); everything
  else (network, timeout, schema-invalid body) is `pending` until the policy
  budget expires, and best-effort "source" steps treat even auth failures as
  pending (the old active may be torn down). Response parsing must stay
  inside the SupervisorError wrapping - a raw ZodError would abort the whole
  reconcile tick.
- The state tables in `@haru/core` (slot-state.ts, domain-state.ts) are the
  **enforced single source of truth**: the DB repo layer asserts every
  (from, to) pair (`InvalidTransitionError` on violation), and
  `reconciler/steps.ts` derives shared from-lists via `statesWithEdgeTo`.
  From-lists that are deliberately NARROWER than the table's predecessor set
  stay literal at the call site with a "why" comment - keep new ones that way.
- Degraded escalation: an ACTIVE domain that stays `degraded` past
  `policy.degradedGraceMs` (autoFailover on, AND a viable standby exists -
  viable means READY, supervised, bound, fresh-heartbeat, no failed
  inference slot - AND no operation is in flight AND the pointer still
  targets it; the in-flight, pointer AND viable-standby guards all ride
  inside the escalation UPDATE itself) is CAS-escalated to `failed`,
  which makes `detectFailover`'s failed trigger fire in the same tick; a
  reachable supervisor recovers a failed domain via `failed -> degraded`
  (the active additionally has to serve every LAYOUT-bound model, not
  just report its own aggregate ready flag).
  Heartbeats also mirror per-slot health from supervisor status (per-slot
  CAS, steady-state pairs only): the ACTIVE domain's inference
  `serving <-> failed`, a STANDBY's `sleeping <-> failed` posture, and
  training `training <-> idle` on every role (a running report without a
  PID never counts - that is the async spawn-failure window).
- Completion checks over supervisor-reported lists must guard the empty case
  (`length > 0 && every(...)`) - a drifted supervisor config must not make a
  step vacuously succeed.

### Boundaries that must not be weakened

- vLLM's sleep/wake admin endpoints are **127.0.0.1-only, private** (servers
  run with `--enable-sleep-mode` + `VLLM_SERVER_DEV_MODE=1`). The supervisor's
  bearer-authenticated API is the only external control surface, and the chat
  proxy only ever constructs `/v1/chat/completions` paths.
- The chat proxy forwards the request body as **raw text** (byte-identical,
  vendor extensions survive) and copies only `content-type` back (plus
  `X-Haru-Routing: stale` on the fail-open path); the abort timer bounds TTFB
  only, never the streaming body, and a pre-header client disconnect aborts
  the upstream (bare 499 back). `model` is a lowercase routing key
  (schema-enforced on bindings) resolved through the same per-model predicate
  route intent reports (`findRoutableBinding` in core).
- **The DATA path fails open, the CONTROL path fails closed.** When the state
  store is unreachable, `cachedSnapshot` serves the last snapshot this process
  saw (`X-Haru-Routing: stale`; `503 state_store_unavailable` only on a cold
  cache), because the routing pointer CANNOT move while the database is down -
  `switchActive` needs the very CAS that is failing - so the cached route is
  still correct. The TTL deliberately does not bound that path. Control routes
  (route-intent, fleet GET, promote/demote/reconcile) keep failing. Two
  corollaries: `/healthz` must never touch the database (a red liveness probe
  would restart the process and destroy the cache that is keeping traffic
  alive), and a thrown pointer lookup must never be conflated with a `null`
  one (`null` = the fleet is gone, evictable; a throw = the store is down,
  keep the entry).
- Outbound URLs are built with `joinUrl` from `@haru/protocol`.
  `new URL("/path", base)` silently drops a path prefix on `base` - don't
  reintroduce it.
- Drivers never call cloud APIs: placement is data translated to
  SkyPilot/SkyServe YAML by pure renderers, executed through an injectable
  `exec` (argv arrays, no shell). `domains.provider = "static"` bypasses
  drivers entirely and is what makes the control loop runnable without GPUs;
  the reconciler does not drive skypilot/skyserve provisioning yet.
- Training child processes must wire BOTH `exit` and `error` on `ChildHandle` -
  a spawn failure emits `error` (no `exit`), and an unlistened `error`
  event kills the whole supervisor.
- This repository is written to be publishable: nothing in code, comments,
  tests, or docs may reference the private repositories or infrastructure of
  its consumers, and no specific model or GPU names belong in code, seeds, or
  example layouts (workloads are pure data).

### Testing conventions

Everything runs without GPUs, cloud accounts, or a live database:

- `@haru/db/testing` (`createTestDatabase`) boots in-memory PGlite with the
  committed migrations applied (replayed once per vitest worker, then cloned
  via a dumped data dir - do not re-add per-test `migrate` calls), so CAS
  repository tests execute real SQL. PGlite is single-connection:
  `Promise.all` "races" serialize, proving winner/loser semantics but not
  true lock contention - that is covered by the CI `test-postgres` lane,
  which sets `HARU_TEST_DATABASE_URL` and runs the same suites against a
  real Postgres (one throwaway database per test). `loadExampleFleetLayout`
  is the shared example-layout loader for tests.
- All I/O is injectable (fetch, exec, spawn, clock); server tests drive the
  Hono app with `app.request()` against scripted fake supervisors
  (`fake-supervisor.test-helper.ts`); the supervisor uses fake timers for the
  SIGTERM → grace → SIGKILL escalation.
- State-machine changes must extend the exhaustive transition-table tests in
  `@haru/core` (every (from, to) pair asserted).

## Tooling gotchas

- **Two TypeScripts on purpose**: packages compile with TypeScript 7 (default
  catalog; currently pinned `7.0.1-rc` - see the dated comment in
  [pnpm-workspace.yaml](pnpm-workspace.yaml) about bumping to `^7.0.2`); the
  workspace root installs TypeScript 6.0.3 (`catalog:tseslint`) solely for
  typescript-eslint, whose peer range is still `<6.1.0`. Drop the extra copy
  when typescript-eslint supports TS 7.
- **Single root config for each linter** (`eslint.config.ts`,
  `oxlint.config.ts`): per-package configs would shadow, not extend - add
  scoped overrides at the root with a "why" comment. oxlint runs
  `--type-aware` (tsgo-backed via `oxlint-tsgolint`). The unicorn preset is
  strict about naming (`db`→`database`, `fn`→`function`-suffixed, boolean
  `is*` prefixes, kebab-case filenames); `eslint . --fix` resolves most of it.
- oxfmt owns formatting and ignores md/yaml; don't hand-align code style.
- Supply-chain guards in [pnpm-workspace.yaml](pnpm-workspace.yaml)
  (`minimumReleaseAge: 1440`, `trustPolicy: no-downgrade`,
  `blockExoticSubdeps`, explicit `allowBuilds`): never add
  `trustPolicyExclude` entries or weaken these autonomously - surface the
  decision to a human.
- Direct third-party deps resolve through the `catalog:` in
  pnpm-workspace.yaml (one line to bump a version); workspace links stay
  `workspace:*`.

## Docs conventions

Docs ship as English/Japanese pairs - `README.md` ↔ `README.ja.md`,
`CONTRIBUTING.md` ↔ `CONTRIBUTING.ja.md`, `KNOWN_ISSUES.md` ↔
`KNOWN_ISSUES.ja.md`. Editing one side means updating the other in the same
change. Code comments are English; avoid the em dash (U+2014) in code and
prose (shared sibling-repo convention). The haru-server environment-variable
contract is documented in the README ("haru-server environment") - keep it in
sync with `services/haru-server/src/environment.ts`.
