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
- **AI:** Anthropic API or Groq's OpenAI-compatible API (owner-amended
  2026-08-20 from "Anthropic only", to run the AI layer on Groq's free
  tier — `openai/gpt-oss-120b`; owner reviewed Groq's no-training terms).
  Model IDs come from env (`ANTHROPIC_MODEL` / `GROQ_MODEL`) — never
  hardcode a model. Free-tier caps (30 req/min, 200k tokens/day) mean
  429s are expected during batch tagging; they surface as logged errors,
  never silent drops.
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
| E2E tests | `npm run test:e2e` (Playwright; dev server + isolated `e2e/.data` are managed by the config. In sandboxes whose pre-installed Chromium doesn't match Playwright's pinned build, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE`) |
| Lint | `npm run lint` |
| Generate migration | `npm run db:generate` |
| Apply migrations | `npm run db:migrate` |
| Full pre-done check | `npm run check` (lint + typecheck + test) |

### Environment notes (learned the hard way)

- **Node 22 LTS or newer.** Node 18 is too old for several deps; Node 24 had no
  prebuilt `better-sqlite3` binary at the time of writing.
- **Install with `npm install --ignore-scripts`.** `better-sqlite3` ships a
  prebuilt binary per platform, but npm still tries its `node-gyp` build step,
  which fails on machines without a C++ toolchain (notably Windows without
  Visual Studio Build Tools). Skipping install scripts uses the prebuilt binary;
  verified working on Linux and Windows.
- **First run:** migrations apply automatically when the server boots
  (`src/instrumentation.ts`); `npm run db:migrate` still works standalone.
  Optionally `npm run seed` (25 demo contacts, 8 with overdue cadences);
  `seed --force` wipes first, `seed -- --count 10000` adds synthetic
  contacts for perf work (timings: `npx tsx --conditions react-server scripts/perf.ts`).
- **Forgot the password:** `npm run reset-password -- <newpassword>`.
- **GitHub Codespaces** works with zero local install (`.devcontainer/` sets it
  up): open the codespace, `npm run dev`, then open the forwarded port from the
  PORTS tab — not `localhost:3000` in your own browser. If a stale server holds
  the port, `lsof -ti:3000 | xargs -r kill`.
- **Behind a reverse proxy**, Server Actions need the proxy host in
  `ROLO_ALLOWED_ORIGINS` (comma-separated `host[:port]`), or Next rejects every
  mutation as a CSRF mismatch. Proxied dev domains are already allowed.

## Non-goals (never build these)

Multi-user auth, roles/permissions, teams, deal pipelines/stages/revenue, email campaign sending, billing/Stripe, admin panel, public third-party API, native mobile app, telemetry/analytics of any kind, external message brokers.

~~browser extension that scrapes or automates LinkedIn~~ — **owner-amended 2026-08-20.** Path 3 below (server-side Voyager sync) proved structurally impossible: LinkedIn is behind Cloudflare bot management, which fingerprints the TLS handshake before a single header is sent, so a Node process is refused no matter how it presents itself. The commercial products solve this by running inside the browser, and the owner directed Rolo to do the same. `extension/` is an unpacked Chrome extension (SPEC §9c) that pages the owner's own connection list from a real linkedin.com tab and posts it to Rolo. Same ToS breach and same account-restriction risk as path 3, explicitly re-accepted; same pacing and fail-loud terms; no fingerprint spoofing, because inside a real browser there is nothing to spoof.

**Privacy invariants:** Gmail sync is `gmail.metadata` scope only — sender/recipients, subject, thread id, timestamp. Never fetch, store, or log message bodies. No third-party network calls except integrations the owner explicitly configured (Google APIs, Anthropic API, geocoding if configured).

**LinkedIn** (re-amended 2026-08-13, owner request): three paths in, all owner-initiated, all feeding the same import engine.

1. The official data-export ZIP the owner uploads. Sanctioned, zero account risk, the recommended route, and the only source of message history. Making that monthly import effortless is a first-class product problem, not a fallback.
2. The Member Data Portability API (DMA self-serve product) connected by the owner in Settings (SPEC §9a). Official and consented, but EEA/CH-only — confirmed unreachable for this deployment's UK owner.
3. An opt-in weekly sync that reads the owner's own connection list through LinkedIn's internal Voyager API using a session cookie the owner pastes in (SPEC §9b, `src/lib/sync/linkedin-voyager.ts`). Off by default.

Path 3 was added on the owner's explicit instruction — requested once before Phase 5, discarded in a branch consolidation, then explicitly re-requested after §9a proved region-locked — overriding this file's previous "official channels only" invariant, and with the tradeoff stated: automated access breaches LinkedIn's User Agreement, and the enforcement risk — account restriction — falls on the owner's account.

**Constraints on path 3 — these are the terms it was built under, not preferences:**

- **Browser presentation (owner-amended 2026-08-20).** Originally: "no impersonating a specific browser build; the client identifies itself honestly." That honest User-Agent was declined by Voyager (which only answers its own web client), so the feature never worked. The owner reversed this specific clause — with the account-restriction risk restated and explicitly accepted — so the sync now presents as the LinkedIn web app (fixed Chrome UA + `x-li-*` headers). The rest of the no-evasion terms **still stand and must not be relaxed**: no fingerprint *randomisation* (one stable signature only), no proxy rotation, no CAPTCHA/challenge solving. On refusal the sync still fails loud and stops — it does not escalate to get around a block.
- **Polite pacing.** Serial requests, a real delay between pages, a hard page cap. Burst traffic is both rude and the thing that actually gets accounts flagged.
- **Fail loud, never silent.** A zero-connection result is an error, not a successful no-op — it means the response shape drifted or the session died. Imports only ever add or update; a contact is never deleted because it stopped appearing.
- **Never log the session.** `li_at`/`JSESSIONID` are bearer credentials: encrypted at rest via the token box (`lib/crypto`), and anything bound for a log, `jobs.last_error`, or a sync-run report goes through `scrubSecrets` first.

**Outbound HTTP** goes through `src/lib/net/fetch.ts` (`outboundFetch`) — a host allowlist enforcing the privacy invariant. Never call `fetch` directly for external hosts; add a host to the allowlist only alongside an owner-configurable integration.

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
