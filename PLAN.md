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

- ✅ **September round: meeting prep, People you met, resurfacing, extension
  v0.3** (owner requests, 2026-09-04, migration 0018). (1) Pre-meeting
  brief (SPEC §9e): a `meeting_prep` sweep builds a brief per upcoming
  calendar event with a contact attendee — role, last email, open
  changes — emailed ahead of time when SMTP is set, shown on Today's
  agenda otherwise; `calendar_events.prep_json`/`prepped_at` as the
  exactly-once ledger. (2) People you met (SPEC §9f): correspondents and
  attendees the Gmail/Calendar syncs keep seeing who aren't contacts
  accumulate in `contact_suggestions`; Today shows the top few, /people-
  you-met the queue; one click adds them with the history already seen,
  one click dismisses. (3) Worth reconnecting (SPEC §3): a daily handful
  from the un-cadenced tail with real history and a long silence, scored
  in `lib/resurface`, stamped on `contacts.resurfaced_at` so picks rotate.
  (4) Extension popup v0.2 + v0.3: status endpoint (`GET
  /api/linkedin/extension`), live progress and Stop, badge; profile
  capture from the page you're on (`/lookup`, `/capture`); logging the
  conversation you have open (`/messages`, reversing the README's
  "no messages" term on the owner's instruction); opt-in weekly sync via
  `chrome.alarms`. Missed by this log at the time; recorded 2026-09-19.

- ✅ **Cleanup pass after the first outage** (2026-09-19). The owner's
  instance had been silent for eleven days: the SQLite file on a Windows
  Docker Desktop bind mount came back `SQLITE_CORRUPT` on Sept 8 (Today
  crashing, every backup 0 bytes), the local `package-lock.json` had
  drifted so the image could not rebuild, and the server predated the
  extension's status endpoint. Recovered without restoring the Sept 7
  backup: `scripts/rebuild-sqlite.mjs` copies every table into a fresh
  file and rebuilds the FTS indexes (41/42 tables clean; the one that
  wouldn't read, `contact_suggestions`, is derived and refills from
  sync). Then the fixes the outage exposed, each its own commit:
  - **§9b retired.** The cookie-session Voyager sync never passed
    Cloudflare and had spent eleven days failing five times an hour; the
    card, job, pager and cookie parser are gone, the structural parser
    stays for §9c. Extension runs record as `linkedin_extension_sync`.
  - **Scheduler:** the next run of a recurring job is spaced from its
    newest terminal row, dead included — counting successes only meant a
    job that had never succeeded came straight back after its fifth
    failure (the storm behind ~400 empty backup files).
  - **Backup:** a failed `VACUUM INTO` no longer leaves its partial file.
  - **Job changes (SPEC §5):** one extension sync had mailed "475 people
    changed jobs" — headlines compared against ZIP positions. Headline
    rule (a headline-derived title never changes a stored one) and
    baseline rule (a run moving >20% of matched people, ≥25, records its
    differences dismissed + notified and says so in the report). Plus
    "Dismiss all" on Today.
  - **Health banner:** dead integrations (Google's 7-day Testing-status
    token expiry named in the message), failing sync and email jobs, and
    the backup all surface on every page (`lib/health.ts`, unit-tested).
  - **Extension v0.3.1:** the popup shows Rolo's actual reply, names a
    404/405 as "Rolo out of date" with the update command, and the weekly
    run reloads an unresponsive LinkedIn tab before giving up.
  - DEPLOY.md gains the corrupt-database drill and a Windows section
    (named volume instead of a bind mount — the likely cause).
  Still open from the same review: connect the LBS-forwarding Gmail
  (owner-side; weekly reconnect expected), an ICS feed for the LBS
  calendar (proposed), the three stale `claude/*` branches on GitHub.

- ✅ **Late-September rounds** (2026-09-20 → 09-26; recorded 2026-11-19
  from the commit log, which this status list had fallen behind).
  - **Sync hardening after the first live Gmail backfill** (09-20): quota
    pauses keep their place, bulk mail is not a conversation, changing "my
    addresses" rescans, the owner is never a matched attendee, a finished
    backup survives a later failure, late-added emails still get briefs.
    Today puts the agenda second and caps job-change cards. Second phone
    pass (Today, timelines, reminders, contacts, Duplicates, Settings).
    DEPLOY.md gains "Moving from a laptop to a VPS".
  - **Gemini** (09-20) and **OpenAI** (09-26) as third and fourth AI
    providers through the shared OpenAI-compatible adapter.
  - **Notes** (09-22): formatting toolbar, formatted notes in Log
    interaction, a counting note counts for everyone it @-mentions.
  - **AI layer, second generation** (09-26, migration 0019
    `ai_annotations`): the owner's voice guide, drafts in the owner's
    voice (replacing conversation starters), the iterative Ask (plan →
    retrieve → read timelines → answer), "what I know" profile cards and
    the `ai_enrich` job, job-change triage with reasons and openers,
    post-meeting follow-up, the digest's written brief. LinkedIn messages
    keep their full text (4,000 chars) in `interactions.meta`.
  - Reminders editable in place; search reachable without a keyboard; a
    dozen fixes behind those features (timezone/locale rendering, triage
    loops, annotation cleanup, extension v0.3.2).
- ✅ **October** — push-to-deploy (`scripts/autodeploy.sh`, 10-08: the
  server follows `origin/main` from cron); the §9d location-fill daily cap
  is editable in Settings (10-28). The wordmark was turned emerald on
  10-08 and restored to the theme's primary colour on 11-19.

589 unit tests (60 files) passing, lint and typecheck clean, as of
2026-11-19. Playwright the same day: 20 tests, 18 passed in the full run;
`06-quick-add` failed once on its first keypress (`q` sent before the
page had hydrated on a cold dev compile) and its dependent test did not
run — both pass when the spec is run alone. A test-timing flake, not a
product bug; the spec wants a wait like the one `01-today-flow` got on
09-22. Open questions from SPEC.md's decision list are all resolved with
the owner; see that section before revisiting them.

- ✅ **Phase 13 — agent connector groundwork** (2026-11-19, migration
  0020, SPEC §14). The owner accepted all eight recommendations of the
  connector plan (last section of this file); they are recorded in
  CLAUDE.md (the API non-goal amended, a new "Agent connector" terms
  block), SPEC §14 and decision 8, and SCHEMA.md. No visible feature —
  the app is now drivable by something other than a browser session:
  - **Auth-free cores.** `executeFilter` (queries.ts), `recordInteraction`
    / `addNote` (interaction-core.ts), `createReminder` /
    `completeReminder` (reminder-core.ts), `findOrCreateTag` /
    `setTagMembership` / `setGroupMembership` (membership-core.ts), and
    `matchContact` / `applyImportRow` (import-engine.ts). The actions
    behind Log interaction, the quick log, "Reached out", new notes, the
    Reminders page and the bulk tag bar are now wrappers over them, so
    the owner's clicks and the connector will run the same code. Cores
    take no session, revalidate nothing, return what they touched, and
    report bad input instead of throwing.
  - **`agent` as a source.** The import planner needed no change: an
    agent write fills empty fields, overwrites only its own, and is a
    reported conflict against anything the owner or another source set.
    `recordInteraction` is idempotent on `sourceKey` and applies the §3
    touch rule itself, so an inbound email logged by an agent cannot
    reset a keep-in-touch clock.
  - **Ledger tables** `agent_grants` (hashed tokens, authorization-code
    leg, refresh rotation with replay detection) and `agent_calls` (one
    row per tool call, undo data, idempotency key). Nothing writes them
    until Phase 14.
  - **Not in this phase after all:** the login attempt throttle, done as
    its own change in a separate session and merged into this branch at
    the start of Phase 14; the hosting question (§4.4) was answered by the
    owner the same day — Rolo is on a public HTTPS domain.
  - Also fixed: `e2e/06-quick-add` pressed `q` before the page had
    hydrated and lost the keypress on a cold compile (it failed in both
    full runs today and passed alone); it now presses until the dialog
    answers.
  - Verified: `npm run check` clean with 615 unit tests (589 before; 26
    new — the cores against a migrated database with `requireAuth` and
    `revalidatePath` mocked to throw, the planner as source `agent`, the
    ledger constraints); Playwright 20 of 20; `next build` succeeds.
  - Read ahead for Phase 14 (`node_modules/next/dist/docs/01-app/
    03-api-reference/03-file-conventions/route.md` and the
    backend-for-frontend guide): route handlers take a Web `Request` and
    return a `Response`, which is what the MCP server package's handler
    wants; `app/.well-known/<name>/route.ts` is a supported way to serve
    the OAuth metadata documents; `GET` handlers are dynamic by default
    since Next 15, so no caching opt-out is needed.

- ✅ **Phase 14 — the read-only connector** (2026-11-19, SPEC §14; no
  migration — the tables came with Phase 13; dependency:
  `@modelcontextprotocol/server`). Claude can sign in to Rolo and read it.
  - **Consolidated first:** the login-throttle branch
    (`claude/sharp-albattani-j6dsr4`) is merged here, and its password
    check lifted into `lib/auth/password-gate.ts` so the login form and
    the connector's consent screen share one function and one lockout.
    One merge of this branch now brings Phases 13 and 14, the throttle and
    the wordmark fix.
  - **Owner refinements recorded:** an agent logs real exchanges only,
    never noise (a Phase 15 rule, in CLAUDE.md and SPEC §14); the outbox
    of Phase 16 is to be called "Drafts to send"; sent mail the owner
    writes directly in Outlook reaches Rolo by forwarding or BCC, as now.
  - **Sign-in:** discovery documents, stateless dynamic client
    registration (a client id is its own signed registration), a consent
    screen that asks for the Rolo password, single-use PKCE-bound codes,
    hour-long access tokens tied to the connector's address, rotating
    refresh tokens with an idempotent 60-second repeat window and
    revocation on replay, every secret stored as a hash, two-click
    Disconnect in Settings.
  - **Nine read-only tools** — `rolo_overview`, `search_contacts`,
    `list_companies`, `get_contacts`, `find_contact`, `get_timeline`,
    `search_notes`, `get_today`, `get_voice_guide` — strict arguments,
    answers capped at 60,000 characters, one `agent_calls` row per call.
  - **A precise search for agents** (`findContactsPrecisely`): the ⌘K
    search forgives typos and shows ten of at most eighty candidates; an
    agent needs every match and no near-misses, so words must begin a word
    in name, company, title, location or bio, and the list is complete.
    Found by the tests: "ana" was matching "M-ana-ging Director".
  - **Settings → Claude connector:** the address to paste, connected apps,
    recent activity. DEPLOY.md gains "Connecting Claude".
  - **Deviations from the plan** (reasons in SPEC §14): dynamic
    registration supported rather than one pre-registered client; the
    consent page asks for the password itself instead of sitting behind
    the session; the no-phoning-home test gained a carve-out for Claude's
    callback hosts; a call the protocol layer rejects for malformed
    arguments is not logged because it never reaches a tool.
  - **Reviewed twice before the summary.** An independent adversarial
    pass over the sign-in and tools found no critical or high problem and
    six worth fixing, all fixed with tests (SPEC §14 lists them): retired
    refresh tokens now always end their grant, the repeat window is 10 s,
    stranger-facing bodies are bounded before being read, an old code
    cannot disconnect the owner, registrations always fit their id, the
    overview cannot outgrow its cap. And the official MCP client library,
    pointed at the production build, signed in entirely by itself —
    discovery, registration, PKCE, consent in a real browser, token
    exchange — listed the nine tools, called one, and recovered from a
    spoiled access token by refreshing.
  - **`ROLO_BIND`** (docker-compose.yml, optional): `127.0.0.1` stops the
    container answering on port 3000 from the internet around Caddy.
    Default unchanged. Found by the review; it predates the connector.
  - **Verified:** `npm run check` clean with 778 unit tests (615 after
    Phase 13; 22 came with the throttle branch, 141 are new); Playwright
    28 of 28; `next build` succeeds and the standalone server, started the
    way the Docker image starts it, answers every connector endpoint
    behind proxy headers with nothing in its error log.
  - **Not verifiable here:** the live connection from claude.ai. The build
    sandbox cannot reach the deployment, so "add the connector and ask a
    question" is the owner's first check after merging (DEPLOY.md lists
    three `curl` checks to run first).

- ✅ **Phase 15 — write-back** (2026-11-19, SPEC §14; no migration — the
  ledger's columns came with Phase 13 and its two new statuses are plain
  text; no new dependency). Claude can keep Rolo current.
  - **The `write` scope is the owner's tick.** Claude asks for `read` and
    `write`; the consent screen shows a ticked "Also let it add to Rolo"
    box, and the grant can write only if it is still ticked. A connection
    made before this phase stays read-only until the owner reconnects.
  - **Seven write tools** — `log_interaction`, `add_note`,
    `create_reminder`, `complete_reminder`, `upsert_contact`,
    `tag_contacts`, `undo_agent_action` — each a strictly validated front
    for a Phase 13 core. Still no tool deletes, merges, archives, exports,
    changes a cadence, touches settings or sends anything.
  - **Signal, not volume, enforced:** `log_interaction` requires a message
    category and refuses newsletters, notifications, automatic replies and
    bounces; the server instructions for a write grant say the rest.
  - **The same message never lands twice:** idempotency keys ledgered per
    contact (one email to two people is one row each), a near-duplicate
    guard that joins a forwarded copy to the original whatever wrote it,
    undone and rejected calls that stay that way — and Rolo's own Gmail
    sync now checks for the agent's row before adding its own.
  - **Who is this, without guessing:** `upsert_contact` goes through the
    import planner as source `agent`; an owner-edited or owner-emptied
    field is a reported conflict; a namesake stops and asks; a shared
    address or a second LinkedIn profile is refused or reported.
  - **Every write is one transaction with its ledger row**, and **undo**
    reverses exactly that row's records — checking first that each row is
    still the one written and that the owner has not built on it.
  - **Review mode** ("Ask me first" in Settings): a write is rehearsed in
    a rolled-back transaction, refused at once if it would be refused, and
    otherwise queued whole for Approve / Reject on the activity page.
  - **For the owner:** `/agent-activity` (what changed, Undo, Approve,
    Reject), a "Claude" mark on timeline rows and notes an agent wrote,
    the write-mode switch and "Read and add" label in Settings.
  - **Decided while building, cheap to reverse** (SPEC §14): the write box
    starts ticked; at most 50 new contacts in 24 hours and two new tags
    per call; a rejected proposal's key stays burned; in review mode an
    undo is queued too.
  - **Found by the tests while building:** `!![x](url)` survived the
    image filter; "this is a different person" was matched to the
    namesake anyway; a LinkedIn link was accepted if it merely contained
    `linkedin.com`.
  - **Reviewed adversarially after the first commit.** The read-scope
    gate, the server-action surface, key replay, atomicity and the note
    sanitiser held. Ten defects were confirmed and fixed with regression
    tests (SPEC §14 lists them); the serious ones were in undo — SQLite
    reuses freed row ids, so undo could remove an unrelated row, and
    removing an added contact took the owner's later additions with it.
  - **Verified:** `npm run check` clean with 878 unit tests (778 after
    Phase 14); Playwright 31 of 31; `next build` succeeds, and the whole
    write flow was run against the standalone production build and its
    screens looked at (before the review fixes; the unit and browser
    suites were re-run after them).
  - **Not verifiable here:** the live flow from claude.ai — reconnect with
    the box ticked, then "go through this week's forwarded mail and update
    Rolo".
  - **Added after first use, the same day:** `set_cadence`. "Put Chris in
    the CRM to reconnect every 3 months" had nowhere to land — cadence had
    been left out as the owner's to set, and the owner asked for it. It
    shares the Keep-in-touch page's rule (`cadence-core.ts`), takes up to
    50 contacts, records the state it replaced and is undone like any
    other write. Eight write tools, seventeen in all.
  - **Known stubs:** none.

- 🟡 **WhatsApp, per person — step 1 of 3** (2026-11-19, SPEC §15;
  migration 0021: `whatsapp_links`, `whatsapp_messages`; no new
  dependency). The owner's design: everything per person, driven from a
  panel on the contact.
  - **Built:** the panel (link by number and saved name, sync toggle,
    "import history from", phone-export upload, summary, confirmed
    delete); the iPhone / Android export parser; ingest that is
    idempotent within a source, across the two sources, and against
    purged text; one derived timeline row per day, where only what the
    owner sent resets the clock; the collector's server contract (token,
    `wants`, delivery, the filter applied twice); retention — 90 days of
    exact text, then cleared only when inside Claude's rolling summary
    and a week after; three connector tools (`list_whatsapp_chats`,
    `get_whatsapp_chat`, `save_whatsapp_summary`), the saved name on
    profiles and in `find_contact`; merge and contact-delete handling.
  - **Found by the tests while building:** two summary updates in the
    same millisecond let the older one be undone into the wrong version
    (the marker is now strictly increasing, and an undo cannot be
    repeated into a version that no longer exists); a repeated edit
    inside one delivery was counted twice.
  - **Verified:** `npm run check` clean with 955 unit tests (889 before);
    Playwright 35 of 35 (4 new); `next build` succeeds and the panel was
    exercised on the standalone production build.
  - **Known stubs / not built:** the laptop collector and its Settings
    card. The sync toggle and "import history from" are stored and
    served to the collector endpoint, but nothing calls that endpoint
    yet — the panel says so, and the endpoint is closed because no token
    exists. Automatic sync depends on `collector/probe.mjs` showing that
    WhatsApp Desktop's files can be read at all.
  - **Step 2** (after the probe): the collector, the token card, and the
    owner's "message him and see it" check. **Step 3:** a scheduled
    Claude routine that keeps the rolling summaries current.

**Next: Phase 16 — the outreach loop.** Worth doing first: a week of real
use of write-back. Which exchanges Claude logs, what it leaves out and
what gets undone is the best input to "Drafts to send" and the campaign
page.

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

---

# The agent connector (Phases 13–18) — proposed 2026-11-19

**Status: accepted by the owner on 2026-11-19 — "go with your
recommendations" — covering all eight decisions in §4.** Phase 13 is
built (see the status list above); Phases 14–18 are not. The title keeps
its "proposed" date; the decisions now live in CLAUDE.md, SPEC §14 and
SCHEMA.md, which win over this section wherever they differ.

## 1. The vision

Rolo stays the memory and the hands; Claude becomes the brain. The owner
states a goal in plain words ("I am recruiting for tech investment
banking; I want conversations at the best firms") and the loop runs:

```
goal → who fits (and who is missing) → drafts in my format → I send
     → replies are read → Rolo is updated → follow-ups surface → repeat
```

Claude reaches Rolo through a connector built for it (an MCP server), and
reaches the owner's mail through the Gmail connector on the forwarding
mailbox. Rolo never calls a model for this path: every judgment is
Claude's, every write is Rolo's own deterministic code.

This is the existing product loop — capture automatically, surface who is
due, make reaching out one click — pointed at a goal instead of a cadence.

## 2. What was checked before writing this (2026-11-19)

Code and repository:

- `npm run check` is green: lint and typecheck clean, 589 unit tests.
- Every read and write the connector needs already exists, but behind
  cookie-gated server actions (`runFilter`, `logInteractionAction`,
  `createReminderAction`, …). `requireAuth()` redirects when there is no
  session cookie, so a route handler cannot call them. The logic has to be
  lifted into auth-free cores first.
- A bearer-token route pattern exists (`src/server/sync/extension-http.ts`,
  SPEC §9c). The import planner is source-generic (`ImportRow`), so one
  person arriving from the agent can go through the same identity ladder
  and provenance rules as a CSV row.
- `source` columns are plain TEXT with no CHECK: a new `'agent'` source is
  code and documentation, not a migration.
- What Rolo holds per LinkedIn connection is thin: name, headline or
  position, company, profile URL, sometimes location, messages. Profile
  capture reads name, headline and location only. Education and past roles
  are mostly empty; email addresses are rare.
- The login action has no attempt throttle.

The forwarding mailbox, read through the Gmail connector (read-only, a few
dozen headers and snippets):

- **Received mail arrives within seconds, but as a wrapper.** Each message
  is an Outlook forward: `FW: <subject>`, From the owner's school address,
  To the forwarding Gmail. The real sender, recipients, time and subject
  are the first lines of the *body*.
- **Sent mail is not forwarded automatically.** It arrives in manual
  bursts, days late (mail sent on the 10th and 17th was forwarded on the
  19th), in the same wrapper shape.
- Mail copied in before mid-June (label "LBS Archive", about 3,200
  messages) kept its original headers.
- The mailbox has sent one message and holds no drafts: nothing is ever
  written from it.
- Most of the volume is newsletters and job alerts wrapped the same way.

Consequence, confirmed in `src/server/sync/gmail.ts`: Rolo's own Gmail
sync is `gmail.metadata` only, so on a wrapper it sees "from me, to me",
finds no counterpart, and skips the message. **Rolo is structurally blind
to the school correspondence since June. Only something that reads bodies
can see who the owner is talking to** — which is exactly what Claude with
the Gmail connector does.

Connector requirements (researched against Anthropic's connector docs and
the MCP spec; re-verify at build time, they move):

- Claude calls a custom connector from Anthropic's cloud, over public
  HTTPS on port 443, IPv4. A Tailscale-only address is rejected.
- Transport is Streamable HTTP. Claude's hosted client still opens with
  the 2025-era `initialize` handshake although the spec has a 2026-07-28
  revision; the server must answer both.
- Sign-in is OAuth 2.1 with PKCE. A static bearer header exists but is
  beta-gated, and auth settings cannot be changed after adding the
  connector. The official TypeScript SDK no longer ships an authorization
  server; those endpoints are ours either way.
- One connector added in claude.ai is available on web, desktop, mobile,
  in Claude Code, and in scheduled cloud tasks that run unattended.
- Limits: about 150,000 characters and 240 s per tool call on claude.ai,
  25,000 tokens in Claude Code. Tools marked read-only can run without a
  prompt; the owner sets "always allow / needs approval / blocked" per
  tool.
- The Gmail connector can now send, reply and forward as well as read and
  draft (with approval by default).

## 3. The gaps

| # | Gap | Closed in |
|---|---|---|
| A1 | No agent-facing interface; logic sits behind cookie-gated actions | 13, 14 |
| A2 | Auth is a cookie; a connector needs OAuth and revocable tokens | 14 |
| A3 | The server must be on public HTTPS; no login throttle today | 13 (owner-side + fix) |
| B1 | Rolo cannot see school mail: counterparts live in wrapper bodies | 15 (agent logs it) |
| B2 | Sent mail reaches the mailbox days late, by hand | 16 (Outbox "Sent"), owner-side |
| B3 | Claude cannot send from the school account; Gmail drafts land in the wrong mailbox | 16 (Outbox + compose link) |
| B4 | The mailbox is mostly newsletters: reading it all is slow and costly | 17 (triage query, cursor) |
| B5 | Calls get booked in the school's Outlook calendar, which Rolo does not see (the ICS feed proposed in September was never built) | 16 (agent records the call), ICS feed optional |
| C1 | The people being emailed are often not in Rolo at all | 15 (`upsert_contact`) |
| C2 | Profiles are thin: no education, few past roles, few emails | 18 |
| C3 | No way to scan the network by employer; company names are unnormalised | 14 (`list_companies`) |
| D1 | No notion of a goal, a target list, or where each person stands | 16 |
| D2 | Drafts are produced one at a time in a dialog and not kept | 16 |
| D3 | Nothing surfaces "sent a week ago, no reply" | 16 |
| E1 | Three written rules forbid this as stated (API non-goal, "AI never writes directly", third-party data flows) | 13 (owner decisions) |
| E2 | Claude will read mail from strangers while holding write access to the CRM: prompt-injection exposure | 14–17 (design rules in §5) |
| E3 | No record of what an agent did, and no undo | 13, 15 |
| F1 | Unattended runs start with no memory: they need a cursor and idempotent writes | 15, 17 |

## 4. Decisions for the owner

Each has a recommendation. **All eight were accepted as recommended on
2026-11-19.** Item 4 still needs a fact from the owner: whether the
public address exists yet.

1. **Amend the "public third-party API" non-goal** to allow one
   owner-only MCP endpoint. *Recommended: yes — it is the owner's own
   agent, authenticated as the owner, not an API for third parties.*
2. **Amend "no AI call ever writes user data directly" (SPEC §11).**
   *Recommended tiers:* (a) appended, attributed, undoable writes apply
   directly — interactions, notes, reminders, drafts, tag and group
   membership; (b) contact fields go through the provenance rules as
   source `agent`, so an owner-edited field is never overwritten and
   conflicts are reported back; (c) new contacts are created directly but
   flagged and listed for one-click undo; (d) delete, merge, archive,
   export and settings are never exposed. A Settings switch can demote
   (a)–(c) to "queue for review" at any time.
3. **Accept the data flow.** Tool results put contact names, roles, notes
   and message text into Claude conversations (Anthropic, under the
   owner's claude.ai account terms and training setting, not the API
   terms the in-app AI uses). Notes the agent writes will contain
   summaries of email content. The Gmail invariant itself is untouched:
   Rolo's own sync stays metadata-only. *Recommended: accept, and record
   it in CLAUDE.md beside the other owner amendments.*
4. **Hosting.** Is Rolo on the VPS with a public domain (DEPLOY.md), or
   still on the laptop / Tailscale? The connector needs the former.
   *Recommended: VPS + Caddy; expose the app as today, nothing new to
   open.*
5. **Auth model and schema.** An OAuth authorization server inside Rolo
   (the password gate is the consent screen) and migration 0020 with two
   tables: `agent_grants` (hashed access and refresh tokens, scope,
   expiry, last used, revoked) and `agent_calls` (one row per tool call:
   tool, arguments, outcome, what it changed, undo data). *Recommended:
   yes; `settings` JSON is the wrong place for rotating tokens.*
6. **One dependency:** `@modelcontextprotocol/server` (v2; depends only
   on its core package and zod 4, already here). It answers both protocol
   eras. Hand-rolling is ~200 lines but makes the protocol migration
   ours. *Recommended: take the dependency.*
7. **Goal model.** *Recommended for v1, no schema change:* a campaign is
   a Rolo **group** plus a brief stored in settings; a person's stage is
   **derived from interactions**, the way `next_touch_at` is, never typed
   in. Dedicated campaign tables only if one status per person per
   campaign proves necessary. This keeps clear of the "deal pipeline"
   non-goal: there are no stages to drag, only facts about who wrote to
   whom.
8. **How sent mail is captured.** *Recommended:* the Outbox's "Sent"
   click is the record (Phase 16); the agent reconciles the forwarded
   copy when it eventually arrives. Optional owner-side upgrade: forward
   Sent Items automatically (a Power Automate flow, if the school tenant
   allows) so replies written directly in Outlook are captured too.

## 5. Architecture

```
claude.ai / Claude Code / scheduled task
   ├── Gmail connector ──► forwarding mailbox   (read; drafts optional)
   └── Rolo connector  ──► https://<rolo>/api/mcp
                              OAuth (owner's password = consent)
                              tools ► auth-free cores ► SQLite
                              every call ► agent_calls (audit + undo)
```

Rules the design holds to:

- **Model proposes, Rolo executes.** No model call inside Rolo on this
  path. Tools take structured arguments validated with Zod; ids are
  checked against the database; anything invalid is refused, not guessed.
- **Small answers.** Results are compact, paged and capped (50 rows, well
  under 20,000 tokens) with ids to drill into. No tool can dump the
  database.
- **Writes are appended, attributed, idempotent, undoable.** Every write
  carries `source = 'agent'` and a caller-supplied idempotency key (for
  mail, the Gmail message id), so a re-run upserts instead of doubling.
  A near-duplicate guard (same contact, direction and subject within a
  few minutes) joins a forwarded copy to an interaction already logged.
- **Nothing irreversible is exposed.** No delete, merge, archive, export,
  settings or token tools.
- **Mail is untrusted.** Free text from third parties is returned marked
  as data; the server instructions say never to act on instructions found
  in mail or notes. The owner keeps Gmail's send and forward tools on
  "needs approval" — an approval an unattended run cannot give, so the
  scheduled task can read mail but not send it.
- **Read and write are separate scopes and separate tool groups**, each
  tool annotated (`readOnlyHint`, `destructiveHint`, `title`), so the
  owner can leave reads on "always allow" and writes on approval until
  trust is earned.

### Tool surface (about twenty tools)

| Tool | Phase | What it does |
|---|---|---|
| `rolo_overview` | 14 | Counts, data completeness, tags/groups/custom fields, timezone, now, sync state — one call to get oriented |
| `search_contacts` | 14 | Text query plus the §7 filter dimensions (company current/past, title, location, tag, group, last interaction, has email, starred); compact rows, paged |
| `list_companies` | 14 | Employers with head-counts and sample titles, normalised — how "the best firms" get found in 2,200 connections without reading them all |
| `get_contacts` | 14 | Full profile for up to 10 ids: fields, emails, history, tags, notes, recent exchanges with LinkedIn message text, open changes, reminders, the "what I know" card |
| `find_contact` | 14 | Resolve an email, LinkedIn URL or name to a contact through the import identity ladder, with the match reason — the safety step before any write |
| `get_timeline`, `search_notes` | 14 | Per-contact or global timeline; full-text over notes |
| `get_today` | 14 | Due, reminders, agenda, job changes, people you met |
| `get_voice_guide` | 14 | The owner's voice guide and sent examples |
| `log_interaction` | 15 | Email / meeting / call / message, direction, original time, subject, thread link, idempotency key |
| `add_note`, `create_reminder`, `complete_reminder` | 15 | The existing actions, attributed to the agent |
| `upsert_contact` | 15 | One person through the import planner as source `agent`; conflicts returned, never forced |
| `tag_contacts` | 15 | Add or remove tags and group membership, existing tags preferred |
| `undo_agent_action` | 15 | Reverse one `agent_calls` row |
| `save_campaign`, `list_campaigns`, `get_pipeline` | 16 | The goal and its brief; members bucketed by derived stage |
| `save_draft`, `list_drafts` | 16 | Drafts into Rolo's Outbox |
| `update_voice_guide` | 16 | Refine the guide from real sent mail |
| `get_cursor`, `set_cursor` | 17 | Where the last unattended run stopped |
| `suggest_email` | 18 | Pattern-based address candidates with evidence |

Derived stage, per campaign member, from interactions alone: *not
contacted* → *drafted* (an open draft) → *awaiting reply* (owner's last
email is newer than theirs; shows days waiting) → *replied — your move* →
*call booked* (a future calendar event, or an open reminder the agent
created for a call it saw being scheduled) → *met* → *dormant*. An
explicit "not pursuing" is a tag.

The in-app AI features (Ask, drafts, profile cards, triage) are untouched
and keep running on whichever provider is configured; the connector is a
second, stronger way in, not a replacement.

## 6. Phases

Rough size: 13 medium, 14 large, 15 medium, 16 large, 17 small (mostly a
prompt, a cursor and one digest section), 18 four small pieces. Rolo is
useful to Claude after 14; the loop in §1 is whole after 16; it runs by
itself after 17. Each phase ends with the usual ritual (`npm run check`
output, what is stubbed, what is next).

### Phase 13 — Groundwork (no visible feature) — ✅ built 2026-11-19

*As built: see the status list. Two deviations from the scope below —
the login throttle moved to its own change, and "search, contact detail,
timeline, today" needed no lifting because they were already plain
functions with no session check.*

**Goal:** the app is ready to be driven by something other than a browser
session, and the rules allow it.

**Scope:** record the §4 decisions in CLAUDE.md, SPEC.md (new §14 "Agent
connector") and SCHEMA.md; lift the logic of the server actions the tools
need into auth-free cores, leaving each action a thin `requireAuth()` +
core + `revalidatePath` wrapper (views/filter, search, contact detail,
timeline, today, notes and interactions, reminders, tags, groups); add
`'agent'` to the documented source enum and to the provenance rules
(behaves as a non-user source); migration 0020 (`agent_grants`,
`agent_calls`); login throttle; read the Next.js route-handler guide in
`node_modules/next/dist/docs/` before any route is written.

**AC:** `npm run check` output identical in count or higher; unit tests
call each core directly with no cookie; an agent-sourced field write
against an owner-edited field is a conflict (unit); E2E suite still green.

### Phase 14 — The read-only connector (first useful milestone) — ✅ built 2026-11-19

*As built: see the status list and SPEC §14, which now carries the
acceptance criteria.*

**Goal:** Claude can answer questions about the owner's network.

**Scope:** `POST /api/mcp` (stateless Streamable HTTP, JSON responses,
Origin check, 401 + `WWW-Authenticate` when unauthenticated); protected
resource and authorization-server metadata under `/.well-known/`;
`/oauth/authorize` as a page behind the password gate showing what is
being granted; `/api/oauth/token` (authorization code + refresh, PKCE
S256, exact `resource` match, rotating refresh tokens, tokens stored
hashed); one pre-registered public client with Claude's callback URLs
allowed, so no dynamic registration and no outbound fetch; scopes `read`
and `write` (only `read` grantable in this phase); the read tools;
server instructions; Settings → Connections → **Claude connector** card
(URL to paste, active grants with last-used time, revoke, recent calls);
DEPLOY.md section.

**AC:** protocol tests for `initialize`, `tools/list`, `tools/call` and
the newer discovery call; no token, wrong token, expired token, revoked
grant and wrong `resource` each get the right refusal; refresh rotates
and the old token dies; no tool output contains a secret (test over every
tool against a seeded DB); every result under the size cap on the 10k
seed; each call writes one `agent_calls` row; the §13 no-phoning-home
test passes untouched (the connector is inbound only).
**Manual check:** add the connector in claude.ai, sign in with the Rolo
password, ask "who in my network works in technology investment banking,
at which firms, and when did I last speak to each?"

### Phase 15 — Write-back: Claude keeps Rolo current

**Goal:** what happens in the mailbox lands on the right timelines.

**Scope:** the `write` scope and the write tools; the owner's
signal-not-volume rule (SPEC §14): `log_interaction` takes the kind of
message — reply, introduction, scheduling, decline, other-personal — and
refuses automatic kinds (bulk, alert, auto-reply, bounce), and the server
instructions say to leave out anything doubtful; idempotency keys and
the near-duplicate guard; `upsert_contact` through the import planner;
`undo_agent_action`; an **Agent activity** page (what was written, by
which tool, with undo) and an "added by Claude" marker on timeline rows;
the Settings switch between "apply" and "queue for review"; cadence
recompute on every agent write path (inbound-only mail still does not
reset the clock, SPEC §3).

**AC:** logging the same message twice writes one row; a forwarded copy
arriving after a logged send joins it; an email from someone not in Rolo
creates one contact, a second email from them creates none; undo removes
exactly what the call wrote and recomputes `next_touch_at`; an agent
write never overwrites an owner-edited field.
**Manual check:** in Claude, "go through this week's forwarded mail and
update Rolo" → open three contacts and see the exchanges, dated to when
they were actually sent.

### Phase 16 — The outreach loop

**Goal:** from a goal to sent emails in the owner's format, with follow-ups
that surface on their own.

**Scope:** campaigns (group + brief) and the derived pipeline; a
**Campaign page** (members by stage, days waiting); the **Outbox**: drafts
saved by Claude, each with *Open in Outlook* (compose link prefilled),
*Copy*, *Sent* (logs the outbound email interaction and retires the
draft) and *Discard*; Today gains "Awaiting reply" (7+ days, configurable)
next to the due queue; booked calls recorded as contact-attached reminders
at the call time, so they show on Today and can carry the post-meeting
follow-up; voice guide tools, so the owner's real networking emails become
the format; a checked-in **Skill** (`.claude/skills/rolo-outreach/` —
Claude Code reads it there, and the same folder zipped uploads to
claude.ai) holding the playbook: how to pick targets (relevance,
warmth, never several people in one team at once, never someone already
waiting on the owner), how to read a forwarded wrapper, how to write the
first email and the one-week nudge, what to log.

**AC:** stage derivation unit battery (each transition, including a
reply after a nudge and a bounce); a draft retires on "Sent" and on a
matching logged send; the compose link carries recipient, subject and
body intact for a 250-word email (fallback to Copy beyond the URL limit).
**Manual check:** "draft this week's ten" → ten drafts in the Outbox →
ten clicks → next morning the replies are on the timelines and the
non-repliers appear a week later.
**To verify first (15 minutes, owner-side):** whether the school's Outlook
accepts a prefilled compose link (`mailto:` and the web deep link), and
whether a `bcc` to the forwarding Gmail survives — if it does, sent mail
arrives instantly with real headers and Rolo's own sync sees it too.

### Phase 17 — Autopilot

**Goal:** Rolo updates itself; the owner reviews instead of asking.

**Scope:** a scheduled Claude task (twice on weekdays) with the Gmail and
Rolo connectors and the Skill: read mail since the cursor using a triage
query that drops bulk mail, match, log, classify replies (positive,
scheduling, decline, out of office, bounce), create the follow-up
reminders, prepare nudge drafts, advance the cursor, and leave one
summary note; the daily digest gains an "agent activity" section; a
health-banner entry when the task has not checked in for two days.
Rolo's write tools must be on "always allow" for this to work, which is
why it comes last: by then the activity page and undo have had weeks of
supervised use.

**AC:** two runs over the same mail write nothing the second time; a run
that fails half-way resumes without duplicates; the digest lists exactly
the rows in `agent_calls` since the last one.
**Manual check:** a week untouched, then the Agent activity page and the
mailbox agree.

### Phase 18 — Better data to aim with

**Goal:** the answers to "who should I contact" stop being limited by
thin profiles. Independent of 15–17; can start after 14.

**Scope, each its own owner decision:** (a) profile capture also reads
experience and education off the page the owner is viewing, feeding
`work_history` / `education` — zero extra LinkedIn requests, same terms
as §9c; (b) capture from a LinkedIn people-search page the owner has
open, as campaign prospects — same class of ToS risk as §9c/§9d and
needs the same explicit acceptance; (c) `suggest_email`: learn each
firm's address pattern from addresses Rolo already holds at that domain,
return candidates labelled as guesses with the evidence, and learn from
bounces the agent sees; (d) a firm-tier tag set the agent proposes and
the owner approves once.

## 7. Owner-side checklist (not code)

1. Answer §4.
2. Confirm the public URL; turn on push-to-deploy if it is not already.
3. Keep the Gmail connector's send and forward tools on "needs approval".
4. Check the claude.ai privacy setting that governs training on chats.
5. Try the compose-link test in Phase 16.
6. Optional: ask whether the school tenant allows Power Automate, to
   forward Sent Items automatically.

## 8. Risks

- **Prompt injection through mail.** Mitigated by the design rules in §5,
  not eliminated. The undo log and approval-gated send are the backstop.
- **The connector makes the server a more interesting target.** OAuth
  with short-lived tokens, hashed storage, revocation, the login
  throttle, and no irreversible tools.
- **Protocol churn.** The spec changed eras this year and Claude's client
  has not moved yet; the SDK dependency absorbs that.
- **Wrapper parsing is Claude's judgment, not a parser.** Idempotency,
  `find_contact` before every write, and undo keep mistakes cheap.
- **Cost.** Autopilot reads mail twice a day; the triage query and the
  cursor keep it to the handful of human messages.
- **Scope creep toward a sales pipeline.** Stages stay derived; no
  amounts, no probabilities, no bulk sending — Rolo never sends anything.

## 9. Available today, with no build

Settings → Data → export, then give `contacts.csv` to a Claude
conversation that also has the Gmail connector. Claude can already rank
targets from the file, learn the format from the forwarded sent mail,
and write drafts in chat. What the connector adds is live data, memory
between conversations, and the write-back.
