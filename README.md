# Haru

**Haru** is a GPU Hardware Abstraction Layer (HAL) for LLM inference
fleets, inspired by the role the HAL plays in an operating system: it
gives higher-level systems a small, stable, provider-neutral surface
over messy, heterogeneous GPU infrastructure. The name also reads as
haru (spring: 春) in Japanese.

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
- When the active domain fails, haru promotes the standby:

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

```
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
`Authorization: Bearer <token>`. Unset means unauthenticated (local
development only; the server logs a loud warning). The
server-to-supervisor plane uses a separate `HARU_SUPERVISOR_TOKEN`.

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
  `upstream_timeout`, `upstream_unreachable`.

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

# 3. Start the server.
HARU_DEFAULT_FLEET=default pnpm --filter @haru/server dev

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
pnpm lint           # oxlint --deny-warnings, then strict type-aware ESLint
pnpm format         # oxfmt --write
pnpm format:check   # CI gate
pnpm test           # vitest everywhere (PGlite-backed DB and server tests)
```

TypeScript 7 (`tsc`) builds and typechecks the code; a TypeScript 6.x
copy is installed at the workspace root only for typescript-eslint's
type-aware linting (its supported peer range is still `<6.1.0`). Drop
the extra copy once typescript-eslint supports TS 7 (see the comment
in `pnpm-workspace.yaml`).

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
