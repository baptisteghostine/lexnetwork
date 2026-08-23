# PLAN.md — Rolo Build Plan

Eleven phases, each independently shippable and manually verifiable in the browser. Ordering principle: a genuinely useful tool as early as possible — contacts + notes + import + keep-in-touch are the working product by Phase 4; everything after deepens the "capture automatically" side.

Every phase ends with the CLAUDE.md ritual: `npm run check` output pasted, summary of changed/tested/stubbed, recommendation for next phase. Schema for each phase's tables comes from SCHEMA.md via a new Drizzle migration — no ad-hoc columns.

## Status

- ✅ **Phase 1** — app shell, auth, contacts CRUD, tags (migration 0000)
- ✅ **Phase 2** — notes with autosave/mentions/attachments, timeline, groups (0001)
- ✅ **Phase 3** — CSV + vCard import, provenance, diff reports (0002)
- ✅ **Phase 4** — cadence engine, `next_touch_at`, snooze-all, Today page
- ✅ **Consolidation + Dex-style UI overhaul** (between 4 and 5) — six bug
  fixes, light-default indigo theme with dark toggle, avatars, two-zone
  contact page with provenance-on-hover, bulk actions, ⌘K palette + G-chords
- ✅ **Phase 5** — job scheduler, reminders (RRULE), birthdays, digest (0004)
- ✅ **Phase 6** — FTS5 search + nickname re-rank, filter compiler, saved
  views, global timeline, `?` overlay, custom fields (0005/0006). Note:
  work_history + education migrated here instead of Phase 7 — the filter
  compiler's company-past dimension and the ex-Googlers AC need the tables;
  Phase 7's LinkedIn import populates them.
- ✅ **Phase 7** — LinkedIn ZIP import (preamble-tolerant parsers, profile-URL
  identity, provenance merge), job-change detection → contact_changes +
  Today "Network updates" cards + digest section, messages → counting
  interactions, work-history end-dating, unmatched-conversation picker
  (0007/0008; interactions.sync_run_id backfilled per SCHEMA.md)
- ✅ **Hardening pass** (post-7) — CAS job/reminder claims, bounded contacts
  list with total count, archived-aware search candidates
- ✅ **Phase 8** — Google sync (0009): OAuth, Gmail metadata backfill +
  historyId incremental (metadata-only enforced by builders + tests, no `q`
  param — client-side window cutoff), Calendar window + syncToken sync,
  calendar_events agenda cache + Today agenda section, Settings →
  Integrations panel (creds, status, cursors, sync-now), outbound-host
  allowlist fetch wrapper + encrypted tokens at rest (both pulled forward
  from Phase 11). **Plus §9a (owner request): LinkedIn Member Data
  Portability API** — official EEA self-serve product, weekly CONNECTIONS
  snapshot into the same import core as the ZIP, runtime domain discovery.
  Deferred from Phase 8 scope: optional contacts.readonly People import
  (separate consent, not yet built). Live-tested 2026-08-13: the owner is
  UK-based, and LinkedIn does not offer the "(Member)" product to UK
  accounts (EEA/CH only) — confirmed against a real developer app, not
  just docs. §9a's code is sound and stays for any EEA/CH owner, but for
  this deployment it's currently unreachable; **the ZIP import (§8) is
  the live sync path.** Google sync (Gmail + Calendar) is unaffected and
  still awaits its own first live-account pass.
- ✅ **§9b (owner request, post-cleanup): LinkedIn Voyager weekly sync** —
  opt-in cookie-session sync of the owner's own connection list through
  LinkedIn's internal API, rebuilt on top of the Phase 5 scheduler, Phase 7
  import core, and Phase 8 token box + allowlist after the original
  pre-Phase-5 build was superseded in the branch consolidation. Off by
  default; ToS tradeoff and no-evasion constraints recorded in CLAUDE.md
  §LinkedIn and SPEC §9b. Awaits its first live run with a real session.
- ✅ **Phase 9** — dedupe & merge (0010: duplicate_candidates, merge_log,
  contact_relationships). Matcher per SPEC §10 (normalized-email 1.0 with
  gmail rules, E.164 0.95, nickname-aware Jaro-Winkler bands with
  company/org-domain/group corroboration, bucketed blocking for 10k-scale),
  daily `dedupe_scan` job + scan-now, suggestion queue at /duplicates with
  dismissal memory, field-by-field merge screen with provenance and union
  preview, repoint-everything merge transaction (snapshot → repoint →
  cascade), full undo with conflicting-edit refusal, related-contacts
  edges on the profile. Ordering deviation for directed relationship
  edges recorded in SCHEMA.md.
- ✅ **Phase 10** — AI layer (0011: ai_calls, ai_suggestions). Anthropic
  client wrapper (`@anthropic-ai/sdk` — the sanctioned API client; model
  from `ANTHROPIC_MODEL`, key from `ANTHROPIC_API_KEY`, both unset → AI
  affordances hidden) with mandatory one-ai_calls-row-per-use logging
  through an outboundFetch-backed client. NL search → constrained
  JSON-schema output → strict Zod validation (invented fields/ids
  rejected, one retry with the error) → existing filter engine → chips +
  save-as-view. Auto-tag `ai_batch_tag` job → ai_suggestions review queue
  (approve/reject, never auto-applied). Conversation starters on the
  contact page + Today job-change cards; note summarization ≥1500 chars
  into notes.summary_ai. /ai page: suggestion queue + full audit (calls,
  tokens, latency). Not yet live-tested against the real API — needs the
  owner's key.
- ✅ **Audit + hardening pass** (post-10, 2026-08-14) — full adversarial
  review of Phases 1–10; 18 fix commits (0012/0013 migrations included).
  Highest-impact: calendar events synced while future now become meeting
  interactions once they elapse (reconcile-from-cache); scheduler
  reliability (dead rows free dedupe keys, digest survives restarts,
  leases reclaim every tick, CAS-guarded); Gmail historyId-expiry
  recovery re-lists to the last sync point instead of one page;
  owner-timezone correctness for recurring reminders, snooze-all, and
  the agenda day window; outboundFetch validates every redirect hop;
  generated session secret moved out of the DB into data/secret.key;
  LinkedIn accept-conflict crash, identity-key unification
  (subdomains/percent-encoding), cookie bare-value pastes; CSV/vCard
  imports emit contact_changes; dedupe scoring order-independence +
  prefix blocking; merge transfers dismissal memory and undo survives
  deleted referents; FTS diacritic folding; saved-view sort, OR chips,
  include-archived search. 314 unit tests. Still awaiting first live
  passes: Google sync, Voyager sync, and the AI layer (need the owner's
  accounts/keys). Known limitations left open: crashed import runs get
  no partial report; digest "changes since last digest" wording still
  resolves to "open changes" (matches the §3 digest AC).
- ✅ **Phase 11** — data ownership, deployment, hardening. Streaming full
  export at /api/export (flattened contacts.csv whose headers re-map
  through the normal CSV import path, per-table JSON for full fidelity,
  attachments, manifest; generator-driven so 50k contacts never
  materialize; JSON restore helper + export→fresh-instance round-trip
  test). Nightly `VACUUM INTO` backups (always-on 24h job, 30-day prune
  that only touches backup-named files, sync_runs status rows, Settings →
  Data panel with Back up now, app-wide failure banner). Docker deploy:
  Next standalone output, multi-stage Dockerfile (`npm ci
  --ignore-scripts`, runs as node), compose with the ./data volume,
  migrations applied on boot in instrumentation, DEPLOY.md (VPS, reverse
  proxy, restore drill, password reset); session cookie gains `Secure`
  behind an HTTPS proxy. Playwright E2E suite (`npm run test:e2e`, 7
  tests): first-run password setup as shared auth state, Today keyboard
  flow (create → autosaved note → due → cleared without reload), CSV
  import round-trip incl. all-unchanged re-import, merge + undo. Perf
  pass on `seed --count 10000` via scripts/perf.ts: contacts page 37 ms,
  Today 63 ms, searches 53–234 ms, dedupe scan 234 ms, csv export 367 ms,
  backup 34 ms — bounded list + existing indexes hold, no fixes needed.
  No-phoning-home grep test (SPEC §13) locks the source tree to the
  outbound allowlist. No schema changes — 'export'/'backup' kinds were
  already reserved. Verified here: standalone server boots, migrates, and
  serves from scratch; `docker compose up` itself still needs its
  first run on a real machine (no Docker daemon in the dev sandbox).

- ✅ **Phase 12** — Keep-in-touch board (SPEC §3a, migration 0014:
  `contacts.cadence_reviewed_at`). Owner-requested after reviewing Dex's
  "Keep in touch" board. Column per frequency + `Custom` + `Uncategorized`
  + `Don't keep in touch`, every non-archived contact in exactly one
  column, true totals in headers with a 100-card render cap. Two ways to
  move: HTML5 drag-and-drop, and keyboard triage (number keys assign and
  auto-advance through the untriaged queue, `x` excludes, `u` undoes) —
  the addition to Dex's design, because dragging does not scale to the
  few thousand contacts an import produces. `CADENCE_PRESETS` extended to
  seven frequencies and relabelled, keeping the original day counts
  (91/182) so pre-board cadences keep their column; the picker, the list
  bulk bar, and the board now read from that one list. Assigning a
  cadence anywhere stamps `cadence_reviewed_at`, so the contact page and
  the board never disagree about who still needs triage.
  Also fixed here, surfaced by the extra route: `src/db/client.ts` opened
  its connection as an import side effect, so `next build` — which imports
  every route module in one worker per CPU just to read its config — had
  ~19 processes racing to create and WAL-convert the same fresh database,
  intermittently failing the Docker build with SQLITE_BUSY. The connection
  is now opened on first use, so a build never touches a database at all.

- ✅ **Bulk merge** (owner request, post-12) — checkbox selection on the
  /duplicates queue with "Select exact matches", a confirm step that
  breaks the selection down into exact matches vs similarity guesses,
  and sequential merging with default decisions (SPEC §10 amendment).
  Winner rule owner-confirmed: richer contact wins, ties go older.
  Chained pairs (A–B + B–C selected together) are skipped and reported,
  never silently re-routed. Each merge in a batch keeps its own
  merge_log row and individual undo. Engine in lib/dedupe/bulk.ts.

- ✅ **Contacts pagination + Map view** (owner requests, post-12). The
  contacts list pages through everything 500 at a time (runFilter gains
  an offset; pager preserves sort/filter/view context, context changes
  reset to page 1). /map is the Dex-style contacts-by-country view built
  on Rolo's terms (SPEC §7a): Natural Earth 110m geometry bundled with
  the app (`world-atlas` + `topojson-client` + `d3-geo` — pure data/math,
  no tile server, no API key, zero network calls, so the §13
  no-phoning-home test still passes untouched), count bubbles per
  country, click → that country's contacts in the side panel, ranked
  country list otherwise. Freeform locations resolve offline in
  lib/geo/country-resolve.ts (LinkedIn three-part forms, aliases,
  US states/CA provinces, metro wrappers, curated city table, Georgia
  disambiguation); unrecognized strings are listed on the page with
  counts — reported, never guessed. Places 110m drops (Singapore, Hong
  Kong, Malta…) keep bubbles at fixed anchors.

- ✅ **Dex-audit round** (owner request, 2026-08-20) — reviewed Dex's
  feature surface against Rolo and shipped the deltas that fit the
  mission. (1) Quick log: global "Who did you meet?" modal (`q` or the
  sidebar button, SPEC §2 amendment) — find-or-create a contact, one
  line, a backdatable date, saved as a counting manual interaction.
  (2) Resolver i18n: LinkedIn stores locations in each profile's locale,
  so the owner's real (Dex-visible) data mixes German/French/Spanish/
  Dutch/Arabic — native country names, localized city spellings, Arabic
  normalization (harakat/alef/ta-marbuta folding), and a word-suffix
  scan for comma-less forms like "محافظة بيروت لبنان". (3) Board fix:
  dropping a card on the Custom column silently un-triaged the contact —
  Custom is no longer a drop target. (4) CSV mapping: plural headers
  (Emails, Phone Numbers) now auto-map, easing a Dex-export import.
  Deliberately not copied from Dex: global force-directed network graph
  and radial priority canvas (analysis on record: unreadable/unused at
  3k contacts), voice notes, Zapier/API (non-goals).

- ✅ **Groq AI provider** (owner amendment, 2026-08-20) — the AI layer
  can now run on Groq's free tier (`openai/gpt-oss-120b`) instead of a
  paid Anthropic key, amending CLAUDE.md's "Anthropic only" the same way
  §9b amended "official channels only": owner-directed, tradeoffs on
  record (owner reviewed Groq's no-training/limited-retention terms;
  free-tier caps mean 429s during batch tagging, surfaced as logged
  errors). Implementation is an adapter behind the existing call core —
  lib/ai/groq.ts translates to/from the OpenAI-compatible API over
  outboundFetch (api.groq.com allowlisted), no SDK added — so the
  one-ai_calls-row-per-call invariant, Zod validation with one retry,
  and the never-auto-apply queue are provider-blind. Env pairs select
  the provider; both set → AI_PROVIDER decides (default groq). Awaits
  its first live pass with a real Groq key.

- ✅ **Ask your network** (owner request, 2026-08-20) — judgment
  questions over the owner's own contacts ("who should I leverage for
  X"), SPEC §11. Two model calls with the database in between: the
  question compiles to a retrieval filter (reusing the NL-search
  compiler wholesale, feature `ask_plan`), the filter engine — FTS, then
  warmest-50 fallback — selects a capped shortlist, and the model ranks
  only what it was shown (`ask_answer`): recommended ids are validated
  against the sent set, invented contacts rejected with one retry.
  Answers render as a summary plus linked picks with reasons, always
  stating how many profiles were shared and which retrieval source fed
  them. AI page panel + `a` from anywhere. Chose this over an agentic
  tool-use chat (free-tier 8k tokens/min makes loops 429-prone; the
  two-stage shape keeps "model proposes, deterministic layer executes")
  and over an AI insights feed (network statistics are SQL, not
  intelligence). Quality scales with data richness — it sharpens as
  Gmail history and notes accumulate.

- ✅ **LinkedIn Voyager browser presentation** (owner amendment,
  2026-08-20) — the opt-in weekly sync (§9b) never worked: its honest
  self-identifying User-Agent was declined by Voyager, which answers only
  its own web client. The owner reversed the specific "no browser
  impersonation" clause — account-restriction risk restated and
  accepted, decision recorded in CLAUDE.md §LinkedIn and SPEC §9b — so
  buildVoyagerHeaders now presents as desktop Chrome with the web app's
  x-li-track/x-li-lang/x-li-page-instance headers. The narrower
  no-evasion terms deliberately still hold: one static fingerprint (no
  per-request randomisation), no proxy rotation, no CAPTCHA/challenge
  solving, fail-loud-and-stop on refusal — and the pacing/page-cap/
  never-log safeguards are untouched. Still an undocumented API that
  will break on LinkedIn's schedule; awaits its first live run with a
  real session.

- ✅ **LinkedIn browser extension** (owner amendment, 2026-08-20, SPEC §9c)
  — the sync that actually works, and the end of the §9b saga. Diagnosis
  first: the redirect trail showed a `__cf_bm` cookie, i.e. Cloudflare
  bot management, which fingerprints the TLS handshake before any header
  is sent. A Node process cannot pass that check however it presents
  itself, which is why three rounds of header work failed; the
  commercial products (Dex included) sidestep it by running *inside* the
  browser, where there is nothing to fake. `extension/` is an unpacked
  MV3 Chrome extension whose content script pages Voyager from a real
  linkedin.com tab and POSTs raw pages to
  `/api/linkedin/extension`, token-paired because a SameSite=Lax session
  cookie can't travel cross-origin. Parsing and import reuse §9b's
  tested parser and the shared import core, so ZIP/§9a/§9b/extension all
  land through one identity ladder. Reverses CLAUDE.md's "no browser
  extension that scrapes LinkedIn" non-goal, recorded there. Verified
  live by the owner: 40 connections, then a paging fix (a page adding
  nobody new stopped the run after the first one) and an explicit
  `stopReason` so "that's everyone" is distinguishable from "paging
  broke". **Known gap: it does not yet bring locations in.** Voyager's
  connection records may carry one, but `LinkedInConnection` has no
  location field and the parser doesn't read one, so /map stays empty
  from this path — a correction to an earlier claim here that the
  extension was the route to locations.

- ✅ **Network updates: Dex-style diff + email** (owner request,
  2026-08-22, SPEC §5, migration 0015: `contact_changes.notified_at`).
  The Today cards now read as diffs — old value struck through, new
  value in the success colour, age on the right — the same grammar the
  email uses, so the two surfaces don't describe the same move
  differently. The email is a new `network_updates` scheduler sweep
  (15 min, one indexed SELECT when there is nothing new, gated on the
  Settings toggle *and* SMTP actually being configured). Deliberately
  edge-triggered rather than folded into the daily digest: the digest
  mirrors Today at send time and would repeat a change every morning
  until it's dismissed, whereas `notified_at` makes this exactly-once —
  silence for weeks, then an email minutes after an import found a move.
  Stamp-after-send, so a crash re-sends rather than swallowing news.
  Superseded rows get stamped too (one move per person per field in the
  email, but nothing left to resurface). Settings gains the toggle and a
  "Send network updates now" button that runs the real sweep.

- ✅ **LinkedIn profile-location enrichment** (owner request, 2026-08-23,
  SPEC §9d, migration 0016: `contacts.location_checked_at`). Diagnosis
  first, again: the map was empty because the connections endpoint carries
  no geography *at all* — verified live by enumerating every key at every
  depth of a real response. Not a parser bug, and not fixable on that
  path; the export ZIP has no location column either. Location exists only
  on the individual profile, one request per person, and that cost dictates
  the whole design: a capped daily trickle (100/day, ceiling 300, 4 s
  apart) driven by the extension while the owner browses, ordered starred →
  cadence → recently-interacted → newest so the map is useful on day one
  rather than complete on day twenty-two. ~2200 connections ≈ three weeks.
  `location_checked_at` is stamped on every attempt including misses, so
  the queue advances instead of re-offering placeless people; re-checks
  after 180 days. Results feed `executeLinkedInRows` like every other
  LinkedIn source, so provenance is inherited — an owner-typed location
  conflicts rather than being overwritten — and `LinkedInScalarField`
  gains `location`, deliberately *not* as a job change (moving city is not
  a reason to reach out). Extraction is structural, like §9b's parser, and
  an all-placeless round of ≥10 is reported as suspected shape drift
  rather than a clean run. Off by default; the toggle is the consent.
  **Known stub: the profile endpoint candidates are unverified** — the
  extension tries three known forms and remembers whichever answers, but
  none has been confirmed against live LinkedIn. Everything else is
  verified end-to-end against a real database.

- ✅ **City placement via Nominatim** (owner request, 2026-08-24, SPEC
  §7a, decision #4 delivered; migration 0017:
  `contacts.geocode_attempted_at`). The owner asked for an external API
  "as long as it's free" after seeing Dex's city-level map; Nominatim is
  the one geocoder with no account, no key, and no tier — and the
  architecture had been waiting for it (allowlist entry, `geocode` job
  kind, lat/lng columns all pre-reserved). A recurring job geocodes each
  *distinct location string* once at Nominatim's 1 req/s, most-shared
  first, batches of 150 under the job lease, misses stamped and retried
  after 90 days, answers fanned out to every contact sharing the string
  (~2200 contacts ≈ a few hundred lookups, done in an hour or two).
  Only the location text is ever sent. Every location write path clears
  stale coordinates so moved contacts re-geocode. On the map, geocoded
  contacts become city pins — greedy ~5 km anchor clustering (a grid
  would split points straddling a cell boundary; the unit test that
  caught exactly that is in the battery), order-independent, labeled by
  the most common string's city half — with click-to-list, a "By city"
  side ranking, and OSM attribution. Each person appears exactly once:
  pin when geocoded, country bubble otherwise. Rendering stays bundled
  d3 — no tile server, no Mapbox account. Off by default; the Settings
  card is the consent and shows pinned/total progress. Verified
  end-to-end with a stubbed transport: one lookup placed two contacts,
  the miss stamped without a pin, second run no-oped.

- ✅ **Mapbox globe rendering** (owner request, 2026-08-24, SPEC §7a +
  CLAUDE.md privacy-invariant amendment; dependency: `mapbox-gl`, a WebGL
  vector-tile renderer nothing existing covers). The owner chose to make
  a Mapbox account after seeing the pins working; rendering swaps to the
  interactive Dex-style globe when a public token is pasted in Settings →
  Map rendering, and back to the bundled SVG when cleared — same city
  pins, same country bubbles (spherical centroids via geoCentroid), same
  click-through URLs, so the side panel is renderer-blind and the E2E
  suite keeps exercising the token-less fallback. Division of labour
  stands: Nominatim finds coordinates (free, cached in the DB), Mapbox
  only draws them; tiles load in the owner's browser with their own
  token. Token validated as pk.…, stored plain (public by design),
  account.mapbox.com added to the no-phoning-home owner-link carve-outs.
  Verified: production build clean with the dynamic import, 478 unit
  tests, map E2E green on the fallback path. Awaits first live render
  with the owner's real token.

- ✅ **Responsive pass** (owner request, 2026-08-24, SPEC §12 note) —
  Tailscale put Rolo on the owner's phone, which made the desktop-first
  layouts a real problem rather than a theoretical one. Everything is
  `md:`-gated so desktop is pixel-identical: below it, the fixed sidebar
  becomes a sticky top bar + slide-over drawer reusing the same nav
  content (open-state derived from the pathname it was opened on, so
  navigating closes it without a setState-in-effect); profile, settings,
  and map stack their side panes under the main column as one scrolling
  document (the Mapbox globe gets a 55dvh slice so the list below stays
  reachable); the contacts table slims to name-first with columns
  returning at sm/md/lg; Today rows drop the headline column on phones;
  and a global CSS rule renders controls at 16px below md — phone Safari
  zooms into any focused input under 16px, which Rolo's 13px density
  triggered on every tap. Full E2E suite green at desktop viewport.

- ✅ **Settings redesign** (owner request, 2026-08-24, Dex parity, SPEC
  §12 note). One endless scroll became the Dex anatomy: a grouped sub-nav
  rail (?tab= links, all server-rendered) and one section at a time in a
  centered column of label-left/control-right card rows. The structural
  change under the styling: the monolithic settings action split into
  per-section actions that each write only their own keys — the moment
  the form splits across pages, a single all-keys action would let one
  section's save wipe every other section's values with parsed-empty
  defaults. Sections also load only their own data (integrations status,
  backup status, custom fields are fetched per tab). Full E2E suite
  re-run green after the restructure.

- ✅ **Dex parity round 2: message snippets, profile anatomy, editable
  list** (owner request, 2026-08-23, SPEC §1/§2 amendments, no schema
  change). (1) messages.csv's CONTENT column was parsed away — every
  message interaction sat titleless. Now a bounded 160-char snippet lands
  in `interactions.title`; re-imports backfill pre-snippet rows via an
  upsert whose setWhere targets exactly title-IS-NULL (partial-index
  conflict target restated; verified against a real DB — dupes still
  count zero). Owner-exported content, not a Gmail-invariant issue.
  (2) Profile page restructured to Dex's anatomy: identity header with
  icon-per-channel row, Added/Last/Next/Frequency stat row, Recent
  interactions strip ("You: Hi Kate…" + relative age), timeline center
  stage, reference fields in a right sidebar. Brand glyphs are three
  inline SVGs (lucide dropped its brand set). (3) Contacts list edits
  like Notion cells: Title/Company click-to-edit in place through a
  single-field action that flips only the touched field's provenance
  (no-op commits flip nothing — false-conflict guard), Frequency picker
  in the row, social-link icons, last-touch age column.

478 unit tests + 15 Playwright E2E tests passing as of the responsive pass. Open questions from SPEC.md's decision
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
