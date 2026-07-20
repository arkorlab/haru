# Haru

**Haru** is a GPU Hardware Abstraction Layer (HAL) for LLM inference
fleets, inspired by the role the HAL plays in an operating system: it
gives higher-level systems a small, stable, provider-neutral surface
over messy, heterogeneous GPU infrastructure. The name also reads as
haru (spring: 春) in Japanese.

[日本語版 README](README.ja.md)

## Why Haru exists

Products that host LLM inference need GPU lifecycle management:
provisioning machines, supervising runtimes, failing over between
regions, deciding where traffic should go. Embedding that logic into a
product control plane couples it to one deployment and one provider.
Haru extracts it into an independent layer with its own state store,
so a product control plane can stay focused on users, catalogs and
metadata, and consume Haru through a small HTTP API.

## The Active/Standby architecture

Haru's initial mission is hot failover for self-hosted LLM inference
at the cost of zero idle GPUs:

- The **active** domain serves OpenAI-compatible inference traffic.
- The **standby** domain keeps the same model runtimes resident, but
  puts vLLM into **[level 1 sleep mode](https://vllm.ai/blog/2025-10-26-sleep-mode)**:
  the server process stays alive, model weights are offloaded to CPU
  RAM and the KV cache is discarded. This frees the standby GPUs'
  VRAM, which is used to run **preemptible LoRA training** while the
  domain waits.
- When the active domain fails, Haru promotes the standby:

  1. stop LoRA training (SIGTERM, then SIGKILL after a grace period;
     checkpointing is best-effort inside the grace window and failover
     **never** waits for a perfect checkpoint - training is required to
     be checkpoint/resume oriented),
  2. verify the GPUs actually released the training VRAM,
  3. wake vLLM (level 1 sleep makes this the fastest possible path:
     weights come back from CPU RAM instead of disk),
  4. run a synthetic inference probe against every model,
  5. flip the routing pointer (a single database compare-and-swap),
  6. best-effort: put the old active to sleep and hand it the training
     workload.

  A promotion that fails before step 5 never moves routing: the old
  active keeps serving.

The intended layout is one GPU hosting a bundle of smaller models
(one vLLM server per model) and a second GPU hosting one large model,
mirrored across two failure domains (different regions or different
clouds). Haru itself hard-codes none of this: fleets, domains, slots,
models and placement are all data.

## Layering: SkyPilot, SkyServe, and Haru

- **[SkyPilot](https://skypilot.readthedocs.io/)** is the lower-level
  multi-cloud GPU provisioning layer. Haru asks SkyPilot to create,
  stop and inspect GPU domains; AWS/GCP/region/spot/GPU constraints
  are expressed as SkyPilot task configuration, never as direct cloud
  API calls.
- **[SkyServe](https://skypilot.readthedocs.io/en/latest/serving/sky-serve.html)**
  is the serving-oriented orchestration layer for active inference
  services: replicas, placement, recovery, load balancing.
- **Haru** is the higher-level GPU HAL that neither replaces: it owns
  Fleet/Domain/Slot state, Active/Standby promotion, the standby
  sleep-and-train lifecycle, route intent, and runtime supervision.

## Core concepts

| Concept | Meaning |
| --- | --- |
| **Fleet** | One Active/Standby unit: a set of domains plus the single authoritative `activeDomainId` routing pointer and a policy (timeouts, auto-failover). |
| **Domain** | One failure domain: a provisioned GPU machine/cluster (a SkyPilot cluster, a SkyServe service, or a statically provisioned host) with a supervisor and a serving base URL. |
| **Slot** | One workload on one GPU: an `inference` slot (the models a GPU serves, each with its own vLLM server) or a `training` slot (the preemptible LoRA job that runs while the domain is standby). |
| **Driver** | The provisioning boundary (`@haru/driver-skypilot`, `@haru/driver-skyserve`): translate domain/service specs into SkyPilot/SkyServe YAML and wrap the `sky` CLI behind an injectable, testable exec function. |
| **Supervisor** | The per-domain agent (`services/haru-supervisor`): vLLM sleep/wake orchestration, training start/stop with grace/SIGKILL escalation, GPU memory checks, synthetic probes, readiness. |
| **RouteIntent** | The provider-neutral routing answer (`active`/`standby` targets, eligibility, weights, revision) that external routing layers consume. Haru contains no router-vendor logic. |

## Repository layout

```text
packages/protocol         Zod schemas / typed API contracts (source of type truth)
packages/core             Pure state machines, promotion planning, route intent
packages/db               Neon/Postgres state store (Drizzle schema, migrations,
                          compare-and-swap repositories, PGlite test harness)
packages/driver-skypilot  SkyPilot driver boundary
packages/driver-skyserve  SkyServe driver boundary
services/haru-server      Control API + reconciler + OpenAI-compatible chat proxy
services/haru-supervisor  GPU-domain-side supervisor
```

### State model in one paragraph

The server owns durable truth; supervisors own execution. Every state
transition is a single-statement compare-and-swap (`UPDATE ... WHERE
state IN (...) RETURNING`), which works identically on the Neon HTTP
driver (no interactive transactions) and on PGlite in tests. External
operations (SkyPilot provisioning, vLLM wake, probes) never run inside
a DB transaction. Promotions and demotions are `operations` rows with
a partial unique index enforcing one in-flight operation per fleet;
the reconciler advances the current step with re-entrant
check-and-nudge executors, so concurrent ticks race safely and crashed
steps resume idempotently.

## Database: Neon first

`@haru/db` targets [Neon](https://neon.tech) as the documented and
tested production database, over `drizzle-orm/neon-http`. The SQL is
deliberately portable PostgreSQL: the test suite runs the committed
migrations against in-memory PGlite, and nothing uses Neon-specific
features beyond the HTTP driver's constraint that every write is a
single statement.

```bash
pnpm db:generate   # drizzle-kit generate (committed under packages/db/drizzle)
pnpm db:push       # push schema to $DATABASE_URL
pnpm db:seed       # seed a fleet from a declarative layout JSON
```

## API surface (haru-server)

| Route | Purpose |
| --- | --- |
| `GET /healthz` | Liveness. |
| `GET /v1/fleets/:fleetId` | Full fleet snapshot (slug or UUID). |
| `POST /v1/fleets/:fleetId/reconcile` | Run one reconcile tick (heartbeats, auto-failover, one operation step). |
| `POST /v1/fleets/:fleetId/promote` | Promote a domain to active (idempotent; 200 no-op when already active, 202 accepted/joined, 409 conflicting in-flight operation). |
| `POST /v1/fleets/:fleetId/demote` | Put a standby to sleep + start training (the active domain can never be demoted directly). |
| `GET /v1/fleets/:fleetId/route-intent` | Provider-neutral routing answer. |
| `POST /v1/chat/completions` | OpenAI-compatible streaming proxy to the active domain (fleet chosen by `X-Haru-Fleet` header or `HARU_DEFAULT_FLEET`). |

Authentication: set `HARU_API_TOKEN` and send
`Authorization: Bearer <token>`. Unset means unauthenticated: the
server logs a loud warning and binds to 127.0.0.1 only (local
development mode; the same rule applies to the supervisor without
`HARU_SUPERVISOR_TOKEN`). The server-to-supervisor plane uses a
separate `HARU_SUPERVISOR_TOKEN`.

### haru-server environment

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Neon/Postgres connection string (required). |
| `PORT` | Listen port (default 8700). |
| `HARU_API_TOKEN` | Bearer token for the public API; unset = open AND the server binds to 127.0.0.1 only (dev only). |
| `HARU_SUPERVISOR_TOKEN` | Bearer token presented to domain supervisors. |
| `HARU_DEFAULT_FLEET` | Fleet used by `/v1/chat/completions` without an `X-Haru-Fleet` header. |
| `HARU_CHAT_HEADER_TIMEOUT_MS` | TTFB bound for the chat proxy (default 30000). Raise it for long **non-streaming** completions: their response headers only arrive after full generation. Any value is honored exactly: chat traffic runs on a dedicated dispatcher with undici's own headers/body idle timers disabled, so the bound is not capped at 300s and a streaming body that goes quiet mid-generation is never severed by the transport. |
| `HARU_SNAPSHOT_CACHE_TTL_MS` | Fleet snapshot cache TTL on the chat hot path (default 2000). Routing-pointer moves surface immediately regardless (every request revalidates against the fleet's route revision); this only bounds slot-state staleness. |
| `HARU_CHAT_MAX_BODY_BYTES` | Max chat request body size in bytes (default 33554432 = 32 MiB); a larger body gets `413 payload_too_large`. The proxy must buffer the whole body to read `model` and forward it byte-identically, so this caps per-request memory. Raise it for very large multimodal or long-context payloads. |
| `HARU_RECONCILE_INTERVAL_MS` | Enables the background reconcile loop at this interval. **Unset means no loop**: heartbeats, `autoFailover`, and operation progress then only run when something POSTs `/v1/fleets/:id/reconcile` (e.g. external cron). |
| `HARU_RECONCILE_FLEETS` | Comma-separated fleet slugs the loop reconciles (falls back to `HARU_DEFAULT_FLEET`). |

The supervisor reads `PORT` (default 8701), `HARU_SUPERVISOR_TOKEN`,
and `HARU_SUPERVISOR_CONFIG` (inline JSON or a file path). The seed
script reads `DATABASE_URL` and optionally `HARU_FLEET_LAYOUT`.

### Consumer contract for the chat proxy

- `POST /v1/chat/completions` with a normal OpenAI-style JSON body.
  `model` selects the serving vLLM instance on the active domain;
  every other field (including vendor extensions) is forwarded
  byte-identically.
- `X-Haru-Fleet: <slug-or-uuid>` picks the fleet; falls back to
  `HARU_DEFAULT_FLEET`.
- Responses stream through untouched (SSE or JSON). Errors use
  `{ "error": { "code", "message" } }` with codes such as
  `fleet_not_found`, `model_not_found`, `no_active_domain`,
  `upstream_timeout`, `upstream_unreachable`,
  `state_store_unavailable`.
- **The data path fails open.** If the fleet state store is
  unreachable, chat keeps serving the last routing this process saw and
  marks the response `X-Haru-Routing: stale`. That is safe rather than
  merely convenient: the routing pointer cannot move while the database
  is down (a promotion needs the very CAS that is failing), so the
  cached route is still the correct one. That guarantee is scoped to a
  FULL outage: in a partition where another process can still write,
  the pointer can move while this process is blind, and chat keeps
  routing to the previous active until the store is readable again
  (those requests fail upstream as the old active is demoted - the same
  outcome failing closed would give; see Known limitations).
  Unreachability is the ONLY
  failure that licenses serving UNVERIFIED routing: if the store
  answers but its state cannot be used (a promotion moved the pointer
  and the fresh snapshot will not load, or the persisted state is
  malformed) chat fails CLOSED with `503 state_store_unavailable`, as
  it does for a fleet this process never cached. One reachable-store
  case also carries the header: when the pointer read proves the cached
  routing is still current and only the refresh of non-routing state
  failed, chat serves the cache marked stale. The header therefore
  means "served without a fresh snapshot", not "the store is down".

## vLLM requirements (supervisor hosts)

Every vLLM server managed by a Haru supervisor must be started with:

- `--enable-sleep-mode` and `VLLM_SERVER_DEV_MODE=1` (the sleep/wake
  admin endpoints are development-mode endpoints),
- bound to `127.0.0.1` only.

The sleep/wake/is_sleeping endpoints are **private, local-only
controls**. They are never exposed beyond the host; the supervisor's
authenticated API is the only external control surface, and the
haru-server chat proxy is structurally unable to reach them (it only
ever constructs `/v1/chat/completions` paths). Verify the endpoint
paths against your deployed vLLM version; this repo pins its
behaviour in `services/haru-supervisor/src/vllm-client.ts`.

## Training command contract (supervisor hosts)

A training slot's `command` is spawned verbatim, with no arguments
appended and no per-run input channel: `POST /v1/training/start`
carries no body, so the trainer is expected to find its own work
(poll a queue, read a config file, whatever it likes). The supervisor
only tells it *where* and *on which GPU* to run, through exactly two
environment variables added to the child's env:

| Variable | Meaning |
| --- | --- |
| `HARU_CHECKPOINT_DIR` | The slot's `checkpointDir`. The trainer must checkpoint here and resume from it on start: a promotion stops the run with SIGTERM plus a grace period, and anything not checkpointed is lost. |
| `HARU_GPU_INDEX` | The slot's `gpuIndex`. The trainer must pin itself to it (e.g. `CUDA_VISIBLE_DEVICES`). |

`HARU_GPU_INDEX` is not a convenience: a trainer that guessed would
take GPU 0, and on a standby domain GPU 0 is typically an **inference**
GPU holding a sleeping vLLM. Training there would fight the wake path
for VRAM and wedge the next promotion.

The run must also tolerate being killed at any moment (SIGTERM, then
SIGKILL after the grace period) and being restarted later on a
different host, resuming from the checkpoint directory. Failover speed
always wins over a clean training tail.

## Trying the vertical slice (no GPUs required)

Domains with `provider: "static"` skip the drivers entirely, so the
whole control loop runs against any OpenAI-compatible endpoints:

```bash
pnpm install && pnpm build

# 1. Point DATABASE_URL at a Neon database and apply the schema.
pnpm db:push

# 2. Seed the bundled generic two-domain example layout
#    (packages/db/examples/fleet.example.json), or pass your own:
pnpm db:seed            # or: pnpm db:seed -- --config my-fleet.json

# 3. Start the server (turbo builds workspace deps first).
HARU_DEFAULT_FLEET=default pnpm dev --filter=@haru/server

# 4. Talk to it.
curl -s localhost:8700/v1/fleets/default/route-intent
curl -s localhost:8700/v1/chat/completions \
  -H 'content-type: application/json' -H 'x-haru-fleet: default' \
  -d '{"model":"example-chat-small","messages":[{"role":"user","content":"hi"}]}'
curl -s -X POST localhost:8700/v1/fleets/default/promote \
  -H 'content-type: application/json' \
  -d '{"targetDomainId":"<standby domain id from the fleet snapshot>"}'
curl -s -X POST localhost:8700/v1/fleets/default/reconcile  # repeat until settled
```

## Development

```bash
pnpm install
pnpm build          # turbo run build (topological)
pnpm typecheck      # tsc --noEmit everywhere
pnpm lint           # oxlint --type-aware --deny-warnings, then strict type-aware ESLint
pnpm format         # oxfmt --write
pnpm format:check   # CI gate
pnpm test           # vitest everywhere (PGlite-backed DB and server tests)
```

TypeScript 7 (`tsc`) builds and typechecks the code; a TypeScript 6.x
copy is installed at the workspace root only for typescript-eslint's
type-aware linting (its supported peer range is still `<6.1.0`). Drop
the extra copy once typescript-eslint supports TS 7 (see the comment
in `pnpm-workspace.yaml`). oxlint's type-aware rules run through the
tsgo-backed `oxlint-tsgolint` binary, independently of both copies.

See [CONTRIBUTING.md](CONTRIBUTING.md) ([日本語](CONTRIBUTING.ja.md))
for development conventions and PR guidelines.

## Known limitations (this slice)

Contributor-facing deferred work is tracked with file references and
intended fixes in [KNOWN_ISSUES.md](KNOWN_ISSUES.md).

- **Auto-failover needs a reconcile driver.** Set
  `HARU_RECONCILE_INTERVAL_MS` (plus `HARU_RECONCILE_FLEETS`) or drive
  `POST /v1/fleets/:id/reconcile` from external cron; without either,
  `autoFailover` policy is inert.
- **A reachable-but-dead active fails over only after
  `degradedGraceMs`.** When the active domain's supervisor answers but
  its models are not serving, the domain degrades immediately (visible
  in route intent) and escalates to `failed` (triggering auto-failover
  when enabled) only after staying degraded past the policy grace
  (default 60 s); tune `degradedGraceMs` to taste.
- **Synthetic probe policy is bounded.** `policy.probe.prompt` is at
  most 8,192 Unicode code points, matching JSON Schema `maxLength`, and
  `policy.probe.maxTokens` is at most 256. The database schema enforces
  both bounds for `db:push`; migration `0003` also checks stored fleet
  policies before an upgrade and stops instead of truncating an
  existing value above either limit. Shorten, lower, or remove the
  offending persisted key before upgrading; re-applying a layout does
  not update an existing policy row.
- **Model binding names are lowercase routing keys** and the vLLM
  server behind each binding must serve the same lowercase name (e.g.
  `--served-model-name`); the chat proxy matches exactly and forwards
  the client body verbatim. The supervisor config enforces the same
  contract: its model names must be lowercase and unique across the
  host's inference slots (server-side health/wake/sleep checks match
  layout and supervisor names by exact string equality).
- **GPU memory verification requires `nvidia-smi` numeric output**;
  MIG-partitioned GPUs reporting `[N/A]` for memory fields are not
  supported by the `verify_gpu` step yet.
- **Re-applying a layout never updates existing rows** (fleet policy,
  display name, existing slot specs): seeding is insert-only by
  design. Slot states for NEWLY added slots follow the live routing
  pointer.
- **Chat routing may lag non-routing state changes by up to the
  snapshot cache TTL** (`HARU_SNAPSHOT_CACHE_TTL_MS`, default 2 s).
  Routing-pointer moves are exempt while the state store is reachable:
  every request revalidates against the fleet's route revision, so a
  promotion switches chat traffic immediately.
- **While the state store is unreachable, chat routing itself goes
  stale** (fail-open; responses carry `X-Haru-Routing: stale`). The
  pointer cannot move during the outage either, so the served route
  stays correct; the exception is a partition in which another process
  can still write, where traffic keeps going to the old active until
  the store is readable again.
- **A cold start during a state-store outage cannot fail open**: an
  empty cache has no routing to serve and chat answers `503
  state_store_unavailable`. Do NOT restart haru-server during an outage
  - the in-memory snapshot is what keeps traffic alive, and `/healthz`
  deliberately stays green (it never touches the database) so a
  liveness probe cannot destroy it.

## Intentionally out of scope (for now)

- **Direct AWS/GCP providers.** SkyPilot and SkyServe are the only
  drivers; clouds are placement constraints, not integrations.
- **Router/DNS/proxy reconciliation.** Haru emits provider-neutral
  route intent; acting on it (DNS, edge proxies, CDN configuration)
  belongs to the consumer.
- **Driver-backed provisioning in the reconciler.** The drivers are
  complete, tested boundaries, but the reconciler currently manages
  statically provisioned domains; wiring `provider: skypilot |
  skyserve` domains through launch/teardown steps is the next slice.
- **More than two domains per fleet**, weighted/canary routing, and
  multi-fleet scheduling.
