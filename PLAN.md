# PLAN.md — Rolo Build Plan

Eleven phases, each independently shippable and manually verifiable in the browser. Ordering principle: a genuinely useful tool as early as possible — contacts + notes + import + keep-in-touch are the working product by Phase 4; everything after deepens the "capture automatically" side.

Every phase ends with the CLAUDE.md ritual: `npm run check` output pasted, summary of changed/tested/stubbed, recommendation for next phase. Schema for each phase's tables comes from SCHEMA.md via a new Drizzle migration — no ad-hoc columns.

## Status

- ✅ **Phase 1** — app shell, auth, contacts CRUD, tags (migration 0000)
- ✅ **Phase 2** — notes with autosave/mentions/attachments, timeline, groups (0001)
- ✅ **Phase 3** — CSV + vCard import, provenance, diff reports (0002)
- ✅ **Phase 4** — cadence engine, `next_touch_at`, snooze-all, Today page
- ⬜ **Phase 5 → 11** — next up: scheduler, reminders, birthdays, digest

83 unit tests passing as of Phase 4. Open questions from SPEC.md's decision
list are all resolved with the owner; see that section before revisiting them.

---

## Phase 1 — Skeleton + contacts you can actually use

**Goal:** open a browser, log in, create/edit/browse contacts. The app exists.

**Scope:** Next.js + TS strict + Tailwind + shadcn scaffold; dark-mode-first shell (sidebar + content); better-sqlite3 + Drizzle + migration #1 (contacts, contact_emails, contact_phones, contact_socials, tags, contact_tags, settings, contact_field_sources); WAL/foreign-keys pragmas; password gate + signed session cookie; contact list (dense rows: name, company, title, tags, star) with basic sort; contact create/edit page (profile fields, multi-email/phone with priority, socials, birthday, markdown description); tags CRUD + assign; star/archive; seed script with 25 fake contacts.

**Files:** the scaffold; `src/db/schema.ts`, `src/db/client.ts`, migration; `src/app/(auth)/login`, `src/app/contacts/*`, `src/server/contacts.ts`, `src/components/*`; `scripts/seed.ts`.

**AC:** login required on every route; create a contact with 2 emails, reorder priority, survives reload; archive hides from list; typecheck/lint/test green.
**Manual check:** `npm run dev`, log in, create yourself and 3 friends, star one, archive one.

## Phase 2 — Notes & per-contact timeline

**Goal:** Rolo becomes the place you write things down about people.

**Scope:** migration (notes, note_mentions, attachments, interactions, groups, group_members); markdown note editor with debounced autosave + save indicator; @contact/#group mention autocomplete writing real mention rows; file/image attachments to `data/attachments/`; per-contact timeline (notes + manual interactions union, reverse-chron); "log interaction" (kind manual, counts_for_touch); groups CRUD (hierarchy + emoji) and assignment.

**AC:** SPEC §2 autosave and mention checks; manual interaction appears at top of timeline; Vitest on mention parsing.
**Manual check:** write a note with an @mention and a pasted image; see it on both contacts' timelines.

## Phase 3 — Import I: CSV + vCard, provenance, diff report

**Goal:** get your real data in. After this phase the tool holds your actual network.

**Scope:** migration (sync_runs); `lib/imports/` core: identity resolution ladder, field-merge with provenance rules, diff engine (new/updated/unchanged/conflict), per-run report storage + report UI; CSV upload → preview → column-mapping UI with auto-guess + saved mapping templates → dry-run → confirm; vCard parser (3.0/4.0, multi-card, photos); email/phone normalization (`email_normalized`, E.164 via `libphonenumber-js` — dependency: the only sane E.164 parser, stdlib can't); import history screen.

**AC:** SPEC §8 CSV checks — same-file re-import is all-unchanged/zero-writes; user-edited field survives re-import as a conflict; parser unit tests (BOM/CRLF/quotes, multi-card vCard) green.
**Manual check:** export Google Contacts to CSV, import it, spot-check 5 people, re-import, see all-unchanged.

## Phase 4 — Keep-in-touch engine + Today page v1

**Goal:** the heart starts beating: open Rolo in the morning, see who's due, act with one key.

**Scope:** `lib/cadence/` pure engine (recompute per SPEC §3, snooze, snooze-all redistribution) with the full unit-test battery; cadence picker on contact + bulk-set from list; Today page: due queue (starred-first, overdue-sort) with keyboard dispatch `j/k`, `l`og, `s`nooze, `n`ote, `o`pen Gmail compose, `d`ismiss; snooze-all button; recompute wired into every interaction write path (notes toggle included).

**AC:** all SPEC §3 unit ACs green (paste output); logging from Today advances `next_touch_at` and removes the row without reload.
**Manual check:** set weekly cadence on 5 contacts, backdate an interaction (seed helper), watch them appear due, clear the queue by keyboard only.

## Phase 5 — Job scheduler, reminders, birthdays, digest

**Goal:** Rolo works while you don't: durable background jobs, reminders fire, the digest email lands.

**Scope:** migration (jobs, reminders); in-process scheduler (poll pending jobs, lease, retry/backoff, startup reclaim); reminders CRUD (one-off + RRULE via `rrule` package — dependency: RFC 5545 recurrence is a solved-problem minefield) with occurrence materialization; reminder firing → timeline row + Today section; birthdays: dashboard section + important-only filter + Feb 29 rule; digest email via `nodemailer` (dependency: SMTP client, stdlib has none) at configured hour; settings screen (timezone, digest hour, SMTP, snooze-all params).

**AC:** SPEC §4 checks incl. kill-restart fires-exactly-once; digest content matches Today (fixture clock test); scheduler unit tests for backoff/reclaim.
**Manual check:** set a reminder 2 minutes out, watch it fire; trigger digest manually from settings, read the email.

## Phase 6 — Search, filters, saved views, command palette

**Goal:** find anyone by anything; the canonical saved views become buildable.

**Scope:** hand-written migration for FTS5 tables + triggers (per SCHEMA.md); search backend (FTS candidates + Jaro-Winkler/nickname re-rank); filter engine: versioned filter JSON → SQL compiler covering every SPEC §7 dimension (custom fields included — migration for custom_fields/custom_field_values lands here); filter chip UI; views CRUD, sidebar pinning, drag-order; Cmd+K palette (jump/create/run-view/navigate); global timeline view with filters; `?` shortcut overlay.

**AC:** SPEC §7 checks — `katee` finds Katherine; "ex-Googlers" correct incl. exclusion; view round-trips; note-body hit opens the right contact. Filter-compiler unit tests per dimension.
**Manual check:** build all three canonical views from the brief and pin them.

## Phase 7 — LinkedIn ZIP import + job changes (Network Updates)

**Goal:** the monthly ritual: drop the ZIP, get a diff of your professional network, with reasons to reach out.

**Scope:** migration (contact_changes, work_history, education); ZIP handling + Connections.csv (preamble-tolerant) + Profile.csv + messages.csv parsers with fixture tests; identity via profile URL; job-change diffing vs previous run + `contact_changes`; message→interaction linking with unmatched-conversation picker; work history/education on the profile page; Today cards for changes (dismiss/act); LinkedIn import landing page that makes the ritual obvious ("last import 34 days ago — time for a fresh export", link to LinkedIn's export page).

**AC:** SPEC §8 LinkedIn checks (idempotent, one-changed-Position → one change row) + SPEC §5 checks; `last_interaction_at` fed by message timestamps end-to-end.
**Manual check:** import your real LinkedIn export; next month's import shows actual job changes.

## Phase 8 — Google sync: Gmail metadata + Calendar

**Goal:** interactions capture themselves; the cadence engine runs on real signal.

**Scope:** migration (integration_accounts); Google OAuth flow (metadata + calendar.readonly; contacts.readonly optional separate consent + People API import); Gmail backfill + historyId incremental sync (metadata only — request builder physically cannot ask for bodies, with a test asserting it); direction via my-addresses; Calendar window sync + syncToken incremental, attendee matching, declined-exclusion; Today agenda section; sync status UI (cursors, last run, errors) + manual trigger; cursor-invalidation recovery paths (404/410).

**AC:** SPEC §9 checks — scope assertion test; no-new-mail second sync is all-zero; meeting appears on timeline. This phase has real-API integration risk: fixture-based unit tests for parsing + one documented manual live test.
**Manual check:** connect your account, wait a tick, watch yesterday's real emails/meetings appear on the right people.

## Phase 9 — Dedupe & merge

**Goal:** the multi-source database gets clean, safely.

**Scope:** migration (duplicate_candidates, merge_log, contact_relationships); `lib/dedupe/` matcher (email/phone/JW+nicknames per SPEC §10 thresholds) + scheduled scan job; suggestion queue UI with dismissal memory; merge UI (field-by-field, provenance shown, multi-value union); repoint-everything transaction; merge log + undo; related-contacts UI on profile (edges + labels) — grouped here because merge must repoint relationships.

**AC:** SPEC §10 checks — Bob/Robert, gmail normalization, full repoint, byte-identical undo, dismissal memory. Matcher unit battery is mandatory coverage.
**Manual check:** import an overlapping CSV on purpose, review the queue, merge one pair, undo it.

## Phase 10 — AI layer

**Goal:** language in, deterministic filters and reviewable suggestions out — with a full audit trail.

**Scope:** migration (ai_calls, ai_suggestions); Anthropic client wrapper (`@anthropic-ai/sdk` — dependency: the API client; model from env) with mandatory ai_calls logging; NL search → constrained filter-JSON output → Zod validation → existing filter engine → chips UI + save-as-view; auto-tag batch flow → suggestion queue → approve/reject; conversation starters on contact + job-change cards; note summarization; AI audit screen (calls, tokens, latency).

**AC:** SPEC §11 checks — invented-field rejection test; one ai_calls row per use; suggestions never auto-apply; graceful no-API-key state.
**Manual check:** run the biotech-Boston query, inspect chips, save as view; batch-tag 20 contacts and approve a few.

## Phase 11 — Data ownership, deployment, hardening

**Goal:** trust it: export everything, backed up nightly, running on the VPS.

**Scope:** full export (streaming ZIP: flattened CSV + per-table JSON + attachments); nightly `VACUUM INTO` backup job + 30-day prune + status UI; outbound-host allowlist on the fetch wrapper + test; Dockerfile + docker-compose.yml (volume for `data/`) + deploy README; Playwright E2E suite (the 2–3 critical flows: login→create→note→due→clear-from-Today; CSV import round-trip; merge+undo); performance pass on 10k-contact seed (list virtualization, query timing); final sweep of every phase's "Known Stubs" list — must be empty or explicitly accepted.

**AC:** SPEC §13 checks — export/reimport fidelity on fixture, backup prune, host allowlist; `docker compose up` on a clean machine serves a working app; E2E green in CI-style run.
**Manual check:** deploy to the VPS, restore yesterday's backup into a scratch container, log in, see your data.

---

## Sequencing notes

- **Useful-tool milestones:** Phase 1 = a contact book; Phase 3 = *your* contact book; Phase 4 = the actual product loop; Phase 7–8 = the "without doing data entry" promise.
- Custom fields ride with Phase 6 (their value is filtering); work_history/education ride with Phase 7 (their source is LinkedIn) — creating them earlier would be schema without a feature.
- Dedupe (9) deliberately follows LinkedIn (7) and Google (8): that's when duplicates actually appear.
- Dependencies declared across the plan, per CLAUDE.md: `libphonenumber-js`, `rrule`, `nodemailer`, `@anthropic-ai/sdk`, plus scaffold-standard ones (drizzle, better-sqlite3, tailwind/shadcn deps, zod, vitest, playwright). Anything else gets justified when proposed.
- Riskiest phases: 8 (Google API edge cases) and 3 (provenance/merge rules — everything later builds on them). Phase 3's merge rules get the heaviest unit coverage for exactly that reason.
