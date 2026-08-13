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
- Changes surface on the Today page as "reason to reach out" cards (e.g., "Ana Silva: Stripe → Anthropic") with actions: draft opener (AI), log interaction, dismiss.
- Title-only changes at the same company are shown but ranked below company changes.

### Edge cases
- Case/punctuation-only changes ("google" → "Google") are not changes.
- Company changes A→B, next import B→A (title fix at source): both recorded; UI collapses to latest per field.
- First-ever import: no baseline, so no changes emitted (everything is "new", not "changed").

### Acceptance criteria
- [ ] Re-importing an identical LinkedIn ZIP produces zero `contact_changes` rows.
- [ ] Import where one connection's company changed produces exactly one change row and one Today card.
- [ ] Dismissing a change card removes it from Today permanently; the row remains on the contact's timeline.

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
- messages.csv → per-conversation, map counterpart to contact (by profile URL when present, else exact name match among LinkedIn-sourced contacts); write message interactions (direction from FROM field), idempotent on (conversation id, message timestamp). Max message timestamp per contact feeds `last_interaction_at`.
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

---

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

### Acceptance criteria
- [ ] Unit: "Bob Smith" vs "Robert Smith" ≥ threshold; "Bob Smith" vs "Bob Smythe" scores in the corroboration band and is suggested only with same company; "Jon Doe" vs "Don Joe" is below threshold.
- [ ] `j.smith+news@gmail.com` and `jsmith@gmail.com` → email-match candidate at 1.0.
- [ ] Merging repoints all timeline items; the loser's id 404s; undo restores both contacts byte-identical on profile fields.
- [ ] Dismissed pair never reappears after the next dedupe scan.

---

## 11. AI Layer (Anthropic API)

All features: model from `ANTHROPIC_MODEL` env var; every call logged to `ai_calls` (feature, prompt, model, input/output tokens, latency, error). No AI call ever writes user data directly — output always lands in a review/approval surface.

- **Natural-language search:** query → model produces a filter JSON (the §7 schema) via a constrained tool/JSON-schema output → app validates it (unknown fields rejected, values checked against real tags/groups/fields) → the deterministic query layer executes it → UI shows both results AND the compiled filter chips, editable, saveable as a View. The model never sees contact data for this feature — only the schema plus the owner's tag/group/field names.
- **Auto-tagging:** owner selects contacts (or "all untagged") → batched calls with each contact's profile summary + the existing tag list, prompt strongly prefers existing tags → suggestions land in a queue (contact, tag, confidence, rationale) → owner approves/rejects individually or in bulk. New-tag suggestions are visually distinct.
- **Conversation starters:** on a contact (esp. from a job-change card): input = owner's notes on them, work history, detected change → 3 short openers, copy-button each. Never auto-sent anywhere.
- **Note summarization:** button on notes > ~1,500 chars; summary shown above the note, stored, regenerable, and clearly labeled as AI-generated.

### Edge cases
- API key unset: AI affordances hidden, not erroring.
- Model returns invalid filter JSON: one retry with the validation error; then fail visibly ("couldn't compile that — here's the raw attempt").
- NL query with no matching concepts ("who owes me money"): compiles to nothing → honest "couldn't map this to filters" instead of a hallucinated result set.

### Acceptance criteria
- [ ] "biotech in Boston, not talked to since spring" compiles to inspectable chips (title/company contains biotech, location radius Boston, last-interaction before ~Mar 20); zero results is possible and honest.
- [ ] Every AI feature use adds exactly one `ai_calls` row with nonzero token counts and latency.
- [ ] Auto-tag suggestions for contacts in a DB with tag "investor" prefer "investor" over synonyms; nothing is applied without approval.
- [ ] Filter JSON with an invented field name (injected in a unit test) is rejected by the validator, never executed.

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
