# Contributing to Haru

Thanks for your interest! Haru is at an **early stage**: the core idea (a provider-neutral GPU HAL for Active/Standby LLM inference fleets) is something we want to design together with the people who would run it. Issues, discussion, and PRs are all welcome.

[日本語版](CONTRIBUTING.ja.md)

## Ways to help

| Effort           | What's most useful                                                                   |
| ---------------- | ------------------------------------------------------------------------------------ |
| **5 min**        | Try the [vertical slice walkthrough](README.md#trying-the-vertical-slice-no-gpus-required) and [open an issue](https://github.com/arkorlab/haru/issues/new) about anything that confused you or broke. |
| **An afternoon** | Send a small PR (doc fixes, error-message polish, a missing state-machine edge case with a test). |
| **Ongoing**      | Tell us which providers, GPU layouts, and failover policies you need. We use this to prioritize. |

If you have an idea for a non-trivial change (a new driver, a new promotion step, a policy knob), please open an issue first so we can align on the state-machine and API shape before you write code.

## Repo layout

```
haru/
├── packages/
│   ├── protocol/           # Zod schemas / typed API contracts (source of type truth)
│   ├── core/               # pure state machines, promotion planning, route intent
│   ├── db/                 # Neon/Postgres state store (Drizzle, CAS repositories, PGlite tests)
│   ├── driver-skypilot/    # SkyPilot driver boundary
│   └── driver-skyserve/    # SkyServe driver boundary
├── services/
│   ├── haru-server/        # control API + reconciler + OpenAI-compatible chat proxy
│   └── haru-supervisor/    # GPU-domain-side supervisor (vLLM sleep/wake, training)
└── turbo.json              # build / test orchestration
```

## Development setup

Please use **Node.js 24 (preferably the latest)** and **pnpm 11.0+**.

```bash
git clone https://github.com/arkorlab/haru.git
cd haru
pnpm install
pnpm build         # turbo run build (covers all packages)
pnpm test          # vitest across the monorepo (includes PGlite-backed DB/server tests)
pnpm typecheck     # tsc (TypeScript 7) across the monorepo
pnpm lint          # oxlint --type-aware --deny-warnings, then strict type-aware ESLint 10
pnpm format        # oxfmt --write (config in oxfmt.config.ts)
pnpm format:check  # oxfmt --check; CI fails on unformatted files
```

To work on a specific package:

```bash
pnpm --filter @haru/server dev       # tsx watch on the control server
pnpm --filter @haru/supervisor dev   # tsx watch on the supervisor
pnpm --filter @haru/core test:watch  # vitest watch on the pure core
```

## Testing

Everything is testable without GPUs, cloud accounts, or a running
database:

- `@haru/db` and `services/haru-server` run their suites against
  in-memory **PGlite** using the committed Drizzle migrations, so the
  compare-and-swap SQL that guards every state transition is exercised
  for real (including concurrent-winner races).
- The drivers are tested against an injectable `exec` boundary
  (recorded argv, timeout propagation, error mapping); no `sky` binary
  is needed.
- The supervisor is tested with fake fetch (vLLM admin endpoints),
  fake child-process handles, and fake timers (SIGTERM -> grace ->
  SIGKILL escalation).

Please keep new I/O behind the same injectable boundaries. A vitest
case next to the code you change is appreciated; for state-machine
changes, extend the exhaustive transition-table tests.

## Style conventions

- **oxfmt owns formatting** (whitespace, wrapping, quotes, trailing
  commas). Run `pnpm format`; don't hand-tune style ESLint then fights
  over.
- **Two linters, single root config each**: `oxlint --type-aware`
  (fast, tsgo-backed) then strict type-aware ESLint 10. Both read
  their config at the repo root; add overrides there rather than
  per-package configs, and prefer a scoped override with a "why"
  comment over inline `eslint-disable`.
- File names are kebab-case (lint-enforced). Comments are written in
  English.
- We avoid the em dash (U+2014) in code and prose; use a colon, a
  comma, parentheses, or a spaced hyphen instead (a convention shared
  with the sibling Arkor repository).

## Pull request guidelines

We err on the side of accepting PRs, even rough ones. Tiny
contributions are genuinely welcome and never too small to send.
**Please don't let any of the following stop you from opening one:**

- **Size doesn't matter.** Huge diffs are fine; we're happy to split
  them up on our side if that helps review.
- **Unclear description is OK.** A messy or sparse PR description is
  better than no PR. We'll ask follow-ups in review rather than
  bouncing the patch.
- **Tests aren't required.** They're appreciated (see above), but
  never blockers; we're happy to add tests ourselves as part of
  merging.
- **Breaking changes are fine** at this stage. Just note them in the
  PR description.

## Reporting bugs and security issues

- **Bugs**: [GitHub Issues](https://github.com/arkorlab/haru/issues/new). Steps to reproduce, expected vs actual, and your Node + pnpm versions go a long way, but a one-line "this is broken" is still better than not reporting it.
- **Security**: please email security@arkor.ai instead of filing a public issue. We'll acknowledge within 48 hours. Anything touching the supervisor token plane, the vLLM admin-endpoint isolation, or the chat proxy's request handling qualifies.

## Code of conduct

Be kind, assume good faith, and keep technical disagreement technical. Anything else (harassment, personal attacks, exclusionary behavior) is grounds for being asked to leave. The maintainers' call is final.

## License

By contributing, you agree that your contributions will be published under this repository's [LICENSE](LICENSE) (currently the MIT license). Opening a pull request is deemed to constitute this agreement.

The license may change in the future, including to a non-open-source license. By opening a pull request, you are also deemed to have agreed that your contributions may be published under any such changed license.
