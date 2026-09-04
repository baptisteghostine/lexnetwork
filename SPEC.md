# SPEC.md — Rolo Product Specification

Single-user personal CRM. One job: **never lose touch with people who matter, without doing data entry.**
Loop: capture context automatically → surface who's due → make reaching out one click.

Conventions used below:
- "AC" = acceptance criteria, written as concrete checks.
- All timestamps stored UTC; all display and day-boundary logic uses the owner's configured timezone (a setting, default from the server's TZ).
- "Owner" = the single user.

---

## 1. Unified Contact Database

### Behavior
- A contact is one person, potentially assembled from many sources (manual, CSV, vCard, LinkedIn, Google Contacts, Gmail/Calendar auto-capture).
- Profile fields: first/last name, photo, title, company, location (free text, geocoded to lat/lng when a geocoder is configured), bio, work history (multiple rows), education (multiple rows), birthday (month/day required, year optional), emails (multiple, priority-ordered), phones (multiple, priority-ordered), social links (platform + URL), freeform rich-text description (markdown), related contacts ("who knows who", labeled edges).
- **Provenance per field:** every scalar profile field and every multi-value row records which source last set it (`user`, `csv:<run>`, `linkedin:<run>`, `google_contacts`, `gmail`, `calendar`) and when. The UI shows provenance on hover in the profile editor.
- **User edits always win:** once the owner hand-edits a field, imports may propose changes (as conflicts in the diff report) but never overwrite it silently.
- Custom fields: owner defines fields of type text, number, date, single-select, multi-select. They appear on every contact profile and are filterable.
- Tags: flat, colored, freely assignable. Groups: hierarchical (one parent max), each with an emoji; a contact can be in many groups.
- Star: boolean, prominent in lists. Archive: hides the contact from all default lists, search (unless "include archived" toggled), the Today queue, digests, and birthdays; archived contacts keep all data and can be unarchived.
- **The contacts list edits like cells, not like a form** (owner request, 2026-08-23, Dex parity): Title and Company are click-to-edit in place (Enter/blur saves, Escape cancels), Frequency is a picker in the row. One field per save, so provenance stays exact — only the touched field flips to `user`, and an untouched commit (click in, click out) flips nothing, or re-imports would see false conflicts. The list also shows social-link icons, and last interaction as a relative age.
- **Settings anatomy** (owner request, 2026-08-24, Dex parity): a grouped sub-nav rail (Preferences: General / Keep in touch / Notifications · Connections: Integrations · Data: Backup & export / Custom fields) with one section at a time in a centered column — title + subtitle header, then cards of rows (label and why on the left, control on the right). Each section is its own form with its own save action writing only its own keys, so saving one section can never wipe another's values.
- **Responsive** (owner request, 2026-08-24, after Tailscale put Rolo on the owner's phone): desktop layouts are unchanged from `md` up; below that the sidebar becomes a top bar + slide-over drawer (same nav content, drawer closes on navigation by derivation, not effect), the profile/settings/map side panes stack under their main columns as one scrolling document, the contacts table slims to name-first columns (`sm`/`md`/`lg` reveal the rest), and controls render at 16px so phone Safari stops zooming into every focused input.
- **Profile anatomy** (owner request, 2026-08-23, Dex parity): identity header (xl avatar, name, headline, location, one icon per way to reach them), a stat row (Added · Last interaction · Next touch · Frequency), the Recent-interactions strip (SPEC §2), then the timeline; reference fields (cadence, tags, fields, work history, education, custom fields, relationships) in a right sidebar.

### Edge cases
- Contact with no name (email-only capture from Gmail): display as the email address until named.
- Two emails with the same priority: order by priority, then insertion order. Priority is a small integer; 0 = primary.
- Birthday without year: age is never shown; sorting/filtering uses month/day only.
- Deleting a contact: soft concept doesn't exist — delete is hard, but requires typed confirmation and cascades (notes, interactions, etc.). Merge is the safe path; delete is for junk rows.
- Photo: stored on disk under `data/attachments/`, path in DB. Imports may bring a photo URL; we download it once at import time (this is one of the allowed network calls only when the import source provides a URL).

### Acceptance criteria
- [ ] Creating a contact with only a first name succeeds; with nothing at all fails validation.
- [ ] Adding a second email and marking it primary reorders the list and persists across reload.
- [ ] Hovering a field set by LinkedIn import shows "LinkedIn export · 2026-08-01".
- [ ] Editing a company by hand, then re-importing a LinkedIn ZIP with a different company, does NOT change the field; it appears in the import diff report as a conflict.
- [ ] Archiving a contact removes them from the contact list, Today queue, and digest; toggling "include archived" in search finds them.
- [ ] A custom multi-select field's options can be edited; values on contacts referencing a deleted option are surfaced (not silently dropped).

---

## 2. Interaction Timeline

### Behavior
- Per-contact timeline, reverse chronological, unioning: notes, email interactions (metadata), calendar meetings, message-app interactions (from LinkedIn messages.csv), reminders that fired, and field changes (`contact_changes`).
- Notes: markdown with live preview, autosaved (debounced ~800 ms, with a saved/saving indicator), attachments (file/image, stored under `data/attachments/`), and mentions:
  - `@Name` → autocomplete over contacts → stores a real `note_mentions` row → renders as a link to that contact; the note also appears on the mentioned contact's timeline.
  - `#Group` → same, for groups.
- Global timeline view across all contacts with filters: kind (note/email/meeting/message/reminder/change), date range, tag/group, contact.

### Edge cases
- Deleting a note removes its mentions and its attachments — attachments are owned by the note and are deleted with it, after confirmation showing the filenames.
- A mention of a contact that is later merged: mention rows are repointed to the winning contact by the merge.
- Autosave conflict (two tabs open on the same note): last write wins; this is a single-user tool. Documented, not "solved".
- Email interactions never show a body — there is none stored. The timeline row shows subject, direction, other participants, and a "open in Gmail" link built from the thread id.
- LinkedIn message interactions carry a **bounded snippet** of the message (160 chars, cut on a word) in `interactions.title` — a recognition aid ("You: Hi Kate, it's Baptiste from LBS…"), not an archive; the full text stays in the owner's ZIP. This is distinct from the Gmail rule above: Gmail bodies are a sync scope the owner never granted, whereas these are messages the owner deliberately exported and uploaded. Re-imports backfill snippets onto rows imported before this existed (title IS NULL only) without inflating link counts.
- The contact profile leads with a **Recent interactions** strip (Dex): the last three interactions with their snippet/title, direction ("You:" when outbound), and relative age — the "where were we?" answer before the timeline.

### Quick log — "Who did you meet?" (owner request, 2026-08-20)
- Global affordance (sidebar button, or `q` anywhere outside a text field): search contacts or type a new name, one line of what happened, a date (default today, never the future). Saves as a **counting manual interaction** — the keep-in-touch clock restarts from that date. An unknown name creates the contact (source `user`) in the same action.
- AC: `q` → new name → logged: the contact exists with the interaction on their timeline. Searching an existing name logs against them without creating a duplicate. (E2E-covered.)

### Acceptance criteria
- [ ] Typing a note and closing the tab within 2 s loses at most the last keystroke burst (autosave fired on debounce and on `beforeunload`/`visibilitychange`).
- [ ] `@Bob Sm` pops an autocomplete; selecting creates a link; the note appears on Bob Smith's timeline flagged "mentioned".
- [ ] Dragging an image into a note uploads it, renders inline, and the file exists under `data/attachments/`.
- [ ] The global timeline filtered to kind=meeting, last 30 days shows exactly the calendar-sourced interactions in that window.
- [ ] A fired reminder shows on the contact's timeline with its title and fire time.

---

## 3. Keep-in-Touch Engine (the heart)

### Behavior
- Per-contact cadence: weekly (7), monthly (30), quarterly (91), biannual (182), yearly (365), or custom N days. Cadence may be unset (contact not in the loop).
- `last_interaction_at` (denormalized on the contact) = max `occurred_at` of that contact's interactions where the interaction **counts for touch** (see below).
- **`next_touch_at` is derived, never hand-edited:**
  ```
  base = last_interaction_at  (or cadence_assigned_at if no counting interaction yet)
  computed = base + cadence_days
  next_touch_at = max(computed, snoozed_until)     # snooze can only push later
  ```
  Recompute triggers: interaction inserted/deleted/repointed for the contact; cadence changed; snooze set/cleared; merge. Recompute is a single pure function in `lib/cadence/` with unit tests; every write path calls it.
- **What counts for touch** (design decision — flag for review): outbound emails (owner is sender), calendar meetings that occurred, LinkedIn messages in either direction, manually logged interactions, and notes *if* the note's "counts as interaction" toggle is on (default on for notes created from the Today queue's "log interaction", off for plain notes). Inbound-only email does NOT reset the clock — someone emailing you is not you keeping in touch. Reminders firing and field changes never count.
- A contact is **due** when `next_touch_at <= now`. Overdue-ness = days past due, used for sorting.
- **Snooze one:** push `next_touch_at` by preset (+1d, +3d, +1w, +1m, or pick date) by setting `snoozed_until`. Snooze does not change cadence and is cleared automatically by the next counting interaction.
- **Snooze all (redistribute):** takes every currently-due contact and spreads them over upcoming days instead of stacking. Exact algorithm:
  1. Collect due contacts, sort: starred first, then most-overdue first.
  2. Parameters: horizon = 21 calendar days (setting), per-day cap = max(3, ceil(count / weekdaysInHorizon)) (setting for the floor).
  3. Walk weekdays (Mon–Fri) starting tomorrow; assign contacts in sorted order, per-day cap each day; wrap to the next weekday until all assigned. If count exceeds horizon capacity, the cap formula grows so everything fits inside the horizon.
  4. Each assignment sets `snoozed_until` = that day at the owner's digest hour. Deterministic: same inputs → same distribution.
- **Daily digest email:** sent at a configurable local hour (default 08:00) containing: due today (with days-overdue), birthdays today/this week, job changes detected since last digest, reminders due today. Sent via configured SMTP (a deliberate dependency: `nodemailer`). If nothing is due, no email (setting: "send even when empty" off by default).

### Edge cases
- Cadence set on a contact with zero interactions: due `cadence_assigned_at + cadence_days`, not immediately.
- Interaction arrives dated in the past (LinkedIn import backfill): `last_interaction_at` only moves forward if the backfilled timestamp is the new max; recompute handles it either way.
- Deleting the newest interaction: `last_interaction_at` recomputed from remaining rows (not decremented blindly).
- Snooze-all runs twice in a row: second run re-collects (now nothing is due) and is a no-op. Snoozing all, then an interaction landing for a snoozed contact: snooze cleared, clock restarts from the new interaction.
- DST: "due today" and digest hour computed in owner's timezone.

### Acceptance criteria
- [ ] Unit: contact with cadence 30, last interaction Jan 1 → `next_touch_at` Jan 31; logging an interaction Jan 20 → moves to Feb 19.
- [ ] Unit: snooze to Feb 25 with computed Feb 19 → due Feb 25; new interaction Feb 20 → snooze cleared, due Mar 22.
- [ ] Unit: snooze-all with 40 due (5 starred) over 21-day horizon: no weekday gets more than the cap, starred land earliest, weekend days get zero, function is deterministic.
- [ ] Inbound-only email does not change `next_touch_at`; outbound email does.
- [ ] Digest arrives within 5 minutes of the configured hour and contains exactly the due/birthday/change/reminder items shown on the Today page at that moment.

---

## 3a. Keep-in-touch board (triage at scale)

### Behavior
- **The problem it solves:** the cadence engine (§3) only works on contacts that *have* a cadence. After a LinkedIn or CSV import, thousands arrive with none, and assigning them one at a time from the contact page never finishes. The board is the on-ramp.
- **Columns**, left to right: one per `CADENCE_PRESETS` frequency (every week / 2 weeks / month / 6 weeks / 3 months / 6 months / year), then `Custom` (a hand-typed cadence matching no preset — shown only when non-empty), then `Uncategorized`, then `Don't keep in touch`. Every non-archived contact appears in exactly one column; headers carry true totals.
- **Three null-cadence states are two columns.** `cadence_days IS NULL` alone is ambiguous, so `cadence_reviewed_at` records that a decision was made: null → `Uncategorized`, set → `Don't keep in touch`. Assigning any cadence — from the board, the contact page, or the list bulk bar — stamps it. Only dragging back to `Uncategorized` clears it.
- **Two ways to move a contact.** Drag a card into a column (curation), or keyboard triage: number keys assign the focused card to the nth frequency, `x` marks don't-keep-in-touch, `j`/`k` skip, `u` undoes, `Esc` exits. Triage always works the `Uncategorized` queue and auto-advances, so a few thousand contacts is one sitting rather than a few thousand drags.
- **Undo** restores each moved contact to the column it came from, including back to never-triaged.
- **Display cap:** at most 100 cards render per column; the header shows the real count and a footer notes the truncation. Columns refill as they are cleared.

### Edge cases
- A cadence typed by hand (e.g. 60 days) gets the `Custom` column rather than being rounded into a neighbour — the board must never quietly misreport how much triage is left.
- Preset day counts are frozen at their original values (91 and 182, not 90 and 180): changing them would strand every contact assigned before the board existed in `Custom`.
- Archived contacts never appear on the board.
- Setting "no cadence" from the contact page is a decision, so it moves the contact to `Don't keep in touch`, not back to `Uncategorized`.

### Acceptance criteria
- [ ] Unit: every preset maps to its own column; a non-preset cadence maps to `Custom`; `cadence_days IS NULL` maps to `Uncategorized` or `Don't keep in touch` purely on `cadence_reviewed_at`.
- [ ] Unit: presets are sorted ascending and still contain the pre-board day counts (7/30/91/182/365).
- [ ] E2E: a new contact appears under `Uncategorized`; pressing `1` files them under `Every week`; `Undo` returns them.
- [ ] E2E: dragging a card into a frequency column assigns that cadence.
- [ ] E2E: `x` moves a contact to `Don't keep in touch` and out of `Uncategorized`, with no cadence set.


## 4. Reminders

### Behavior
- One-off: title, optional body, due datetime, optionally attached to a contact.
- Recurring: RRULE (RFC 5545 subset: FREQ daily/weekly/monthly/yearly, INTERVAL, BYDAY, BYMONTHDAY, UNTIL/COUNT). On completion or fire, the next occurrence is materialized.
- Firing = a `jobs`-scheduler tick marks it fired, writes a timeline interaction (non-counting), and includes it in Today + digest. Complete/snooze/dismiss from Today.

### Edge cases
- RRULE with no future occurrence (UNTIL passed): reminder auto-completes.
- Contact-attached reminder whose contact is merged: follows the winner; if contact deleted: reminder becomes standalone with a note in its body.
- Server down at fire time: on startup the scheduler fires everything overdue exactly once (fired state is persisted, not in-memory).

### Acceptance criteria
- [ ] "Every 2nd Tuesday monthly" (`FREQ=MONTHLY;BYDAY=2TU`) fires on the correct dates across at least 6 materialized occurrences (unit test).
- [ ] Completing a recurring reminder immediately shows the next due date.
- [ ] Kill the server past a reminder's due time, restart: it fires once, not zero, not twice.

---

## 5. Network Updates / Job Change Detection

### Behavior
- Every import/sync that carries title/company compares incoming vs stored values (after normalization: trim, collapse whitespace; company comparison also strips legal suffixes Inc/LLC/Ltd/GmbH and case).
- A real change writes a `contact_changes` row (field, old, new, source, detected_at) and updates the field only if provenance rules allow (user-edited fields → conflict instead).
- Changes surface on the Today page as "reason to reach out" cards under **Network updates**, rendered as a diff — old value struck through in muted text, new value in the success colour, age ("2d ago") on the right — with actions: draft opener (AI), log interaction, dismiss.
- Title-only changes at the same company are shown but ranked below company changes.
- **Network-updates email** (on by default, Settings → Network updates; needs SMTP). A scheduler sweep (`network_updates`, every 15 min, no-ops when there is nothing new) emails the open changes the owner hasn't been told about yet, then stamps `contact_changes.notified_at`. Edge-triggered and exactly-once, so it stays silent for weeks and then arrives right after an import found a move — as opposed to the daily digest, which mirrors Today at send time and repeats a change every morning until it's dismissed or acted on. Subject names the first person ("Ana Silva changed jobs", "Ana Silva and 2 others in your network changed jobs"); the body uses the same diff grammar as the Today card. Settings has a "Send network updates now" button, which runs the real sweep (and therefore stamps).

### Edge cases
- Case/punctuation-only changes ("google" → "Google") are not changes.
- Company changes A→B, next import B→A (title fix at source): both recorded; UI collapses to latest per field.
- First-ever import: no baseline, so no changes emitted (everything is "new", not "changed").

### Acceptance criteria
- [ ] Re-importing an identical LinkedIn ZIP produces zero `contact_changes` rows.
- [ ] Import where one connection's company changed produces exactly one change row and one Today card.
- [ ] Dismissing a change card removes it from Today permanently; the row remains on the contact's timeline.
- [ ] A change is emailed at most once: a second sweep with no new imports sends nothing.
- [ ] Two imports moving the same person twice produce one line in the email (the newest), and both rows get stamped.

---

## 6. Birthdays

### Behavior
- Dashboard section + digest inclusion: today, and upcoming 7 days.
- "Important only" filter (default ON for digest, toggle on dashboard): starred contacts OR contacts with ≥1 recorded interaction ever.
- Year-less birthdays fully supported; with year, age shown.

### Edge cases
- Feb 29: in non-leap years treated as Feb 28 (setting to flip to Mar 1).
- Timezone: birthday "today" = owner's local date.

### Acceptance criteria
- [ ] Contact with birthday 02-29 appears on Feb 28 in a non-leap year.
- [ ] Unstarred, zero-interaction contact's birthday shows on the dashboard with "important only" off, and not in the digest with the default filter.

---

## 7. Search, Filters, Saved Views

### Behavior
- **Fast fuzzy search** (Cmd+K and the search box): matches names (with typo tolerance via trigram FTS + app-side ranking), companies, titles, note bodies (FTS5). Results grouped: contacts first, then notes. Target: <50 ms on 10k contacts / 50k notes.
- **Composable filters**, AND-combined across dimensions, OR within a dimension (chip UI): group (incl. descendants), tag, last-interaction before/after, title contains, company (current or any past — searches `work_history` too), education contains, location within N km of a geocoded point, has-linkedin (social link present), created-at range, starred, archived, cadence set/unset, due status, custom-field predicates (per type: contains/equals/gt/lt/before/after/includes).
- **Saved Views:** filter set + sort + name, pinned to sidebar, drag-reorderable. Views are live queries, not snapshots. The three canonical examples must be expressible: "Founders in NYC I haven't spoken to in 90 days" (title contains founder AND location radius NYC AND last-interaction before now-90d), "ex-Googlers" (past company = Google AND current company ≠ Google), "everyone I met at a conference this year" (tag or group + created-at range).
- Filters serialize to a versioned JSON object (`{v:1, ...}`) — the same object the AI layer compiles to.

### Edge cases
- Location filter with no geocoder configured: filter disabled with an explanatory tooltip, not silently empty.
- FTS special characters in queries are escaped; a search for `"` doesn't 500.
- View referencing a deleted tag/custom field: renders with a warning chip identifying the dangling predicate; the rest of the filter still runs.

### Acceptance criteria
- [ ] Searching `katee` finds "Kate" and "Katherine" contacts (trigram + nickname-aware ranking) in the top 5.
- [ ] "ex-Googlers" view returns a contact whose work_history has Google with an end date and whose current company differs, and excludes current Googlers.
- [ ] Saving a view from an active filter set, reloading the app, clicking it in the sidebar reproduces identical results.
- [ ] Note body search finds a word that appears only inside a note, opening that note's contact.

---

## 7a. Map (contacts by country, pinned to cities)

### Behavior
- **/map** renders a world map with a count bubble per country (bubble area ∝ contact count) over lightly shaded country polygons. Clicking a country (polygon or bubble) lists that country's contacts in the side panel; with nothing selected the panel ranks countries by count.
- **City placement (owner-enabled 2026-08-24, decision #4 delivered).** When "Place cities with OpenStreetMap" is on (Settings → Integrations, off by default), a recurring `geocode` job resolves each **distinct location string** once through Nominatim — max 1 req/s per their policy, batches of 150 per run to stay inside the job lease, most-shared strings first so one lookup places the most people, misses stamped (`contacts.geocode_attempted_at`, retried after 90 days), results fanned out to every contact sharing the string. Only the location text is ever sent — never names, emails, or anything else. Any write path that changes a contact's location clears its coordinates and stamp, so moved contacts re-geocode.
- Geocoded contacts render as **city pins** (greedy ~5 km anchor clustering, order-independent, so "Zurich, Switzerland" and "Zürich, Zurich, Switzerland" are one pin labeled with the most common string's city half); clicking a pin lists that city's people; the side panel adds a "By city" ranking. Each person appears exactly once: city pin when geocoded, country bubble otherwise; country shading and the country list still count everyone. The map shows "City placement data © OpenStreetMap contributors" whenever pins are on it, per Nominatim's attribution requirement.
- **Fully self-contained** (the §13 privacy invariant applied to maps): geometry is Natural Earth 110m bundled with the app (`world-atlas` + `topojson-client`), projection is d3-geo's Natural Earth — no tile server, no API key, zero network requests. Places the 110m simplification drops (Singapore, Hong Kong, Malta, Bahrain…) keep a bubble at a fixed anchor point.
- **Country resolution is offline and honest**: `lib/geo/country-resolve.ts` maps freeform `contacts.location` strings to ISO numeric country ids — LinkedIn's "City, Region, Country" forms, country aliases (UK/USA/UAE…), US states and Canadian provinces, metro wrappers ("Greater X Area"), and a curated major-city table. Anything unrecognized is **reported in an "unplaced" list** (with counts, most common first) rather than guessed; fixing a contact's location to "City, Country" is the documented remedy. "Georgia" resolves by context (other parts of the string), defaulting to the country only when it stands alone.
- Archived contacts are excluded; contacts with no location are counted separately in the header.
- **Mapbox rendering (owner-amended 2026-08-24).** When the owner pastes a Mapbox *public* token in Settings → Integrations → Map rendering, /map swaps the bundled SVG for an interactive Mapbox GL globe (zoom/pan, light/dark style follows the theme) — same pins, same country bubbles at spherical centroids, same ?city=/?c= click-through, so the side panel is renderer-blind. Tiles load in the owner's browser with their own token; the token is validated as `pk.…` (public by design, not boxed). No token → bundled SVG, which also remains what E2E exercises. Dependency: `mapbox-gl` (WebGL vector-tile renderer — nothing in the stdlib or existing deps can stream tiles).

### Acceptance criteria
- [ ] Unit: resolver battery — LinkedIn three-part forms, aliases, states/provinces, metro wrappers, diacritics, 110m-missing places, Georgia disambiguation, unrecognized → null.
- [ ] E2E: two Swiss contacts and one Indian contact → bubbles read 2 and 1; clicking Switzerland lists exactly the two; an unplaceable location string appears in the unplaced list by name.
- [ ] Grep-level: map rendering references no external hosts (covered by the §13 no-phoning-home test); Nominatim is reachable only through `outboundFetch` and only when the owner enabled the toggle.
- [ ] Unit: Nominatim URL/response parsing (string coords, empty-array miss, junk rejected), pin clustering (boundary-straddling points merge, distinct cities don't, order-independent), key round-trips through URLs.
- [ ] DB-level: one lookup places every contact sharing the string; misses are stamped and not re-asked; a second run no-ops. (Verified end-to-end with a stubbed transport, 2026-08-24.)


## 8. Import Pipeline

### Behavior
Four sources; every import is a `sync_runs` row with a stored **diff report**: counts + row-level lists of new / updated / unchanged / conflicting.

- **CSV:** upload → preview first 20 rows → column-mapping UI (auto-guessed by header, adjustable; multi-map like "Email 1"/"Email 2" both → emails; custom fields mappable) → dry-run diff → confirm. Mapping templates saved per header-signature so re-importing the same shape skips setup.
- **vCard (.vcf):** single or multi-card, versions 3.0/4.0; N/FN, ORG, TITLE, TEL, EMAIL, ADR, BDAY, PHOTO (inline base64 or URL), URL, NOTE.
- **LinkedIn official export ZIP:** see §"LinkedIn import" below — first-class.
- **Google Contacts (People API):** OAuth, initial full sync then incremental via People API syncTokens.

**Idempotency & identity:** each incoming row resolves to a contact by, in order: (1) source-stable external id (LinkedIn profile URL, Google `resourceName`, saved row-identity from a prior run), (2) normalized email exact match, (3) E.164 phone match, (4) exact normalized full-name match *only when* the import row has no email/phone AND exactly one existing contact matches — otherwise it's created as new and left to the dedupe queue. Matched → field-level merge under provenance rules; unmatched → insert.

**Field conflict rules on re-import:**
- Incoming equals stored (after normalization) → unchanged.
- Stored field's provenance is the same source → overwrite, count as updated (and emit `contact_changes` for title/company).
- Stored provenance is `user` → never overwrite; record as **conflict** in the diff report with both values and a one-click "accept incoming" per row.
- Stored provenance is a *different* source → default keep stored, record conflict (setting per-source precedence later if this gets annoying).
- Multi-value fields (emails/phones/socials): union by normalized value; never delete a stored value because an import lacks it.

Re-running any import with the same file: 100% unchanged, zero writes. An identical file (same SHA-256) short-circuits with "already imported" unless forced.

### Edge cases
- CSV with BOM, CRLF, quoted commas, duplicate header names, empty rows — all handled by the parser tests.
- vCard with charset quirks and folded lines.
- Two rows in one file resolving to the same contact: processed sequentially; second row diffs against the first's result.
- Import interrupted mid-run: runs are transactional per-row with a resumable cursor; a crashed run shows as failed with a partial report and can be re-run safely (idempotency makes re-run cheap).

### LinkedIn import (first-class)
- Accept the whole ZIP; locate `Connections.csv`, `messages.csv`, `Profile.csv` case-insensitively, tolerating LinkedIn's "notes" preamble lines above the header in Connections.csv.
- Connections.csv → name, company, position, connected-on, profile URL (identity key), email when present.
- Diff vs previous LinkedIn run → job changes (§5).
- messages.csv → per-conversation, map counterpart to contact (by profile URL when present, else exact name match among LinkedIn-sourced contacts); write message interactions (direction from FROM field, bounded CONTENT snippet as the title), idempotent on (conversation id, message timestamp). Max message timestamp per contact feeds `last_interaction_at`.
- Report ends with a summary: X connections (new/updated), Y job changes, Z messages linked, W unmatched conversations (listed, with a "link to contact" picker).

### Acceptance criteria
- [ ] Importing the same CSV twice: second run reports all-unchanged, DB row counts identical.
- [ ] CSV mapping UI correctly auto-maps a Google Contacts-exported CSV without manual adjustment.
- [ ] LinkedIn ZIP import is idempotent (re-run → 0 new, 0 updated) and a modified copy with one changed Position produces exactly one job change.
- [ ] messages.csv timestamps update `last_interaction_at` and therefore `next_touch_at` (verified on one contact end-to-end).
- [ ] A user-edited title survives any re-import; the conflict appears in the report.
- [ ] Unit tests cover: BOM/CRLF/quoted CSV, multi-card vCard, LinkedIn preamble skipping, nickname-map cases.

---

## 9. Automatic Sync (Gmail metadata + Calendar)

### Behavior
- One Google account connection (`integration_accounts`), OAuth with scopes `gmail.metadata` + `calendar.readonly` + (optional, separate consent) `contacts.readonly`.
- **Gmail:** initial backfill (configurable window, default 2 years) then incremental via `historyId`. Per message store: sender, recipients, subject, thread id, timestamp, direction (owner address(es) matched). **Never fetch or store bodies — enforced by scope choice AND by never calling `format=full/raw`.** Messages whose counterpart matches a contact email → interaction rows; unmatched counterparts are counted (top unmatched senders view can suggest "create contact" — suggestion only).
- **Calendar:** initial window (past 1 year, future 60 days) then incremental via `syncToken`. Past events with ≥1 attendee matching a contact → meeting interactions (declined events excluded). Today's agenda on the Today page with linked contact cards.
- Both run as scheduled jobs (Gmail every 15 min, Calendar every 30 min, settings) with cursors persisted per account; failures retry with backoff; `sync_runs` logs every run.

### Edge cases
- `historyId` expired (Google returns 404): fall back to a bounded re-list since last-known timestamp; idempotent upserts on gmail message id prevent duplicates.
- `syncToken` invalidated (410): full re-sync of the window; upsert on event id + occurrence.
- Owner has multiple own addresses/aliases: configurable "my addresses" list determines direction.
- Recurring calendar events: each occurrence is one interaction (bounded by window).
- Email with 30 recipients: creates interactions only for recipients that are existing contacts; never auto-creates contacts.

### Acceptance criteria
- [ ] The word "body" never appears in Gmail API calls; requested scopes are exactly the three listed (assert in code + test on the request builder).
- [ ] Sending yourself→contact email, then a sync tick: interaction appears with direction=outbound, subject, Gmail link; `next_touch_at` recomputed.
- [ ] Two consecutive syncs with no new mail: second run's stats are all-zero (cursor works; no rescan).
- [ ] Calendar meeting from yesterday with a contact attendee appears on their timeline after sync; a declined meeting does not.

## 9a. LinkedIn automatic sync (Member Data Portability API)

*Added 2026-08-13 at the owner's request ("I really want the possibility to update automatically"), amending the LinkedIn invariant in CLAUDE.md. The invariant's spirit holds: official, owner-consented channels only — this API is LinkedIn's DMA-mandated self-serve product, the export ZIP as an authorized endpoint.*

### Behavior
- The owner creates their own LinkedIn developer app with the **Member Data Portability API (Member)** product (EEA/CH members only), enters its client id/secret in Settings, and connects via OAuth (`r_dma_portability_self_serve` scope).
- **Confirmed not available to the owner (2026-08-13):** the owner is UK-based; the "(Member)" product tile does not appear as requestable on a live LinkedIn developer app for a UK account (only "(3rd Party)" shows, which needs business/company verification — a different, unwanted path). The UK left the EU/EEA in 2020, so this tracks the documented EEA/CH scoping. §9a's code stays in place — it's a real feature for eligible owners and costs nothing idle — but for this deployment it is currently unreachable; **the ZIP import (§8) is the sync path in practice.** Revisit only if LinkedIn extends the product's regions.
- Sync pulls the **CONNECTIONS** snapshot (`GET /rest/memberSnapshotData?q=criteria&domain=CONNECTIONS`, `LinkedIn-Version` header, `start` pagination) and feeds the records — which mirror Connections.csv — into the **same import core as the ZIP** (`executeLinkedInRows`): same identity ladder, provenance rules, job-change detection, `contact_changes` rows, Today cards.
- Runs weekly as a `linkedin_sync` job, plus a "Sync connections now" button in Settings.
- **Domains are discovered, never assumed.** LinkedIn varies the snapshot domain set per product/version; the observed list is stored on the account row and shown in Settings. If CONNECTIONS isn't offered, sync reports exactly that and the ZIP path carries on unaffected.
- The ZIP import remains first-class: it is the only source of **message history** (the snapshot's CONNECTIONS domain has no conversations), and the fallback for non-EEA accounts or missing domains.

### Edge cases
- Self-serve tokens have no refresh token and last ~60 days: expiry flips the account to an error status with a "reconnect" message — never silent.
- LinkedIn prepares the snapshot archive asynchronously after first consent: connect succeeds with an empty domain list and a hint to retry shortly; every sync re-discovers domains.
- Records with no name and no profile URL are dropped (no identity to match or create).

### Acceptance criteria
- [ ] Auth URL requests exactly `r_dma_portability_self_serve`; snapshot requests carry `LinkedIn-Version` (test on the request builders).
- [ ] Snapshot CONNECTIONS records map to the ZIP row shape across header variants (test) and a re-sync of identical data is all-unchanged/zero-writes (same idempotence AC as §8).
- [ ] A token without the CONNECTIONS domain produces a failed `linkedin_api_sync` run whose error says so, and no writes.

## 9b. LinkedIn weekly sync (Voyager session cookie)

*Added 2026-08-13 at the owner's explicit request, after §9a was confirmed region-locked for UK accounts. This one crosses a line §9a did not: it reads LinkedIn's internal Voyager API, which breaches LinkedIn's User Agreement — enforcement risk (account restriction) sits with the owner. The terms it was built under are in CLAUDE.md §LinkedIn; the ZIP remains the sanctioned, recommended route.*

- Owner pastes their `li_at` and `JSESSIONID` cookies into Settings → Integrations → "LinkedIn (session cookie)". Stored encrypted at rest via the token box (`lib/crypto`) under `settings.linkedin_voyager.session`; never logged (`scrubSecrets` guards every error path). Saving a session turns the weekly toggle on; both are clearable in the UI.
- A recurring `linkedin_voyager_sync` job (weekly, same scheduler as §9's syncs; "Sync now" re-aims the pending job) pages the owner's own connection list through the Voyager connections endpoint — serial requests, 2.5 s between pages, 250-page cap, LinkedIn's own page size of 40. The request goes through the outbound-host allowlist like every other integration call.
- **Browser presentation (owner-amended 2026-08-20).** Voyager only answers its own web client, so the request now carries a fixed Chrome User-Agent and the `x-li-track`/`x-li-lang`/`x-li-page-instance` headers the web app sends. This reverses §9b's original "no browser impersonation" clause; the owner accepted the added account-restriction risk. The narrower no-evasion terms still hold: one static fingerprint (no per-request randomisation), no proxy rotation, no CAPTCHA/challenge solving, fail-loud-and-stop on refusal.
- Each connection maps to the same `LinkedInConnection` row the ZIP's Connections.csv and the §9a snapshot produce (title/company split conservatively from the headline; profile URL derived from the public identifier), then feeds `executeLinkedInRows` — same identity ladder, provenance rules, job-change detection, `contact_changes` rows, and Today cards as every other LinkedIn source.
- Voyager connections carry **no email or phone**, which is why profile-URL matching is rung 0 of the identity ladder — without it every weekly sync would re-create the same people.
- Zero parsed connections is a failed run, not an empty result: it means the response shape drifted or the session expired. The sync never deletes a contact that stopped appearing.
- Expected failure mode: this reads an undocumented API, so it *will* break. `src/lib/linkedin/voyager.ts` parses structurally (duck-typed profile objects anywhere in the payload) rather than by fixed path, to survive renames; when it does break, the run fails with a message pointing at that file.

### Acceptance criteria
- [ ] Cookie-blob parsing accepts a raw `Cookie:` header, devtools-style lines, and bare values; rejects pastes missing either cookie (unit tests).
- [ ] Fixture-payload parsing finds every person, ignores company entities, pairs connection dates by URN, and returns empty (not throwing) on drifted shapes (unit tests).
- [ ] A Voyager connection maps to the shared row shape with the normalized profile URL as identity and no email/phone (unit test).
- [ ] Session cookies never appear in `sync_runs.error`, `jobs.last_error`, or console output — every error path scrubs (code-level guarantee via `scrubSecrets`).

---

## 9c. LinkedIn browser extension (the sync that works)

*Added 2026-08-20 at the owner's explicit request, after §9b was proven unworkable. It reverses CLAUDE.md's "no browser extension that scrapes LinkedIn" non-goal; the ToS breach and account-restriction risk are unchanged from §9b and were re-accepted.*

**Why §9b cannot work.** LinkedIn sits behind Cloudflare bot management, which fingerprints the TLS handshake (JA3/JA4) and HTTP/2 framing — characteristics of the network library, produced before any header. Node's signature is not Chrome's, so the request is classified as automated and 302s in a loop while LinkedIn helpfully re-issues `li_at` on every hop. Diagnosed from a `__cf_bm` cookie in the redirect trail. No header, cookie, or User-Agent can change a TLS fingerprint; only a real browser can.

- `extension/` is an unpacked MV3 Chrome extension. Its content script runs on linkedin.com and pages the Voyager connections endpoint with `credentials: "include"` — a genuine same-origin request from a genuine Chrome, carrying the session the browser already manages and the bot-check the browser already passed. Nothing is impersonated because nothing needs to be.
- Pacing matches §9b exactly: serial requests, 2.5 s between pages, 250-page cap, LinkedIn's page size of 40.
- The extension does **no parsing**. It forwards each raw page to `POST /api/linkedin/extension`, which parses with the same structural parser as §9b and feeds `executeLinkedInRows` — one identity ladder, one set of provenance rules, one job-change detector across ZIP, §9a, §9b and this.
- **Auth is a pairing token**, not the session cookie: the POST arrives cross-origin from the extension, where a `SameSite=Lax` cookie would never be sent. Generated on first view of Settings → Integrations, rotatable, compared in constant time.
- Page accumulation is in-process and TTL'd (30 min). A server restart mid-sync loses the session and the final POST fails loudly — re-running costs one click, and half-finished scrapes are not state worth persisting.
- Zero parsed connections is a failure, never "you have no connections" — the §9b rule, unchanged.
- **Popup v0.2 (2026-09-04).** `GET /api/linkedin/extension` (same bearer token) returns pairing status, the last `linkedin_voyager_sync` run (when, status, stats), and the §9d trickle's progress (enabled, queued, budget left today, located/total) — read-only, so opening the popup never spends budget. The popup renders from that plus one `run` record in `chrome.storage.local` that the content script writes as it goes (kind, status, progress, result/error), so closing and reopening mid-sync shows live progress rather than a blank; the service worker paints the toolbar badge from the same record. **Stop** sets a flag the content script checks between pages/profiles and inside its delay: a stopped connection sync still imports the pages already fetched (imports only add or update), and a stopped enrichment flushes the profiles already read so they are stamped rather than re-offered tomorrow. A run record whose tab no longer answers is reported as interrupted, never left looking alive.

### Acceptance criteria
- [ ] Unit: a raw Voyager page forwarded verbatim (JSON round-tripped) parses to connections; company entities in the same payload are not contacts; a drifted shape yields zero, which the endpoint reports as failure.
- [ ] Unit: the pairing token is compared in constant time; a wrong or absent token gets 401.
- [ ] Manual: with the extension loaded and a linkedin.com tab open, "Sync connections" imports the owner's connections, and re-running is idempotent. **Verified live 2026-08-22**, after a paging fix (a page adding nobody new ended the run after the first one) and an explicit `stopReason` so "that's everyone" is distinguishable from "paging broke".

---

## 9d. LinkedIn profile-location enrichment

*Added 2026-08-23 at the owner's explicit request (~2200 connections), after the connections endpoint was proven to carry no geography. Same ToS breach and same account-restriction risk as §9b/§9c, accepted again with the per-profile cost stated. Off by default.*

**The finding that forces this design.** The connections endpoint returns *no* location, under any key. Verified against a live payload on 2026-08-23 by enumerating every key at every depth of the response: `firstName, lastName, headline, publicIdentifier, profilePicture, memorialized, entityUrn` and paging/image scaffolding — nothing geographic. The export ZIP's Connections.csv has no location column either. Location exists only on the individual profile, which costs **one request per contact**.

- Off until the owner ticks Settings → Integrations → "Fill in locations from profiles". The toggle is the consent, exactly like §9b's.
- **A trickle, not a sweep.** A capped number of profiles per day (default 100, hard ceiling 300), 4 s apart, serial, driven by the extension while a linkedin.com tab is open. At ~2200 connections that is roughly three weeks. The slowness is the safety property: it is the difference between traffic that looks like reading LinkedIn and traffic that looks like emptying it.
- **Priority order: starred → on a cadence → most recently interacted → newest.** The map is useful long before it is complete; filling alphabetically would mean three weeks of a half-drawn map that says nothing.
- The budget is a rolling 24 hours, not a calendar day — a calendar reset would let a run starting at 23:50 spend two days of budget in ten minutes.
- `contacts.location_checked_at` is stamped on **every attempt**, including profiles with no location, so the queue advances instead of re-offering the same placeless people. Re-checks are eligible after 180 days; locations move on the order of years.
- Results feed `executeLinkedInRows` like every other LinkedIn source, so a location inherits the identity ladder and provenance rules for free: an owner-typed location is reported as a conflict, never silently overwritten. `LinkedInScalarField` gains `location`; it is deliberately **not** a job change (no Today card, no network-updates email) — moving city is not a reason to reach out the way changing employer is.
- Extraction is structural (`extractLocation`), like §9b's parser: search for place-shaped keys anywhere in the payload rather than a fixed path, so a rename costs a field and not the feature. URNs and bare ids that share those key names are rejected.
- The profile endpoint has moved before, so the extension tries known forms in order and remembers whichever answers.
- **Fail loud:** a round of ≥10 profiles where *none* had a location is reported as suspected shape drift, not as a clean run. A 429 stops the whole run — never routed around.

### Acceptance criteria
- [ ] Unit: queue order is starred → cadence → recent → newest, and is total (equal candidates never reorder between calls).
- [ ] Unit: the daily cap trims the last batch and never goes negative when lowered mid-day; the cap itself is clamped to ≤300.
- [ ] Unit: `extractLocation` finds a nested location, prefers the most specific key, rejects `urn:`/numeric values, and returns null on a connections-shaped payload.
- [ ] Unit: company/school URLs never enter the queue.
- [ ] Every attempted profile is stamped checked, so a second batch offers different people (verified end-to-end against a live database, 2026-08-23).
- [ ] A result whose contact vanished mid-flight is dropped, never turned into a nameless new contact.
- [ ] Manual: awaiting first live run — the profile endpoint candidates are unverified against LinkedIn.


## 10. Deduplication & Merge

### Detection (scheduled job + on-demand)
Candidate pair scoring:
- Normalized email exact match (lowercase; for gmail.com/googlemail.com also strip dots and `+tag`) → score 1.0.
- E.164 phone exact match → 0.95.
- Fuzzy name: normalize (lowercase, strip diacritics/punctuation), apply nickname equivalence map to first tokens (bob↔robert, kate↔katherine, ~200 pairs, checked into `lib/dedupe/nicknames.ts`), drop middle tokens; Jaro-Winkler on "first last":
  - ≥ 0.95 → 0.85; 0.90–0.95 → 0.75, **surfaced only with** a corroborating signal (shared company, shared email domain (non-freemail), or shared group) which adds +0.10.
- Threshold to enter the suggestion queue: **≥ 0.85**. Nothing ever auto-merges. Pairs dismissed as "not duplicates" are remembered and never re-suggested.

### Merge
- UI: two columns + result column; per-field pick (defaults: winner's field, unless empty → loser's), provenance shown per value; multi-value fields union with dedupe.
- Everything repoints to the winner: interactions, notes + mentions, tags, groups, custom values, reminders, relationships, changes.
- `merge_log` stores a full JSON snapshot of the loser and every field decision. **Undo** restores the loser row, repoints back what belonged to it (by id lists in the log), and reverts field decisions — available until either contact is edited in a conflicting way, then undo is refused with an explanation.

### Bulk merge (owner request, 2026-08-15)
- The queue offers checkboxes, "Select all", and "Select exact matches" (score ≥ 0.95); any open pair is selectable. A confirm step states the breakdown — exact matches vs similarity guesses — before anything runs.
- Bulk merges apply **default decisions** with a deterministic winner: the contact with more data (filled profile fields + child rows) wins; tie goes to the older contact. Multi-value data is unioned either way; the per-field merge screen remains the path for pairs needing judgment.
- Pairs are processed sequentially. A pair whose contact was already merged away earlier in the same batch (chained selections A–B, B–C) is **skipped and reported** — never silently re-routed; the next scan re-scores the merged result.
- Every merge in a batch writes its own `merge_log` row and is individually undoable from the recent-merges list.

### Acceptance criteria
- [ ] Unit: "Bob Smith" vs "Robert Smith" ≥ threshold; "Bob Smith" vs "Bob Smythe" scores in the corroboration band and is suggested only with same company; "Jon Doe" vs "Don Joe" is below threshold.
- [ ] `j.smith+news@gmail.com` and `jsmith@gmail.com` → email-match candidate at 1.0.
- [ ] Merging repoints all timeline items; the loser's id 404s; undo restores both contacts byte-identical on profile fields.
- [ ] Dismissed pair never reappears after the next dedupe scan.
- [ ] Unit: bulk winner is the richer contact (ties older); chained pair is skipped with a reason; a bulk-merged pair undoes individually.
- [ ] E2E: select several exact-match pairs, bulk merge, one survivor per pair.

---

## 11. AI Layer

Provider (owner-amended 2026-08-20, was "Anthropic API" only): Anthropic, or Groq's OpenAI-compatible API (free tier, e.g. `openai/gpt-oss-120b`) — configured entirely by env pairs (`ANTHROPIC_API_KEY`+`ANTHROPIC_MODEL` / `GROQ_API_KEY`+`GROQ_MODEL`; `AI_PROVIDER` picks when both exist, defaulting to Groq). The provider adapter is the only part that differs: one `ai_calls` row per call, strict Zod validation with one retry, and never-auto-apply hold for every provider. Groq free-tier rate limits surface as logged errors naming the cap.

All features: model from the provider's env var; every call logged to `ai_calls` (feature, prompt, model, input/output tokens, latency, error). No AI call ever writes user data directly — output always lands in a review/approval surface.

- **Natural-language search:** query → model produces a filter JSON (the §7 schema) via a constrained tool/JSON-schema output → app validates it (unknown fields rejected, values checked against real tags/groups/fields) → the deterministic query layer executes it → UI shows both results AND the compiled filter chips, editable, saveable as a View. The model never sees contact data for this feature — only the schema plus the owner's tag/group/field names.
- **Auto-tagging:** owner selects contacts (or "all untagged") → batched calls with each contact's profile summary + the existing tag list, prompt strongly prefers existing tags → suggestions land in a queue (contact, tag, confidence, rationale) → owner approves/rejects individually or in bulk. New-tag suggestions are visually distinct.
- **Conversation starters:** on a contact (esp. from a job-change card): input = owner's notes on them, work history, detected change → 3 short openers, copy-button each. Never auto-sent anywhere.
- **Note summarization:** button on notes > ~1,500 chars; summary shown above the note, stored, regenerable, and clearly labeled as AI-generated.
- **Ask your network** (owner request, 2026-08-20): a question box (AI page; `a` anywhere) for judgment questions — "who should I leverage for X". Two stages with the database in between: (1) the question compiles to a retrieval filter (`ask_plan`, same compiler/validation as NL search); (2) the filter engine — falling back to FTS, then the warmest 50 contacts — selects a capped candidate shortlist whose compact profiles (title, company, location, tags, work history, days-since-contact) go to the model, which ranks and argues (`ask_answer`). Recommended ids are validated against the sent set — an invented contact is rejected and retried once, then refused. The answer renders as a summary plus linked picks with reasons, and always states how many profiles were shared and which retrieval source fed them.

### Edge cases
- API key unset: AI affordances hidden, not erroring.
- Model returns invalid filter JSON: one retry with the validation error; then fail visibly ("couldn't compile that — here's the raw attempt").
- NL query with no matching concepts ("who owes me money"): compiles to nothing → honest "couldn't map this to filters" instead of a hallucinated result set.

### Acceptance criteria
- [ ] "biotech in Boston, not talked to since spring" compiles to inspectable chips (title/company contains biotech, location radius Boston, last-interaction before ~Mar 20); zero results is possible and honest.
- [ ] Every AI feature use adds exactly one `ai_calls` row with nonzero token counts and latency.
- [ ] Auto-tag suggestions for contacts in a DB with tag "investor" prefer "investor" over synonyms; nothing is applied without approval.
- [ ] Filter JSON with an invented field name (injected in a unit test) is rejected by the validator, never executed.
- [ ] Ask: a pick referencing a contact id that was not in the candidate list is rejected (unit-tested); every rendered pick links to a real contact; the answer states how many profiles were shared.

---

## 12. Today / Triage UI

### Behavior
- Home = one prioritized queue: (1) reminders due, (2) keep-in-touch due (starred first, then overdue-ness), (3) job changes, (4) birthdays this week, (5) today's calendar agenda. Section order fixed; counts in header.
- Every item dispatchable via one keystroke while focused: `l` log interaction (with optional note), `s` snooze (then 1/3/7/m picks duration), `n` note, `o` open in Gmail (compose to primary email) / `L` open LinkedIn, `d` dismiss, `Enter` open contact.
  - v1 deviation (Phase 4): `d` is implemented as snooze-to-tomorrow — a due keep-in-touch item has no separate "dismissed" state yet, and the queue hint labels it "dismiss to tomorrow". Revisit when reminders land (Phase 5).
- Command palette (Cmd+K): jump to contact (fuzzy), create note/reminder, run a saved view, trigger a sync, jump to any screen.
- Keyboard-first everywhere: `j/k` move, `g t` go-Today, `g c` go-Contacts, `/` focus search, `?` shows the cheat-sheet overlay.

### Acceptance criteria
- [ ] A full Today session — clear 5 items of mixed types — is completable with zero mouse use (Playwright E2E).
- [ ] `l` on a due contact logs a counting interaction; the item leaves the queue without a page reload; `next_touch_at` advanced.
- [ ] Cmd+K → type 3 letters of a contact → Enter lands on their profile in <200 ms perceived.
- [ ] Dismiss on a birthday hides it this year only.

---

## 13. Data Ownership

### Behavior
- **Export:** one click → ZIP containing contacts.csv (flattened), plus JSON files per table (full fidelity), plus attachments/. Streams; works at 50k contacts.
- **Backups:** nightly job runs SQLite `VACUUM INTO` a timestamped file under `data/backups/`, prunes to 30 days. Backup status (last success, size) visible in settings; failure shows a banner.
- **No phoning home:** zero telemetry/analytics. Outbound network calls only: configured Google APIs, Anthropic API, SMTP, optional geocoder, and import-photo downloads. A test asserts no other hosts appear in any fetch wrapper.

### Acceptance criteria
- [ ] Export ZIP reimports into a fresh instance via the CSV/JSON paths with zero data loss on a seeded fixture.
- [ ] After two nightly runs, `data/backups/` has two files; a 31-day-old file (fixture) is pruned.
- [ ] `grep`-level check + runtime fetch-wrapper allowlist proves no unexpected hosts.

---

## Decisions (resolved with owner, 2026-08-12)

1. **"What counts for touch"** (§3): CONFIRMED — inbound-only email does not reset the cadence clock; only outbound emails, meetings, LinkedIn messages, manual logs, and counting notes do.
2. **Snooze-all parameters** (§3): CONFIRMED — 21-day horizon, weekday-only, per-day floor of 3, as defaults (all settings).
3. **Cross-source conflict default** (§8): keep stored value, report conflict. (Owner can request per-source precedence later if it gets annoying.)
4. **Geocoding provider** (§1/§7): CONFIRMED — Nominatim (OpenStreetMap) with heavy caching, off by default; radius filter disabled with tooltip until enabled in settings.
5. **Notes counting as interactions** (§3): default toggle stands as specced — on for notes created via Today's "log interaction", off for plain notes.
6. **Auth setup** (owner decision): first-run setup screen creates the password (hash in `settings`), changeable in settings; recovery via documented CLI reset script. No password env var.
7. **LinkedIn automatic sync** (owner decision, 2026-08-13): add the Member Data Portability API as a second official ingestion channel (§9a); the scraping/automation prohibition stands.
