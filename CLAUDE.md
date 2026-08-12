# CLAUDE.md — Rolo Working Agreement

Re-read this file at the start of every session. It is the contract for how this project gets built.

## What this is

Rolo is a self-hosted, single-user personal CRM for one person (the repo owner). Its entire job:
**never lose touch with people who matter, without doing data entry.**
Every feature serves one loop: capture context automatically → surface who's due → make reaching out one click.

## Tech stack (fixed — do not substitute)

- **Language:** TypeScript everywhere, `strict: true`. No `any` without a `// justification:` comment on the same line.
- **Framework:** Next.js (App Router), React Server Components where sensible, server actions for mutations.
- **Database:** SQLite via `better-sqlite3`, WAL mode on, FTS5 for full-text search.
- **ORM:** Drizzle, with checked-in migrations under `src/db/migrations/`. Never edit an applied migration; add a new one.
- **UI:** Tailwind + shadcn/ui. Dark mode supported. Density over decoration — visual register of Linear/Superhuman, not a landing page.
- **Background jobs:** in-process scheduler backed by the `jobs` table. No Redis, no BullMQ, no Kafka, no external broker. Ever.
- **Auth:** single password gate + signed session cookie (HMAC, httpOnly). Nothing more.
- **AI:** Anthropic API only. Model ID comes from `ANTHROPIC_MODEL` env var — never hardcode a model.
- **Tests:** Vitest for unit (cadence engine, dedupe matcher, import parsers are mandatory coverage), Playwright for 2–3 critical E2E flows.
- **Deploy:** `docker compose up` on a small VPS; `npm run dev` locally.
- **Dependencies:** do not add one without stating in the PR/phase summary what it's for and why the stdlib or an existing dep won't do.

## Directory conventions

```
src/
  app/              # Next.js App Router routes (route folders kebab-case)
  components/       # shared React components; components/ui/ is shadcn-managed
  db/               # schema.ts, migrations/, client.ts (the only place better-sqlite3 is opened)
  lib/              # pure domain logic, no React, no DB client imports where avoidable
    cadence/        #   next_touch_at engine, snooze redistribution
    dedupe/         #   matchers, nickname map, normalization
    imports/        #   csv, vcard, linkedin, google-contacts parsers + diff engine
    sync/           #   gmail metadata + calendar incremental sync
    ai/             #   prompt builders, filter-compiler, call logging
  jobs/             # job definitions + the scheduler loop
  server/           # server actions and route-handler helpers (thin; logic lives in lib/)
tests/              # Vitest unit tests, mirroring src/lib structure
tests/fixtures/     # real-shaped sample files (CSV, vCard, LinkedIn ZIP contents)
e2e/                # Playwright specs
data/               # SQLite file, attachments/, backups/ — gitignored
```

## Naming conventions

- DB: `snake_case` tables and columns, singular FK names (`contact_id`), timestamps are `*_at` (unix epoch ms integers).
- TS: `camelCase` variables/functions, `PascalCase` components and types, `kebab-case` filenames.
- Booleans in DB are integers 0/1; in TS they surface as booleans via Drizzle `mode: 'boolean'`.
- Derived/denormalized columns are documented as such in SCHEMA.md; never hand-write them elsewhere.

## Commands

| Task | Command |
|---|---|
| Dev server | `npm run dev` |
| Typecheck | `npm run typecheck` (`tsc --noEmit`) |
| Unit tests | `npm run test` (Vitest) |
| E2E tests | `npm run test:e2e` (Playwright) |
| Lint | `npm run lint` |
| Generate migration | `npm run db:generate` |
| Apply migrations | `npm run db:migrate` |
| Full pre-done check | `npm run check` (lint + typecheck + test) |

## Non-goals (never build these)

Multi-user auth, roles/permissions, teams, deal pipelines/stages/revenue, email campaign sending, billing/Stripe, admin panel, public third-party API, native mobile app, browser extension that scrapes or automates LinkedIn, telemetry/analytics of any kind, external message brokers.

**Privacy invariants:** Gmail sync is `gmail.metadata` scope only — sender/recipients, subject, thread id, timestamp. Never fetch, store, or log message bodies. No third-party network calls except integrations the owner explicitly configured (Google APIs, Anthropic API, geocoding if configured).

**LinkedIn invariant:** LinkedIn data enters only via the official data-export ZIP the owner uploads. Making that monthly import effortless is a first-class product problem, not a fallback.

## Working Agreements

1. **Never claim something works without running it.** Run `npm run typecheck` and `npm run test` before declaring a phase (or any nontrivial change) done, and paste the actual command output in the summary.
2. **Never present a mock, stub, or hardcoded fixture as a working feature.** If something is stubbed, it goes under a "Known Stubs" heading in the phase summary — every time, until it's gone.
3. **Prefer editing existing files over creating new ones.** New file = a deliberate choice, not a default.
4. **One logical change per commit.** Conventional commit messages (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`).
5. **Stop and ask before expensive-to-reverse decisions.** Schema shape changes, sync strategy, auth model, or any ambiguous requirement: STOP and ask the owner. Do not guess. Cheap-to-reverse decisions: decide, note it, move on.
6. **End every phase with a summary:** what changed, what's tested (with output), what's stubbed, and a recommendation for the next phase.
7. **Migrations are append-only.** Schema changes go through a new Drizzle migration checked into git.
8. **SPEC.md and SCHEMA.md are the source of truth.** If implementation needs to deviate, update the doc in the same commit and say why.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
