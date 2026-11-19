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
- **Provenance per field:** every scalar profile field and every multi-value row records which source last set it (`user`, `csv:<run>`, `linkedin:<run>`, `google_contacts`, `gmail`, `calendar`, and since 2026-11-19 `agent` — the owner's Claude through the connector, §14) and when. The UI shows provenance on hover in the profile editor.
- **User edits always win:** once the owner hand-edits a field, imports may propose changes (as conflicts in the diff report) but never overwrite it silently.
- Custom fields: owner defines fields of type text, number, date, single-select, multi-select. They appear on every contact profile and are filterable.
- Tags: flat, colored, freely assignable. Groups: hierarchical (one parent max), each with an emoji; a contact can be in many groups.
- Star: boolean, prominent in lists. Archive: hides the contact from all default lists, search (unless "include archived" toggled), the Today queue, digests, and birthdays; archived contacts keep all data and can be unarchived.
- **The contacts list edits like cells, not like a form** (owner request, 2026-08-23, Dex parity): Title and Company are click-to-edit in place (Enter/blur saves, Escape cancels), Frequency is a picker in the row. One field per save, so provenance stays exact — only the touched field flips to `user`, and an untouched commit (click in, click out) flips nothing, or re-imports would see false conflicts. The list also shows social-link icons, and last interaction as a relative age.
- **Settings anatomy** (owner request, 2026-08-24, Dex parity): a grouped sub-nav rail (Preferences: General / Keep in touch / Notifications · Connections: Integrations · Data: Backup & export / Custom fields) with one section at a time in a centered column — title + subtitle header, then cards of rows (label and why on the left, control on the right). Each section is its own form with its own save action writing only its own keys, so saving one section can never wipe another's values.
- **Responsive** (owner request, 2026-08-24, after Tailscale put Rolo on the owner's phone): desktop layouts are unchanged from `md` up; below that the sidebar becomes a top bar + slide-over drawer (same nav content, drawer closes on navigation by derivation, not effect), the profile/settings/map side panes stack under their main columns as one scrolling document, the contacts table slims to name-first columns (`sm`/`md`/`lg` reveal the rest), and controls render at 16px so phone Safari stops zooming into every focused input. *(Second pass, owner screenshots 2026-09-20: single-line rows — Today cards, reminders, both timelines, the contacts header — are `flex-wrap` below `md`, so the text gets the full width and the action buttons drop to their own right-aligned row instead of squeezing a name into an ellipsis next to a date; ellipsis truncation is desktop-only. The reminder form stacks full-width fields with the date defaulted to today, timeline entries show a short date on phones, and the contacts list sorts nameless contacts (phone-only imports) last so a phone screen starts with people, not `+44…`.)*
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
- Notes: markdown with live preview, autosaved (debounced ~800 ms, with a saved/saving indicator), attachments (file/image, stored under `data/attachments/`), a formatting toolbar (owner request 2026-09-22: bold, italic, underline, headline, subtitle, bullet and numbered lists — each a pure toggle over the selection with Ctrl/Cmd+B/I/U and Ctrl+Shift+8/7 shortcuts; underline is `<u>…</u>`, the one HTML tag the renderer honours, everything else that looks like HTML stays inert text), and mentions:
  - `@Name` → autocomplete over contacts → stores a real `note_mentions` row → renders as a link to that contact; the note also appears on the mentioned contact's timeline.
  - `#Group` → same, for groups.
- "Log interaction" takes optional markdown notes with the same toolbar (owner request 2026-09-22). They are saved as a note row dated to the interaction — the interaction carries the touch, the note carries the words — so the two sit together on the timeline and the text is searchable and summarisable like any note.
- Global timeline view across all contacts with filters: kind (note/email/meeting/message/reminder/change), date range, tag/group, contact.

### Edge cases
- Deleting a note removes its mentions and its attachments — attachments are owned by the note and are deleted with it, after confirmation showing the filenames.
- A mention of a contact that is later merged: mention rows are repointed to the winning contact by the merge.
- Autosave conflict (two tabs open on the same note): last write wins; this is a single-user tool. Documented, not "solved".
- Email interactions never show a body — there is none stored. The timeline row shows subject, direction, other participants, and a "open in Gmail" link built from the thread id.
- LinkedIn message interactions carry a **bounded snippet** of the message (160 chars, cut on a word) in `interactions.title` — the timeline face ("You: Hi Kate, it's Baptiste from LBS…") — and, since 2026-09-26 (owner request: "better to have full context"), the **full text** capped at 4,000 characters in `interactions.meta` as `{body}`, shown under a "Full message" toggle on the timeline and read by the voice guide, Ask, drafts and profile cards. Rows imported before bodies existed get theirs on the next ZIP import (meta IS NULL only). This is distinct from the Gmail rule above: Gmail bodies are a sync scope the owner never granted, whereas these are messages the owner deliberately exported and uploaded. Re-imports backfill snippets onto rows imported before this existed (title IS NULL only) without inflating link counts.
- The contact profile leads with a **Recent interactions** strip (Dex): the last three touches — interactions with their snippet/title and direction ("You:" when outbound), and notes ticked "counts as interaction" with a one-line plain-text snippet — and relative age; the "where were we?" answer before the timeline. The timeline's Interactions filter shows counting notes for the same reason (2026-09-22: the owner ticked the box and could not see it take effect).

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
- **What counts for touch** (design decision — flag for review): outbound emails (owner is sender), calendar meetings that occurred, LinkedIn messages in either direction, manually logged interactions, and notes *if* the note's "counts as interaction" toggle is on (default on for notes created from the Today queue's "log interaction", off for plain notes). A counting note counts for the contact it is filed under **and for every contact it @-mentions** (2026-09-22: a note written from Today or the Notes page has no contact of its own, so the mention is the only link — "coffee with @Ana and @Ben" is a touch with both). Group mentions do not count. Inbound-only email does NOT reset the clock — someone emailing you is not you keeping in touch. Reminders firing and field changes never count.
- A contact is **due** when `next_touch_at <= now`. Overdue-ness = days past due, used for sorting.
- **Snooze one:** push `next_touch_at` by preset (+1d, +3d, +1w, +1m, or pick date) by setting `snoozed_until`. Snooze does not change cadence and is cleared automatically by the next counting interaction.
- **Snooze all (redistribute):** takes every currently-due contact and spreads them over upcoming days instead of stacking. Exact algorithm:
  1. Collect due contacts, sort: starred first, then most-overdue first.
  2. Parameters: horizon = 21 calendar days (setting), per-day cap = max(3, ceil(count / weekdaysInHorizon)) (setting for the floor).
  3. Walk weekdays (Mon–Fri) starting tomorrow; assign contacts in sorted order, per-day cap each day; wrap to the next weekday until all assigned. If count exceeds horizon capacity, the cap formula grows so everything fits inside the horizon.
  4. Each assignment sets `snoozed_until` = that day at the owner's digest hour. Deterministic: same inputs → same distribution.
- **Daily digest email:** sent at a configurable local hour (default 08:00) containing: due today (with days-overdue), birthdays today/this week, job changes detected since last digest, reminders due today, and the day's "worth reconnecting" picks (below; never counted as "due" and never enough on their own to send an otherwise-empty digest). Sent via configured SMTP (a deliberate dependency: `nodemailer`). If nothing is due, no email (setting: "send even when empty" off by default).
- **Worth reconnecting** (owner request 2026-09-04, from Dex's "resurface reminders"). The cadence engine only surfaces people on a cadence; everyone else is invisible to it. Each local day, a few people (Settings → Notifications, default 3, 1–10) are picked from the un-cadenced tail and shown on Today under "Worth reconnecting" and in the digest. Eligible: not archived, `cadence_days` NULL **and** `cadence_reviewed_at` NULL (a deliberate "don't keep in touch" is respected), ≥2 counting interactions, ≥120 days since the last, and outside a 90-day cooldown from their last showing or "not now". Score = depth of history (log), +3 starred, +2 open job change, +recency favouring the 4–18-month band. Deterministic; picked once per day by whichever reader (page or digest) gets there first and stamped `resurfaced_at`. **Reached out** logs a counting manual interaction (the pick retires, the clock resets); **Not now** stamps `resurface_dismissed_at`. A counting interaction after the showing retires the pick on its own. Off switch in Settings.

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
- [ ] Unit: resurface eligibility wants no cadence decision, ≥2 interactions, ≥120 days of silence, and honours the cooldown; the score prefers depth, stars, open changes and the drifted band; picks are capped and deterministic. The digest renders the picks without making an empty day non-empty.

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
- Editable in place from the Reminders page (owner request 2026-09-26): title, date/time, attached contact, and — on a rule — the recurrence. Editing a rule restarts its unfired occurrences from the new start; editing an occurrence moves only that occurrence and never turns it into a rule. A moved due time clears any snooze so the reminder fires again at the new time.
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
- **Headline rule (2026-09-19).** A title cut from a LinkedIn *headline* (extension sync, profile capture — `titleFromHeadline` on the row) fills an empty title but never counts as a title change against a stored one, and never overwrites one: a headline is a tagline, not a position. Company cut from "… at X" still compares. Only a Position column or a job entry may move a stored title.
- **Baseline rule (2026-09-19).** A run that "moves" more than a fifth of the people it matched (and at least 25 — `isBaselineRun`) is describing people differently, not reporting moves. Its writes stand, but its `contact_changes` rows are inserted dismissed + notified, and the import report says so in place of the job-changes heading. Prompted by an extension sync that mailed 475 "moves" against ZIP-imported positions in one go.
- **Dismiss all** on Today's Network updates: one click clears every open card (rows stay on timelines), for the day a run slips through anyway.
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
- [ ] A headline-derived title against a stored position is neither a change, a write, nor a conflict; against an empty title it fills (unit).
- [ ] `isBaselineRun`: 24 of 30 is not a baseline (below the floor), 25 of 100 is, 25 of 200 is not (unit).

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
- **Bulk mail is not a conversation (2026-09-20).** A message with a `List-Unsubscribe` header, or `Precedence: bulk`/`list`/`junk`, is set aside: no interaction even when the sender is a contact (a newsletter from someone is not them keeping in touch), no sighting for "People you met". The two headers are requested as metadata and read as a flag only, never stored; the run's stats count what was skipped. What slips past (a hand-run list, a sales tool that strips the header) stays the owner's one-click "not a person" in the queue — Rolo is not going to guess further than the headers say.
- **Calendar:** initial window (past 1 year, future 60 days) then incremental via `syncToken`. Past events with ≥1 attendee matching a contact → meeting interactions (declined events excluded). Today's agenda on the Today page with linked contact cards.
- Both run as scheduled jobs (Gmail every 15 min, Calendar every 30 min, settings) with cursors persisted per account; failures retry with backoff; `sync_runs` logs every run.

### Edge cases
- `historyId` expired (Google returns 404): fall back to a bounded re-list since last-known timestamp; idempotent upserts on gmail message id prevent duplicates.
- Google's per-user per-minute quota (403 `rateLimitExceeded` / "Quota exceeded", or 429; hit live 2026-09-19 on the first backfill of a busy mailbox): a pause, never a failure. The batch is retried after 20 s then 40 s within a 2-minute per-run budget; past that the ids the budget didn't reach go to a bounded queue (`sync.gmail.pending_ids`, 20k; overflow counted on the run, never silent) so the page token or historyId can still advance, the run ends `partial` with everything fetched committed, and the scheduler re-queues it two minutes out; the next run drains the queue before asking for more. Metadata fetches run 4 wide, not 8. The *daily* cap (`dailyLimitExceeded`) is a plain failure, not a pause. A 401 is still the only status that marks the account. Stored rows are upserted on direction, so a rescan after "my addresses" changed actually corrects them, and rows filed under a contact that carries one of the owner's own addresses are dropped by the reset.
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

## 9b. LinkedIn weekly sync (Voyager session cookie) — retired

*Retired 2026-09-19 at the owner's request. It never completed a run: Cloudflare's TLS fingerprinting refuses a Node process before any header is read (diagnosis under §9c), so every weekly attempt failed, retried, and littered the run log. The Settings card, the scheduler job (`linkedin_voyager_sync`), the cookie parser and the server-side pager are gone; the structural Voyager parser (`src/lib/linkedin/voyager.ts`) survives because §9c feeds it. Extension runs now record as `linkedin_extension_sync`. The text below is kept as the record of what was built and why.*

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
- **Popup v0.2 (2026-09-04).** `GET /api/linkedin/extension` (same bearer token) returns pairing status, the last extension sync run (`linkedin_extension_sync` since 2026-09-19; earlier extension runs were recorded under §9b's kind) (when, status, stats), and the §9d trickle's progress (enabled, queued, budget left today, located/total) — read-only, so opening the popup never spends budget. The popup renders from that plus one `run` record in `chrome.storage.local` that the content script writes as it goes (kind, status, progress, result/error), so closing and reopening mid-sync shows live progress rather than a blank; the service worker paints the toolbar badge from the same record. **Stop** sets a flag the content script checks between pages/profiles and inside its delay: a stopped connection sync still imports the pages already fetched (imports only add or update), and a stopped enrichment flushes the profiles already read so they are stamped rather than re-offered tomorrow. A run record whose tab no longer answers is reported as interrupted, never left looking alive.

- **Profile capture (owner request 2026-09-04).** On any `/in/<id>` page the popup reads the profile off the page the owner already loaded — LinkedIn's embedded API blobs first, the visible heading/headline/location as fallback — and asks `GET /api/linkedin/extension/lookup?id=` whether they're in Rolo: *In Rolo since Mar 2026 · last spoke 12d ago · due Thu → Open in Rolo*, or **Add to Rolo**, which posts the profile to `/api/linkedin/extension/capture`. Capture is one `LinkedInConnection` row (`lib/linkedin/capture.ts`) through `executeLinkedInRows` with `runKind = 'linkedin_profile_capture'` — same identity ladder (profile URL), same provenance rules, same job-change detector; a headline that moved is a Today card like any other. Zero extra LinkedIn requests: nothing is fetched that the owner's own page view didn't.

- **Scheduled weekly sync (owner request 2026-09-04, off by default).** A `chrome.alarms` alarm (weekly, first run a minute after the toggle) runs the connection sync in a LinkedIn tab — an open one, else a background tab at the connections page that it closes again on success. Pacing is the content script's, unchanged; a second run never stacks on one in progress, and a run the owner started by hand is left alone. Logged out means the missing session cookie fails the run and the badge goes red; nothing retries or works around it. Re-armed from the stored toggle on every worker start.
- **Messaging capture (owner request 2026-09-04).** On a `/messaging/thread/<id>` page the popup reads the open thread off the DOM — who it's with (header profile link, else the title), and for each message on screen its direction (the sender link vs the counterpart), timestamp (LinkedIn's date heading plus the per-message time, in the tab's timezone), and a first line — and offers **Log in Rolo**, which posts to `/api/linkedin/extension/messages`. Server-side the text is cut to the same `MESSAGE_SNIPPET_MAX` the ZIP uses and the rows go through `insertLinkedInMessages` keyed by conversation + timestamp, so a later ZIP import of the same thread lands on the same rows. The counterpart is matched like messages.csv (profile URL, then a unique LinkedIn-sourced name); someone not in Rolo is created from the thread header when it carries a profile link, else the popup says to open their profile first. This reverses the extension README's original "no messages" term on the owner's instruction: it still reads only the owner's own conversations, only the one on screen, with **zero** extra requests, and stores snippets, never the thread. Zero messages read is an error — a layout change must look like one.

### Acceptance criteria
- [ ] Unit: a captured conversation validates (≥1 message, known directions), keys on conversation + timestamp, drops a same-millisecond duplicate, and bounds the snippet.
- [ ] Unit: `publicIdentifierFromPath` reads the identifier from a path, a full URL, or a locale subdomain and rejects company/feed URLs; a captured profile lowercases the identifier, falls back from structured name to the page heading, and maps to the shared row with the profile URL as identity; a nameless capture is refused.
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


## 9e. Pre-meeting brief

*Added 2026-09-04 at the owner's request, from the Dex "pre-meeting emails" pattern. Everything it shows already existed; this assembles it at the one moment it matters.*

- A `meeting_prep` job (every 15 min while Google is connected, Settings → Notifications → "Pre-meeting brief", on by default) looks at `calendar_events` inside a lead window (default 120 min, 15–1440) that have at least one attendee matched to a contact, aren't declined or cancelled, and haven't been briefed. A meeting that started up to 15 min ago still qualifies — a late brief beats none.
- The brief, per contact (≤5): role, last touch ("last spoke 14d ago"), the last 3 interactions, open reminders on them, open job changes rendered with the §5 diff grammar, the owner's last 2 notes (trimmed), and — when AI is configured — 3 talking points (`ai_calls.feature = 'meeting_prep'`, first 3 contacts only, one call each). AI output is labelled as AI-drafted and never sent anywhere; a model failure drops the points, never the brief.
- Stored in `calendar_events.prep_json` **before** sending, then emailed (Settings → "Email the brief", on by default; needs SMTP) and stamped `prepped_at` — the exactly-once ledger, same posture as `contact_changes.notified_at`. A failed send retries from the stored brief without another AI round. With email off or SMTP unset, the stamp is immediate and the brief is Today-only.
- Today renders the brief inline under the agenda item (SPEC §12), with a copy button per talking point.

- **Late-added emails still brief (2026-09-20).** Attendees are matched at sync time and the incremental sync never revisits an unchanged event, so an email added to a contact after their meeting synced left them unmatched: no brief, no meeting interaction. The prep sweep now re-matches every still-unmatched attendee before selecting, and the contact form re-links on save — the live case was a test event created before the attendee's email was on their profile.

### Acceptance criteria
- [ ] Unit: `selectEventsToPrep` takes meetings inside the lead window soonest first, allows one that just started, and skips prepped / declined / cancelled / stranger-only ones.
- [ ] Unit: the email names the person and the time in the subject, carries every section (touch, interactions, reminder, change, notes, points), and escapes owner-written markup.
- [ ] Unit: `parseTalkingPoints` caps at 3 and rejects junk; the prompt carries every grounding fact and says so when there is none.
- [ ] A brief is sent at most once per event: a second sweep with nothing new sends nothing.

---

## 9f. People you met

*Added 2026-09-04 at the owner's request, from Dex's "Add new contacts from: Calendar". SPEC §9's "never auto-creates contacts" is kept on purpose: this is a queue with a one-click approve, not an auto-create.*

- The Gmail and Calendar syncs hand every counterpart/attendee they couldn't match to `contact_suggestions` (SCHEMA.md), with the display name from the header or the invite, per-kind counts (you wrote to them / they wrote to you / you met), and a bounded `recent_json` of sightings. Declined meetings don't count. The obvious machinery of email never enters (`isLikelyPerson`: noreply/notification locals, calendar resources, LinkedIn/Slack/GitHub mailers…).
- A suggestion **qualifies** once there is a meeting, or a message *from* the owner, or three from them; ranked meeting > outbound > inbound, recent first. Today shows the top 5 under "People you met" with the count in the header; `/people-you-met` is the whole queue.
- **Add to Rolo** creates the contact (name split from the header, else from an `ana.silva@` local, else the address as display name; email with the sync's source as provenance) and backfills: every remembered email sighting becomes an `interactions` row with the same `source`/`source_key` the live sync writes (so the next tick no-ops), and every stored calendar event carrying the address is re-matched and its past meetings promoted through the sync's own reconcile pass. **Not a contact** dismisses permanently.
- A suggestion whose address later lands on a contact by any other route (typed, imported) is closed the next time the queue is read.

### Acceptance criteria
- [ ] Unit: `isLikelyPerson` passes real people at any domain and rejects noreply/notification/resource/mailer addresses; `splitName` handles "First Last", "Last, First", quotes, and email-shaped locals.
- [ ] Unit: `qualifies` needs a meeting, an outbound message, or three inbound; ranking puts meetings over outbound over inbound with recency as tiebreak; `mergeRecent` dedupes on key, newest first, bounded.
- [ ] Unit: `extractAddressNames` pairs each address with its display name.
- [ ] Approving a suggestion with 3 remembered emails and 1 stored past meeting yields a contact with 4 timeline rows, and the next Gmail/Calendar tick adds none of them again.

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

Provider (owner-amended 2026-08-20, was "Anthropic API" only; Gemini added 2026-09-20; OpenAI added 2026-09-26): Anthropic, OpenAI (paid), Groq's OpenAI-compatible API (free tier, e.g. `openai/gpt-oss-120b`), or Gemini's OpenAI-compatible API (free tier, e.g. `gemini-3.6-flash`; no search grounding) — configured entirely by env pairs (`ANTHROPIC_API_KEY`+`ANTHROPIC_MODEL` / `OPENAI_API_KEY`+`OPENAI_MODEL` / `GROQ_API_KEY`+`GROQ_MODEL` / `GEMINI_API_KEY`+`GEMINI_MODEL`; `AI_PROVIDER` picks when several exist, defaulting to the most recently adopted: OpenAI, then Gemini, then Groq). The three OpenAI-shaped providers share one adapter; the only differences are the endpoint, the max-tokens parameter name and OpenAI's `strict` schema flag. The provider adapter is the only part that differs: one `ai_calls` row per call, strict Zod validation with one retry, and never-auto-apply hold for every provider. Groq free-tier rate limits surface as logged errors naming the cap.

All features: model from the provider's env var; every call logged to `ai_calls` (feature, prompt, model, input/output tokens, latency, error). No AI call ever writes user data directly — output always lands in a review/approval surface. *(This binds the in-app features below. The agent connector, §14, is a separate path with its own write policy, owner-decided 2026-11-19.)*

- **Natural-language search:** query → model produces a filter JSON (the §7 schema) via a constrained tool/JSON-schema output → app validates it (unknown fields rejected, values checked against real tags/groups/fields) → the deterministic query layer executes it → UI shows both results AND the compiled filter chips, editable, saveable as a View. The model never sees contact data for this feature — only the schema plus the owner's tag/group/field names.
- **Auto-tagging:** owner selects contacts (or "all untagged") → batched calls with each contact's profile summary + the existing tag list, prompt strongly prefers existing tags → suggestions land in a queue (contact, tag, confidence, rationale) → owner approves/rejects individually or in bulk. New-tag suggestions are visually distinct.
- **Drafts in the owner's voice** (owner request 2026-09-26; replaces the 3-opener "conversation starters" of 2026-08): on a contact, a due card, a resurface card or a job-change card → one LinkedIn-length message, one email (subject + body) and two alternative openings, grounded in the owner's notes, the last exchanges, work history and the change's triage, written per the voice guide. Optional intent line ("ask for a 20-min call") and Redraft. Editable in the dialog; copy, or open LinkedIn / Gmail compose prefilled. Never sent from Rolo.
- **Note summarization:** button on notes > ~1,500 chars; summary shown above the note, stored, regenerable, and clearly labeled as AI-generated.
- **Job-change triage** (owner request 2026-09-26): the `ai_change_triage` job gives every open change a verdict as an annotation — kind (new company / promotion / new role / rename / headline tweak), significance 0–1, a one-line "why reach out now", and an opener in the owner's voice. Batches of 10, capped per run; runs right after an import that detected moves and every 15 minutes otherwise. Changes under the fold threshold (Settings → Notifications, default 0.3) are folded away on Today and left out of the digest and the network-updates email, but never dismissed; the network-updates email waits up to an hour for the whole pending batch to be triaged so it can carry the reasons and land as one email per import, and a run that hits its cap re-enqueues itself to drain the backlog. Sent ids are validated; a verdict of rename/noise is stripped of any copy the model wrote anyway; a batch the model answers unusably is retried by halves once and the leftovers stamped untriageable (shown as plain changes, never re-sent).
- **Post-meeting follow-up** (owner request 2026-09-26): for a calendar meeting that ended in the last 48 hours with at least one matched contact — not declined, not yet answered or skipped, and with no note written for an attendee since it ended — Today shows "How did it go with X?" right under the agenda. One line from the owner becomes a note on the first attendee (dated to the meeting, mentioning the other attendees so it shows on every timeline; the meeting already counted as the touch) and the reminders it implies (title, due in N days, attendee when clear), extracted by the model (`followup`). If the model fails, the owner's words are saved verbatim — capture never waits for AI. Skip records the choice; the `meeting_followup` annotation is the ledger.
- **Digest narrative** (owner request 2026-09-26): with AI on, the daily digest opens with a brief the model writes from the same Today data plus what moved since the last digest (exchanges logged, notes written, people added, changes detected — `digest.last_sent_at`): a ≤12-word headline that becomes the subject, 3–6 plain sentences, and up to three people worth a message today, each with a reason and a first line in the owner's voice, validated against the ids in the data. The list follows unchanged. `quiet` is true when nothing changed and nothing is pressing; Settings → Notifications → "Only when something changed" then skips the email. AI off or failed → the list-only digest as before.
- **Profile cards — "what I know"** (owner request 2026-09-26): on each profile, an AI-written card from everything Rolo captured about the person (headline, history, education, tags, groups, custom fields, notes, exchanges, detected changes): a 2–5 sentence summary leading with who they are to the owner, up to ten fact pairs, a relationship strength 1–5 with a reason, and up to three questions worth asking next time. Stored as the `contact_profile` annotation; "Write it" / "Refresh" on the card, and the `ai_enrich` job (every 6 h, and right after an extension profile capture) rewrites the cards of up to 20 contacts whose data moved since, closest circle first. Nothing is looked up outside Rolo, and no contact field is written.
- **Your voice** (owner request 2026-09-26): a style guide derived once from the opening lines of the messages the owner actually sent on LinkedIn (the ZIP import's snippets) plus any messages they paste, stored in settings and editable on the AI page; every drafting feature prepends it. Without one, drafts use a stated neutral register rather than pretending.
- **Ask your network** (owner request, 2026-08-20): a question box (AI page; `a` anywhere) for judgment questions — "who should I leverage for X". Rewritten 2026-09-26 as the **iterative Ask** (owner request): (1) `ask_plan` — the question becomes a retrieval plan: up to two compiled filter sets (validated by the NL-search validator, invalid sets dropped), up to three keyword searches over contacts and three over the owner's notes, and whether recent exchanges matter; (2) the database runs the plan — union, warm-ranked, capped at 60, topped up from the warmest contacts when fewer than five were found — and each candidate's compact profile now carries matched note snippets, the last note and the last one-to-three exchanges; (3) `ask_answer` — the model ranks and argues over exactly that list, or asks once for the full timelines (last ten exchanges, last five notes) of up to six candidates it was shown; (4) `ask_step` answers with those appended. Recommended ids are validated against the sent set at every turn — an invented contact is rejected and retried once, then refused. The answer renders as a summary plus linked picks with reasons, and lists every step the database ran with its hit count.

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
- Home = one prioritized queue: (1) reminders due, (2) today's calendar agenda — with the pre-meeting brief inline (§9e), (3) keep-in-touch due (starred first, then overdue-ness), (4) job changes — a screenful (20) with "Show all", so a backlog never pushes the rest off the page, (4a) awaiting reply — campaign people a follow-up is due for, with the count of drafts to send (§16, added 2026-11-19), (5) birthdays this week, (6) worth reconnecting (§3, owner request 2026-09-04), (7) people you met (§9f). Section order fixed; counts in header. *(Agenda moved from fifth to second on 2026-09-20: a meeting in two hours is the most time-sensitive item, and the owner could not find it under 2,500 job-change cards.)*
- Every item dispatchable via one keystroke while focused: `l` log interaction (with optional note), `s` snooze (then 1/3/7/m picks duration), `n` note, `o` open in Gmail (compose to primary email) / `L` open LinkedIn, `d` dismiss, `Enter` open contact.
  - v1 deviation (Phase 4): `d` is implemented as snooze-to-tomorrow — a due keep-in-touch item has no separate "dismissed" state yet, and the queue hint labels it "dismiss to tomorrow". Revisit when reminders land (Phase 5).
- Command palette (Cmd+K): jump to contact (fuzzy), create note/reminder, run a saved view, trigger a sync, jump to any screen. Also reachable without a keyboard (owner request 2026-09-26, phone use): a Search row at the top of the nav, a search icon in the phone top bar, and a Search button on the Contacts header open the same palette.
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

## 14. Agent connector

*Added 2026-11-19 on the owner's decisions (PLAN.md "The agent connector", §4, all eight recommendations accepted). It amends the "public third-party API" non-goal and scopes §11's "no AI call ever writes user data directly" to the in-app features; the terms are in CLAUDE.md §Agent connector. Built in phases 13–18; this section is extended as each lands, and anything not yet built is marked.*

**What it is.** One owner-only MCP endpoint through which the owner's own Claude reads Rolo and writes back to it, used next to Claude's Gmail connector on the forwarding mailbox. Rolo stays the memory and the hands; the reasoning is Claude's. Rolo calls no model on this path.

**Why it has to exist.** Since June 2026 the owner's school mail reaches the forwarding Gmail as Outlook *forwards*: From the owner, To the forwarding address, the real sender and recipients in the body. §9's sync is metadata-only, finds no counterpart, and skips every one of them (`processMessages`: no counterparts → no interaction). Only a reader of bodies can tell who the owner is talking to, and the invariant that keeps Rolo from being that reader stands. Claude with its own Gmail connector is the reader; the connector is how what it learns gets into Rolo.

### Phase 13 — groundwork (built)

- **Auth-free cores.** Every async export of a `"use server"` file is an endpoint a browser can call, and `requireAuth()` redirects when there is no session cookie, so a route handler can call neither safely. The logic the connector needs lives in plain modules, and each server action is a `requireAuth()` + core + `revalidatePath` wrapper:

  | Core | Module | Used by |
  |---|---|---|
  | `executeFilter`, `filterContactIds` | `src/server/queries.ts` | `runFilter` action, contacts page, Ask; the connector's search (ids first, then a page) |
  | `recordInteraction`, `addNote` | `src/server/interaction-core.ts` | Log interaction, quick log, "Reached out", new note |
  | `createReminder`, `completeReminder` | `src/server/reminder-core.ts` | Reminders page, Today |
  | `setTagMembership` | `src/server/membership-core.ts` | the contacts-list bulk bar |
  | `findOrCreateTag`, `setGroupMembership` | `src/server/membership-core.ts` | the connector only, so far |
  | `matchContact`, `applyImportRow` | `src/server/import-engine.ts` | share the ladder and `applyPlan` with CSV / vCard imports |

  Cores take no session, revalidate no page, and return what they touched (ids, and for membership exactly which contacts flipped) so a caller can refresh pages and record an undo. They report bad input as `{ ok: false, error }` rather than throwing.

  Reads that were already plain functions are used as they are: `searchContacts`, `searchNotes`, `getContactDetail`, `getContactTimeline`, `getTodayData`, `listTags`, `listGroups`, `ownerVoiceContext`.
- **Write policy.** Appended, attributed, undoable records apply directly: interactions, notes, reminders, drafts, tag and group membership, new contacts. Contact fields go through §8's field-conflict rules as source `agent`, which the planner treats like any non-user source: it fills an empty field, overwrites a value `agent` itself set, and reports a conflict against a value the owner or another source set — never overwriting it. Delete, merge, archive, export, settings and tokens are never exposed.
- **Signal, not volume** (owner decision 2026-11-19). "Applies directly" is about *how* a write lands, not *whether* everything is written. An agent logs an exchange only when a person actually wrote to the owner or the owner to them — a reply, an introduction, a scheduling message, a decline. Mass mail, job alerts, application-system notices, automatic replies and bounces are not interactions, the same line §9 draws for Rolo's own sync ("bulk mail is not a conversation"). An out-of-office or a bounce may still produce a reminder or mark an address as bad. Judging it is the agent's job, steered by the server instructions and the playbook; Rolo's side of the guard — `log_interaction` requires the caller to say what kind of message it is and refuses the automatic kinds — is Phase 15.
- **What counts for touch is unchanged** (§3): `recordInteraction` asks `interactionCountsForTouch(kind, direction)`, the one rule — an email counts only when outbound, everything else logged counts — so an agent logging a reply the owner received does not reset the clock. The caller cannot override it.
- **Idempotency.** `recordInteraction` takes a `sourceKey`; a repeat with the same `(contact, source, key)` writes nothing — not the interaction, not its attached note — and returns the first row with `created: false`. For mail the key is the id of the message the agent read. `findOrCreateTag` matches names case-insensitively, so "Investor" and "investor" are one tag.
- **One row, any source.** `applyImportRow(row, { source, dryRun })` runs a single person through §8's identity ladder and field rules without creating a sync run; a dry run returns the plan and writes nothing. An overwrite of a title or company the same source set earlier is a `contact_changes` row like any other (§5).
- **Ledger tables** (migration 0020, SCHEMA.md): `agent_grants` — one row per authorised client, tokens stored as SHA-256 hashes; `agent_calls` — one row per tool call with its arguments, outcome, the rows it wrote and the data to undo them.

### Phase 14 — the read-only connector (built)

**The address.** `POST <origin>/api/mcp`, where the origin is whatever the owner reaches Rolo at (taken from the proxy's `X-Forwarded-Proto`/`-Host`, else the request). Settings → Claude connector shows it ready to copy. Claude calls it from Anthropic's servers, so it has to be public HTTPS on port 443 with a public IPv4 address.

**Protocol.** Streamable HTTP through `@modelcontextprotocol/server`'s `createMcpHandler`, stateless, one fresh server per request. It answers both protocol eras from the same tool definitions: the 2025 `initialize` handshake Claude's hosted client opens with, and the 2026-07-28 revision. `GET`/`DELETE` get 405 (there is no session to open or close) — after the token check, like everything else.

**Sign-in.** Rolo is its own OAuth 2.1 authorization server for one person. The rules are pure functions in `src/lib/agent/oauth.ts`; the grant store is `src/server/agent/grants.ts`.

- *Discovery.* An unauthenticated call gets `401` with `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/api/mcp"`. That document (RFC 9728, also served at the bare path) names the origin as authorization server; `/.well-known/oauth-authorization-server` (RFC 8414) lists the endpoints, `S256`, and `token_endpoint_auth_methods_supported: ["none"]`. Client ID Metadata Documents are deliberately not advertised: honouring one means fetching a URL from the internet, and Claude falls back to registering itself.
- *Clients register themselves and nothing is stored.* `POST /api/oauth/register` (RFC 7591) returns a client id that *is* the registration — the redirect URIs and name, signed with the server secret. Claude registers on every fresh connection, so a table would only grow; a signed id costs nothing, and holding one grants nothing. `rolo-connector` is a fixed id for Claude's "use your own OAuth client" field.
- *A code can only ever be sent to two kinds of place:* Claude's hosted callback (`https://claude.ai/api/mcp/auth_callback`, or the same path on claude.com), matched exactly; or an `http` loopback address (`localhost`, `127.0.0.1`, `[::1]`) on any port, for Claude Code and local tools. A registration naming anywhere else is refused, and the policy is checked again at use, so even a validly signed id cannot widen it.
- *Consent is the password.* `/oauth/authorize` needs no session: it shows who is asking (the client's self-given name, in quotes), what it may do, where the answer goes (the redirect's host, with a warning when that is a program on this computer), and asks for the Rolo password. A request whose client or redirect cannot be trusted is explained on the page and redirects nowhere; a malformed request with a good redirect is answered there with the OAuth error and the `state`. The submit re-validates everything — the hidden fields are not trusted. The password check is `attemptPassword`, the same function and the same failure count as the login form (Decisions §6), so the lockout cannot be walked around. The page forbids framing (`frame-ancestors 'none'`) and tells the owner to continue only if they started this themselves, which is the one attack words have to stop: someone else starting a connection from their own Claude and sending the owner the link.
- *Codes* are 256 random bits, live 5 minutes, and are bound to the client, the exact redirect URI, the PKCE challenge and the resource. A wrong verifier does not burn the code for its rightful holder; a second use of a code within its lifetime revokes the tokens the first use bought (RFC 6749 §4.1.2). After that a replayed code is simply dead — a code found later in a browser history or a log must not be a way to disconnect the owner.
- *Tokens.* Access tokens last an hour and are bound to the connector's URL (RFC 8707): a token issued at one address does not open another. Refresh tokens rotate on every use and slide 90 days. A refresh token names its grant and carries Rolo's signature (`rr_<grant>.<nonce>.<HMAC>`), so replay detection is complete without storing retired tokens: a token that verifies but is no longer the grant's current one *is* a retired token of that grant, however many rotations ago, and presenting it ends the grant for everyone holding its tokens. A string that does not verify revokes nothing — otherwise a grant id would be a kill switch.
- *One exception, ten seconds long.* The pair a refresh returns is a keyed function of the token presented, so a repeat of the same refresh within 10 seconds — a lost response, two workers at once — gets the *same* pair rather than forking the chain or signing the owner out. The cost is stated: for those ten seconds a copied token could follow a rotation unnoticed, which is why the window is as short as a retry needs.
- *`client_id` on a refresh* is checked when sent and not demanded. It is public, so it proves nothing the token does not, and a client that omits it should not be signed out every hour.
- *Scope.* As built in Phase 14 only `read` was grantable: whatever was requested, `read` was granted, and the token response said so. Phase 15 adds `write` — see below; a grant made before it stays read-only until the owner connects again.
- *Storage.* Code, access token and refresh token are stored as SHA-256 hashes (SCHEMA.md `agent_grants`); nothing in the database, a log or `agent_calls` holds one in clear.
- *Disconnecting.* Settings → Claude connector lists connected apps (name, connected, last used) with a two-click Disconnect that kills the access and refresh tokens at once.

**Browser origins.** A request carrying an `Origin` is served only from the app's own host, claude.ai / claude.com, or loopback (by hostname); anything else is 403. Server-side callers send no `Origin` and are unaffected. This is defence in depth: the lock is the bearer token, which no browser attaches by itself.

**Strangers' requests are kept small.** The registration and token endpoints answer anyone, so they refuse a body over 20,000 bytes by its declared length and by counting as it streams — never buffering first. The MCP endpoint checks the token before it reads anything. A forwarded host that is not plainly a host name is ignored rather than built into an address.

**Reviewed adversarially** (2026-11-19, a second pass with fresh eyes over every file above, probing the real modules). No critical or high finding; the password, redirect-policy, code and secret-handling rules held against 35 URL-parser quirks. Fixed from it: retired refresh tokens older than one rotation were refused but did not revoke (now any retired token ends the grant); the repeat window was 60 seconds (now 10); bodies were read before being measured; a used code could revoke its grant forever; a maximal registration produced an id too long to read back; an oversized tag list could make the overview unanswerable. Left as they are, deliberately: the login lockout is one global count (Decisions §6), so someone guessing in a loop can keep the owner waiting — `npm run reset-password` clears it; and anyone can register a client that calls itself "Claude", so the consent screen's safety is the password plus its instruction to continue only if the owner started this themselves.

**Tools** (`src/server/agent/tools.ts`) — nine, all annotated read-only, each a bounded view over a query Rolo already had:

| Tool | Returns |
|---|---|
| `rolo_overview` | time, timezone, contact counts and data completeness, tags/groups/custom fields with ids, last sync per kind, whether a voice guide exists |
| `search_contacts` | compact rows (id, name, title, company, location, primary email, LinkedIn, tags, last interaction, cadence) + a true total; free text and/or company (current/past/ex/any), title, tags, groups, interaction dates, starred; sort; page of ≤50 |
| `list_companies` | employers of active contacts with head-counts, folded spellings and the most common titles |
| `get_contacts` | everything on ≤10 people: fields and their sources, emails, phones, links, tags, groups, custom fields, work history, education, keep-in-touch state, notes, recent exchanges (LinkedIn message text; email rows are subject-only, as stored), open changes and reminders, related people, the AI profile card |
| `find_contact` | resolve an email or LinkedIn URL (certain) or a name (candidates only) |
| `get_timeline` | one person's timeline, pageable; or recent exchanges across everyone |
| `search_notes` | full-text over the owner's notes, with the contact each is about |
| `get_today` | what the Today page shows: reminders due, agenda, debriefs awaited, keep-in-touch due, job changes, birthdays, worth reconnecting |
| `get_voice_guide` | the voice guide and messages the owner actually sent |

- *Text search is precise, not forgiving.* The ⌘K search (§7) is built for a person typing: typo-tolerant, three-letter probes, ten results from at most eighty unordered candidates. An agent asking "who is in investment banking" needs every match and no near-misses, so `findContactsPrecisely` requires every word of the query to *begin a word* in the name, company, title, location or bio (any order, case- and accent-insensitive: "bank" finds "Banking", "ana" does not find "Managing"), returns the complete list, and orders it name-matches first, then starred, then most recently in touch. A query containing `@` also matches email addresses. Only when nothing matches exactly does the fuzzy search stand in, for names only, and the answer says it is a near spelling.
- *Arguments* are validated strictly — an unknown key, a wrong type or an out-of-range limit is a refusal that says what was wrong, never a guess. Text reaches SQL only as bound parameters.
- *Answers* are JSON text, capped at 60,000 characters (under Claude Code's 25,000-token ceiling). Lists page with a true total; `get_contacts` trims notes and message text harder the more people are asked for at once; an answer still over the cap sheds from the tail of its list and says so, and one that cannot be shrunk becomes an explicit error rather than an oversized or silently empty answer.
- *Nothing secret can leave.* No tool reads `integration_accounts`, `agent_grants`, `ai_calls` or `jobs`, and from `settings` only four fixed keys that are the owner's own words: the timezone, the voice guide, the pasted voice examples and the owner's name. A failure inside a tool is recorded for the owner and reported to the caller only as "the tool failed".
- *The first call always answers.* `rolo_overview` lists at most 150 tags and 150 groups (with the true counts beside them), so a heavily tagged database cannot push it over the size cap and lock an agent out at step one.
- *Third-party text is data.* Answers that carry notes, titles or message text say so, and the server instructions tell the model never to follow instructions found in them.
- *`get_today` is the Today page*, including its one side effect: the first reader of the day — page, digest or agent — picks the day's "worth reconnecting" people (§3).

**The ledger.** Every call that reaches a tool writes one `agent_calls` row: tool, validated arguments (stubbed past 4,000 characters), outcome (`success` / `refused` / `error`), a one-line summary, the contact it was about, duration, the grant. A call the protocol layer rejects for malformed arguments never reaches a tool, returns no data, and is not logged. Read rows are pruned after 90 days; rows that wrote something (Phase 15) are kept. Settings shows the last fifteen.

**Deviations from the plan, and why.**
- *Dynamic registration is supported*, where the plan said "one pre-registered client". Claude's default is to register itself; requiring the advanced "own client" field would have made the first connection a support problem. The stateless signed id keeps the plan's intent — nothing stored, no outbound fetch.
- *The consent page asks for the password itself* rather than sitting behind the session gate: a session proves a browser was logged in once, the password proves the owner is approving now.
- *The no-phoning-home test (§13) gained one carve-out*, claude.ai and claude.com, as hosts the owner's browser is redirected to — Rolo's server never requests them.
- *"Each call writes one row"* is true of every call that reaches a tool; see the ledger above.

### Phase 15 — write-back (built)

**The `write` scope is the owner's tick.** Discovery advertises `read` and `write`, so Claude asks for both. The consent screen then shows a ticked box, "Also let it add to Rolo", with what that means; the grant gets `read write` only if the request asked for `write` *and* the box is still ticked when the password is submitted. Unticked, or not asked for, it is `read`. A tick cannot grant what was not requested, nothing else requested is ever granted, and a refresh keeps exactly the scope the grant was made with. A read-only grant is not shown the write tools, and calling one by name is refused before anything runs. Grants made before Phase 15 are `read`: disconnect and connect again to change that.

**Eight write tools** (`src/server/agent/write-tools.ts`; seven as first built, `set_cadence` added the same day on the owner's request), each a thin, strictly validated front for a Phase 13 core. Unknown arguments are an error, so there is no field to put a mail body in.

| Tool | Does | Refuses |
|---|---|---|
| `log_interaction` | Records an email, message, call or meeting that has happened, with an optional summary note dated to it. Stored `source = 'agent'`, `source_key` = the caller's key, `meta` = `{category, threadId?, channel?}`. A call is stored as kind `manual` with `meta.channel = 'call'`. | the automatic categories; a future or pre-1990 date; an email or message without a direction; an unknown contact |
| `add_note` | A markdown note on a contact, optionally backdated. Never counts as a touch — if contact happened, that is an interaction. | an empty note, a future date |
| `create_reminder` | A one-off reminder, with or without a contact. | a due date more than a day past or five years out; recurrence |
| `complete_reminder` | Marks an occurrence done. | a recurring rule's own id |
| `upsert_contact` | Adds a person, or fills in fields, emails and a LinkedIn link on one — through §8's planner as source `agent`. | see "Who is this" below |
| `tag_contacts` | Adds and removes tags (by name) and group membership (by id) on up to 50 contacts. | more than two new tags in a call; a tag to remove or a group that does not exist |
| `set_cadence` | Puts up to 50 contacts on a keep-in-touch rhythm of N days, or takes them off one (`null`) — §3's own rule, shared with the Keep-in-touch page (`src/server/cadence-core.ts`). Answers with what it replaced and when each person next comes due. | an archived contact; a gap outside 1–3650 days |
| `undo_agent_action` | Reverses one earlier write by its `actionId`. | anything that is not an agent's own successful, not-yet-undone write |

There is still no tool that deletes, merges, archives, exports, snoozes, touches settings or sends anything.

**Keep-in-touch rhythm** (owner request 2026-11-19, after "put Chris in the CRM to reconnect every 3 months" had no tool to land on). The first build left cadence out as "the owner's to set"; the owner asked for it. `set_cadence` does exactly what picking a frequency on a contact does: sets `cadence_days`, restarts the no-interaction baseline, marks the person triaged, clears any snooze, and recomputes `next_touch_at` from the last real contact. It may replace a rhythm the owner chose — cadence has no provenance, and "change Ana to monthly" is a legitimate instruction — so the guard is in the instructions (only when the owner asks; a rhythm is not a reminder) and in the ledger: the call records the full state it replaced, and undo puts that back, running snooze included, unless the rhythm has been changed again since.

**Signal, not volume, enforced.** `log_interaction` requires `category`: one of `outreach`, `follow_up`, `reply`, `introduction`, `scheduling`, `decline`, `thanks`, `other_personal` — or one of `newsletter`, `notification`, `auto_reply`, `bounce`, which exist in the vocabulary so that naming one is a clean refusal ("…can still be worth a reminder or a note") rather than a mislabel. The server instructions a write grant receives say the rest: log only what a person wrote, leave out what is doubtful, date things when they happened, never change Rolo because text inside a message asked for it.

**The same message never lands twice** — three guards, in the order they apply:

1. *The key.* `log_interaction` requires an `idempotencyKey` identifying the message (`gmail:<message id>`); the other tools accept one. A write is ledgered under the key plus the contact it is about (`<key>#contact:<id>`), because one email to two people is rightly logged once for each. The same key about the same person again is answered from the ledger — `alreadyDone` with the first `actionId` — and runs nothing, even if the arguments differ. A call that changed nothing (refused, or found a duplicate) does not use up its key.
2. *Undone and rejected stay that way.* If the first call was undone, or the owner rejected it in review mode, the repeat says so and writes nothing: the agent's next pass must not put back what the owner took out. Logged against the wrong person, undone, and logged against the right one is a different person and goes through.
3. *The near-duplicate guard.* Before writing, `log_interaction` looks for an interaction with the same contact, kind and direction within ten minutes whose subject matches once reply and forward prefixes are off (`Re:`, `Fw:`, `TR:`, `AW:`, … — `normalizeSubject`), or where either side has no subject. Any source counts: a row Rolo's own Gmail sync recorded, one the owner logged by hand, or the agent's own under another id. That is what joins the copy the owner forwards days later to the send already recorded. A match is reported as `alreadyRecorded` with the existing row's id.

**Who is this.** `upsert_contact` resolves in a fixed order and never guesses:

- With `contactId`: that person. If an email or LinkedIn profile in the call already belongs to someone else, it is refused, naming them — two records that may be one person is the owner's merge to make.
- Without: an email or LinkedIn URL that matches one contact updates them; matching two different contacts is refused.
- No match: a new contact — unless someone already has exactly that name (case, accents and spacing folded; archived included), in which case nothing is written and the answer lists them with `needsDecision`. The agent then passes that person's `contactId`, or `confirmNew: true` if they are different people. The import ladder's own match-by-name rung is not used on this path; the question is asked instead.
- *Fields.* The planner's rules as source `agent`: fills an empty field, overwrites a value `agent` set, and against a value the owner or another source set changes nothing and returns it under `conflicts` (`kept`, `setBy`, `notApplied`).
- *A field the owner emptied on purpose stays empty.* The planner treats an empty field as writable; on this path a field whose provenance is `user` and whose value is blank is returned as a conflict instead.
- *A LinkedIn link* is stored only if its host is LinkedIn's and its path a member profile (`linkedinProfileUrl`), in one canonical `https://www.linkedin.com/in/…` form. The stored value is a link on the contact's page, so "contains linkedin.com" is not enough. One profile per person: the same profile in another spelling is not added again, and a different one from the profile on record is returned as a conflict.
- *An address two contacts share* matches both, so it is refused like any other ambiguity rather than resolved to whichever row comes first.
- *A ceiling.* At most 50 new contacts in any 24 hours through the connector (undone ones do not count; updates are not additions). A loop gone wrong should run out of road; a real batch is an import.

**Text an agent writes is cleaned** (`src/lib/agent/writes.ts`). Notes and reminder details: line endings normalised, control characters dropped, and every markdown image (`![`, however many `!`) turned into a plain link — an image is fetched the moment a note is shown, which would let text planted in an email make the owner's browser call an address of its choosing. Subjects and titles are folded to one line and cut to length. Names of people and tags also lose `[ ] < >` and backticks (`cleanName`): a name is the one text Rolo later places inside markdown itself — an @-mention is `[@Name](mention://…)` — and `mentionMarkdown` now neutralises brackets in its label for names from any source. A note may @-mention only contacts and groups that exist.

**Every write is one unit with its ledger row.** The dispatcher (`callAgentTool`) runs a write tool and inserts its `agent_calls` row in a single transaction: if the tool fails half way — a tag added, the group step throwing — nothing it did stays, the row says `error`, and the caller is told nothing was changed. The row's `writes_json` lists what was written (SCHEMA.md), and the answer carries `actionId`.

**Undo** (`src/server/agent/undo.ts`) reverses exactly the rows one call recorded, newest first, in one transaction, and recomputes `next_touch_at` for every contact it touched. Two things can go wrong with an undo, and it is built around both.

*The row may not be the row any more.* No table uses AUTOINCREMENT, so SQLite hands a freed id to the next insert: after the owner deletes what the agent wrote, something unrelated can sit under the same number. Every ledger record therefore carries something only the original row has — an interaction's contact and key, a note's or contact's creation time, a tag's or group's name, the moment a reminder was completed — and undo checks it first. A mismatch is "already gone", never a delete.

*The owner may have built on what was written.*

- a note or reminder is removed only while its content fingerprint (`sig`) is the one recorded: edited, snoozed, completed or retitled, it is kept and reported as kept. Merely coming due does not count;
- a field is restored — value and provenance — only if it holds exactly what the agent put there *and* its provenance is still `agent`; an address or link is removed only if it is still the agent's;
- a tag the call created is removed unless it is now on other contacts; a membership is taken back only if it is the one written then (by its timestamp), not one the owner removed and added again;
- a snooze that logging a touch cleared is put back, unless it has lapsed or the owner has set another;
- completing a recurring reminder creates the next occurrence; undo removes that one only while it is untouched;
- a contact the call added is removed only while it is still just that. Anything attached since — an interaction, note, reminder or mention; a tag, group, relationship or custom field; a phone, or an email, link or field that did not come from Claude; a cadence, star, snooze, photo or birthday; a later change by Claude that has not itself been undone — and the whole undo is refused with the reason, nothing touched;
- if every part turns out to be the owner's now, nothing was undone: the answer says so and the action is not marked as undone;
- an undo cannot be undone, a call cannot be undone twice, and reads, refusals and proposals have nothing to undo.

The owner's Undo button and the agent's `undo_agent_action` are the same function. The agent's undo is itself ledgered.

**Review mode.** Settings → Claude connector has "Apply straight away" (the default, the owner's decision) and "Ask me first" (`settings.agent.write_mode` = `review`). In review mode a write is first *rehearsed*: run for real inside a transaction that is then rolled back, so Rolo learns what it would do without doing it.

- It would be refused → it is refused now, with the same message. The owner is never asked to approve something that cannot go through.
- It would change nothing (a duplicate, a namesake question, a contact already tagged) → it simply answers, as in apply mode.
- It would change something → it is stored as a `queued` row with its arguments kept whole (never the 4,000-character audit stub: the row *is* the proposal) and the answer says it is waiting.

Reads are never queued. `undo_agent_action` is queued like any other change: in "ask me first", an agent removing something — even something an earlier call of its own wrote, which the owner may have approved — waits for the owner too.

On the activity page each proposal shows everything it would write, in full, with **Approve** — which re-validates and runs it exactly as proposed, dated as of the proposal, in the same all-or-nothing way, turning the row into an ordinary undoable write, or marks it not applied with the reason if it no longer makes sense — and **Reject**, which keeps the row and makes the same proposal come back as `rejected` instead of queueing again.

**What the owner sees.**

- *Claude's activity* (`/agent-activity`, linked from Settings → Claude connector, which shows how many are waiting): writes, undos, proposals and rejections, newest first, 50 a page, each with its details and Undo / Approve / Reject. Reads and write calls that found nothing to do are not listed.
- *On a timeline*, an interaction with `source = 'agent'` and a note an agent wrote carry a small "Claude" mark. Notes have no source column; the mark comes from the ledger (`agentNoteIds`), so it disappears with an undo. Agent-logged interactions can be deleted from the timeline like the owner's own.
- *The consent screen* lists what a write grant can do and what it can never do.

**The ledger grows the right way.** Rows that changed nothing — reads, refusals, "already recorded" — are pruned after 90 days. Writes, undos and proposals still waiting are kept. A call whose arguments fail validation is recorded with the *names* of what was sent, not the values: anything can be put in a field Rolo does not know.

**Rolo's own Gmail sync looks before it adds** (§9). The near-duplicate guard above runs when the agent writes after the sync; `agentLoggedEmail` is its mirror for the other order. Before inserting a message for a contact, the sync skips it if the agent has already logged that message (key `gmail:<id>`) or the same direction and subject within ten minutes. A row the sync wrote earlier is still updated on a rescan.

**Reviewed adversarially** (2026-11-19, an independent pass over the committed write path with its own throwaway tests). The read-scope gate, the `"use server"` surface, key replay, all-or-nothing writes, provenance on apply and the sanitiser for notes, reminder text, emails and LinkedIn URLs held. Ten defects were confirmed and fixed, each with a regression test: undo trusted bare row ids and could remove an unrelated row that had inherited a freed id (interactions, contacts, tags, reminders, emails); undoing an added contact took the owner's later phones, tags, groups and relationships with it; undoing a field wiped a value the owner had retyped; long proposals were stored shortened and could not be approved; the approval screen cut text at 600 characters; the Gmail sync could double a message the agent logged first; a cleared snooze was not restored; a name could carry markdown that became an image inside an @-mention; a fired reminder could not be undone and a touched next occurrence could be deleted; an address shared by two contacts resolved to one of them. Also fixed from it: a mention of a missing contact failed instead of being refused; review mode queued calls that were certain to be refused; a second spelling of the same LinkedIn profile was added; a field the owner had emptied was filled; refused calls stored raw arguments. Left as they are, deliberately: there is no daily ceiling on notes, reminders, tags or interactions (only on new contacts); a proposal stays approvable after its connection is disconnected — the approval is the owner's own act; tag and group undo identifies its memberships by when they were written, not by a row id.

**Decided while building, cheap to reverse.**
- The write box on the consent screen starts ticked: the owner asked for write-back, and the screen says in words what the tick grants.
- One contact per key, not one key per message (above).
- The 50-a-day ceiling on new contacts and the two-new-tags-per-call cap are constants, not settings.
- A rejected proposal's key stays burned, so an unattended agent does not re-propose it every run.

### Phase 16 — the outreach loop (built)

Campaigns, the derived pipeline, "Drafts to send" and the six tools that drive them are specified in §16. The connector now has fourteen read tools and twelve write tools.

### Phases 17–18 (not built)

Unattended runs (17), richer targeting data (18). Scope and acceptance criteria are in PLAN.md until each phase starts.

### Acceptance criteria (Phase 15)

- [ ] Pure: every image form loses its bang, including doubled ones; control characters go; subjects normalise across `Re:`/`Fw:`/`TR:`/`AW:` and leave "Review:" alone; `isSameExchange` joins a forwarded copy and separates a different direction, kind, subject or an eleventh minute; `linkedinProfileUrl` accepts LinkedIn member profiles in any regional form and refuses thirteen look-alikes.
- [ ] Scope: `grantedScope` gives `write` only when asked and ticked; through the real consent action and token endpoint a ticked request yields `read write`, an unticked or unasked one `read`, and a refresh cannot widen it; a write grant lists seventeen tools with eight marked not read-only and one destructive; a read grant lists nine and cannot write.
- [ ] `log_interaction`: an outbound email is stored attributed, keyed, counted as a touch and moves `next_touch_at`; an inbound one does not; the four automatic categories are refused and write nothing; thirteen malformed calls are refused and write nothing; the same key twice is one row; one key about two contacts is two rows; a forwarded copy under another key joins the original; a Gmail-synced row and a hand-logged meeting are joined rather than doubled; a reply, another subject, the next day and another channel are kept apart.
- [ ] `upsert_contact`: a new person carries `agent` provenance everywhere; the same email or profile again updates rather than adds, and a third time changes nothing; a namesake stops with `needsDecision` and `confirmNew` adds a second person without touching the first; an owner-edited title is kept and returned as a conflict; another contact's email or profile is refused; the daily ceiling holds, ignores updates and undone additions, and ages out.
- [ ] `tag_contacts`: reuses a tag case-insensitively; refuses a third new tag, an unknown tag to remove and an unknown group, leaving nothing behind — including a new tag from the same failed call.
- [ ] Undo: restores the database to a byte-identical fingerprint and the clock to its old value; keeps an edited note or reminder and a field changed since; refuses to remove a contact that has gained records or owner edits, and removes it once those are undone; an undone message is not re-logged by a retry; an undo cannot be undone.
- [ ] Undo and reused ids: with the agent's row deleted and an unrelated row inserted under the same id, undo removes nothing — for an interaction, a contact, a tag, a completed reminder, an email and a note — and a note that inherited an id is not marked as Claude's.
- [ ] Undo and the owner's additions: a contact given a phone, an owner-typed email, a tag, a group, a relationship, a cadence, a star or a mention is kept, byte-identical; a field retyped by the owner (even to the same words) is kept; a cleared snooze returns unless replaced; a fired reminder is still removed and a snoozed one kept; a recurring reminder's next occurrence is removed only while untouched; a re-added tag is kept.
- [ ] Identity: an address held by two contacts is refused; a second spelling of a LinkedIn profile is not added and a different profile is a conflict; an owner-emptied field stays empty; names and tags lose markdown brackets, and `mentionMarkdown` yields exactly one link for a hostile name; a mention of a missing contact or group is refused.
- [ ] The Gmail sync's per-message step, run after the agent logged the same message, adds nothing by id or by near-duplicate, still adds a different message, and still updates its own row on a rescan.
- [ ] `set_cadence`: a never-contacted person is due N days from now and leaves the untriaged pile; someone last seen 40 days ago put on a 14-day rhythm is due at once; a batch reports unknown ids and a repeat changes nothing; `null` clears the rhythm and the due date; an archived contact, a gap of 0 or 4,000 days and any extra field are refused; undo restores the previous rhythm and a running snooze exactly, and leaves a rhythm the owner has since picked; in review mode it waits with a summary in words.
- [ ] A write that fails half way leaves every table as it was and an `error` row with no writes.
- [ ] Review mode: five proposals change nothing and are listed as waiting; approving writes exactly what was proposed and makes it undoable; approving twice, rejecting twice and approving a proposal whose contact has gone behave as specified; a rejected proposal comes back as rejected; a 4,800-character note is stored, shown and approved whole; six calls that would be refused are refused without queueing; three calls with nothing to do answer at once; a rehearsal leaves every table byte-identical; an undo is queued and runs on approval; an approved note is dated as proposed.
- [ ] A call that fails validation stores the names of its arguments and none of their values.
- [ ] E2E in a real browser: the consent box is shown ticked for a write request and unticking it yields a read-only connection; a logged email appears once on the timeline with the Claude mark and its note, an image in that note causes no request, a newsletter does not appear; Undo on the activity page removes exactly those and leaves the owner's own entries; "Ask me first" holds a note and a reminder until Approve and Reject, and the rejected one does not return.
- [ ] Manual, the owner's: reconnect with the box ticked, then in Claude "go through this week's forwarded mail and update Rolo" → open three contacts and see the exchanges dated to when they were sent.

### Acceptance criteria (Phase 14)

- [ ] Unit: the RFC 7636 PKCE vector passes and near-misses fail; resources canonicalise as Claude sends them; the redirect policy accepts Claude's callback exactly and loopback on any port and refuses twenty look-alikes (userinfo, sub-domain, fragment, private IP, other schemes); a signed client id round-trips, fails under another secret or after tampering, and cannot carry a forbidden redirect; every way an authorization request can be wrong lands on the page or on the redirect as specified.
- [ ] Against a migrated database through the real handlers: discovery documents at both paths; registration stores nothing; a wrong consent password creates nothing and counts toward the login lockout (five wrong consents lock the login form too); Deny returns `access_denied`; tampered hidden fields are refused; a code is single-use, expires, is bound to client, redirect, verifier and resource, and its reuse revokes; a used code replayed after its lifetime revokes nothing; a refresh rotates, repeats idempotently inside ten seconds, revokes on replay after it — including a token two rotations old — while a forged token naming a grant revokes nothing; it slides at 90 days; no token or code appears in clear in `agent_grants`; an oversized or endless request body is refused with 413 without being buffered; a malformed forwarded host yields neither an address nor an error.
- [ ] The MCP endpoint: no token, garbage, a refresh token or a code as bearer → 401 with the discovery pointer; an expired, revoked or other-address token → 401; a foreign `Origin` → 403; `GET` without a token → 401, with one → 405; both protocol eras list nine tools, each read-only-annotated with a strict schema.
- [ ] Tools on a seeded database: each tool's happy path and refusals; text search by word-start across fields, complete on 10,000 contacts with a true total; archived contacts excluded unless asked; SQL- and FTS-special characters are harmless; one ledger row per call; a grant without `read` can call nothing.
- [ ] No tool output contains any of nine planted secrets (password hash, extension token, SMTP password, Google tokens, Mapbox token, grant hashes, an AI prompt); running every tool twice leaves every table but the ledger byte-identical.
- [ ] On 10,000 contacts with long text, the widest call of every tool stays under 60,000 characters.
- [ ] E2E in a real browser over real HTTP: `/.well-known` routes served by Next; the consent screen shows the client, the redirect host, the loopback warning and forbids framing; wrong then right password; code → tokens → `initialize` → `tools/list` → a real search; refresh rotates; Settings lists the connection and its activity; Disconnect shuts it out.
- [ ] Manual, the owner's: add the connector in claude.ai at the public address and ask a question. Not verifiable from the build sandbox, which cannot reach the deployment.

### Acceptance criteria (Phase 13)

- [ ] Each core runs against a migrated database with `requireAuth` and `revalidatePath` mocked to throw, proving no core depends on a session or a page cache; the same test shows each action wrapper still refuses without a session.
- [ ] `recordInteraction` with the same `sourceKey` twice writes one row and reports the second as not created; a different key writes a second row.
- [ ] An inbound email logged by an agent leaves `last_interaction_at` and `next_touch_at` unchanged; an outbound one moves them.
- [ ] `applyImportRow` as source `agent` against a field the owner edited writes nothing to that field and returns the conflict; against an empty field it fills it and stamps provenance `agent`; a second agent write overwrites its own value.
- [ ] An agent-created contact carries `agent` provenance on every field it set, and a second row with the same email resolves to it instead of creating another.
- [ ] `agent_calls` enforces one successful row per `(tool, idempotency_key)`; a failed attempt does not burn the key; a call row outlives its grant and its contact.
- [ ] Not built in Phase 13: the login attempt throttle listed in the plan — it is being done as its own change.

---

## 15. WhatsApp, per person

*Added 2026-11-19 on the owner's request and design ("everything per person, driven from Rolo"). Step 1 of three is built: the Rolo side and the phone-export source. The laptop collector (step 2) waits on a feasibility probe the owner runs; nothing in this section depends on how it turns out. The terms are in CLAUDE.md §WhatsApp.*

**What it is.** For the people the owner chooses — and only them — their one-to-one WhatsApp conversation is in Rolo: on the timeline as exchanges, readable by the owner's Claude, and kept as exact words for 90 days and as one rolling summary after that. Everyone else in the owner's WhatsApp does not exist as far as Rolo is concerned.

**What it rests on.**

- *Rolo knows a chat only as a row the owner made.* A chat exists in Rolo when the owner types a number on a contact (`whatsapp_links`). There is no chat list, no address book, no discovery. Every way in — the export upload, the collector's endpoint — resolves to such a row or is refused.
- *Identity is the number, never the name.* The link stores the number in E.164 digits (`wa_id`) and, separately, the name the owner saved that person under in WhatsApp (`saved_name`: Chris Haswani is "John"). The saved name is an alias for display and search; nothing is ever matched on it to decide whose messages these are.
- *Read-only by construction.* Rolo has no code that talks to WhatsApp, and neither source can: an export is a file the owner made on their phone; the collector (when built) reads WhatsApp Desktop's files on disk and has no network path to WhatsApp and no hold on the running app.
- *No protocol bridge.* Baileys, whatsapp-web.js and attaching to the running app through a debugging port are excluded — the last because it is the same technique and can send as well as read. If reading the local files proves impossible, there is no automatic path and the export remains the source.
- *Groups stay out.* A group's identifier is not a phone number, so it cannot be linked or delivered; an export with more than two voices is refused.

### The panel

Each contact page has a WhatsApp panel (`src/components/whatsapp-panel.tsx`; actions in `src/server/whatsapp.ts`, rules in `src/server/whatsapp-core.ts`):

- **Link chat** — the number and the saved name. A number typed with its country code is accepted if it is a possible number for that country (the bundled numbering plans lag behind new ranges); a national number needs the default region and must be valid. One chat per contact, one contact per number.
- **Keep this chat in sync** — on/off, off by default. It is the only thing that puts a number on the collector's list. Until a collector has ever checked in, the panel says that nothing syncs automatically yet.
- **Import history from** a date — how far back the collector is asked to go for this chat. Without one, sync starts when the chat was linked.
- **Upload a phone export** — the official "Export chat" file (.zip or `_chat.txt`), for older history or as the only source.
- **Summary of older messages** — the rolling summary and how far it reaches.
- **Delete WhatsApp data…** — two clicks. Removes the link, every message, the summary and the WhatsApp timeline rows for this person. Their other Rolo data is untouched, and WhatsApp itself cannot be affected.

Turning sync off keeps what is already in Rolo. Deleting is always the separate action.

### Messages, and the timeline

- `whatsapp_messages` holds one row per message: its key, direction, time, kind (`text`, `media`, `call`, `other`) and — for text — the body. **Media never leaves the laptop**: a photo or voice note is a row with a kind and no body, and the collector's contract has no field that could carry one.
- **The timeline shows one row per day of conversation**, not one per message: `WhatsApp · 12 messages (5 sent, 7 received)`, with the day's retained text behind it as a transcript (capped at 4,000 characters). A conversation is dozens of messages; a timeline — and Claude's view of "recent exchanges" — is for "we talked on Tuesday". The rows are `interactions` with `source = 'whatsapp'`, `source_key = 'wa-day:<YYYY-MM-DD>'` (the day in the owner's timezone), and are *derived*: rebuilt from `whatsapp_messages` whenever those change, never written any other way, and not individually deletable.
- **Only what the owner sent resets the keep-in-touch clock** (§3): a day row counts as a touch when it contains at least one outbound message, and is dated to the last one. A day of only received messages is on the timeline and moves nothing — the same line §9 draws for email. (LinkedIn messages are unchanged: any message counts.)

### No duplicates, from two sources

- The collector's messages carry WhatsApp's own ids; the same id again is the same message, and an edit made in WhatsApp updates the text.
- An export has no ids. Each line gets a key from its content — chat, direction, second, text, and its position among identical lines — so the same file, or a longer export of the same chat, lands on the same rows.
- **Across the two sources**, a message is recognised by what it says and when: same direction, same second, same text. An export of a stretch the collector already delivered adds nothing, and the reverse; three identical "ok"s against two already there adds one.
- **Purged text does not come back.** A row whose text was cleared (below) still matches on time and direction alone, so re-importing old history cannot resurrect it.

### The phone export

`src/lib/whatsapp/export.ts` reads iPhone exports (`[19/11/2026, 14:03:22] John: …`, inside a zip as `_chat.txt`) and Android's bracketless form. From a zip only the text file is unpacked — photos in the archive are never read.

- *Dates.* The order follows the phone's region. A four-digit first part or any day above 12 settles it; otherwise the order that keeps the file in time order wins (an export is oldest-first); if even that cannot say, day/month is assumed and the result says so. 12-hour clocks, two-digit years and `.`/`-` separators are read.
- *Times* are wall-clock with no zone, so they are read in Rolo's timezone setting; the panel names it, and warns when it is still UTC.
- *Who is who.* The file names people as the phone's address book does, so the contact appears under their saved name. That name is "them"; the other voice is the owner. If the saved name is not in the file, nothing is imported and the panel asks which of the two names is theirs. **Uploading the file on a contact's page is what says whose chat it is** — never a name.
- Refused: a file that is not an export, one with more than two voices, and one whose dates come out in the future.
- WhatsApp's own lines (the encryption notice, "changed their phone number") are skipped; deleted messages are kept as a row with no text; media and calls as their kind.

### The collector's contract (server side built; the collector is not)

`/api/whatsapp/collector`, gated by a bearer token compared in constant time (`src/server/whatsapp-collector.ts`). **No token exists until the collector ships, so the endpoint answers nobody.**

- `GET` → `{ wants: [{ waId, from, to }] }`: the numbers whose sync is on, each with the date ranges still wanted — history first (from the date the owner picked, back to where the collector has already covered), then the live tail with a ten-minute overlap. No names, no contact ids, nothing about anyone whose sync is off. This list is the whole of what the laptop is asked to read.
- `POST` → `{ chats: [{ waId, coveredFrom, coveredTo, messages: [{ id, at, fromMe, kind, text }] }] }`, strictly validated: an unknown field is an error, 2,000 messages per chat and 4 MB per request at most.
- **The filter runs twice.** The collector filters before it stores or sends anything; the server applies the same rule again: a chat that is not linked with sync on is discarded unread, counted, and recorded as a failed `whatsapp_sync` run — a stale list or a bug on the laptop cannot put an unlinked chat into Rolo. Messages from before the owner's chosen date are dropped too.

### Retention: exact words for 90 days, then one rolling summary

- Exact text is kept for 90 days. Older history lives on as **one rolling summary per contact** (`whatsapp_links.summary_md`), rewritten each time rather than stacked: topics, plans, commitments in both directions, personal updates, how the relationship is evolving.
- **Claude writes it, through the connector** (`save_whatsapp_summary`, §14) — on the owner's request or a routine they schedule. Rolo calls no model for this, so WhatsApp text never goes to the in-app AI providers. Each save states `coversThrough`: the time of the last message folded in.
- **Text is never cleared on age alone.** The nightly `whatsapp_retention` job clears a message's text only when it is *both* older than 90 days *and* at or before the saved summary's `coversThrough` — and then only after it has been on the clearing list for **7 days**, and is still covered. If Claude's routine never runs, nothing is ever cleared.
- The 7 days are for the one irreversible step here: time to read a new summary and undo it. Undoing restores the previous summary and takes the text it covered off the list at once.
- A summary must be at least 80 characters, may not reach past the newest message Rolo holds, and only moves forward. Rolo keeps one earlier version: the latest update can be undone, once.
- After clearing, the row stays without its text: the day is still on the timeline with its counts, and the keep-in-touch clock is unaffected.
- *Stated limit:* nightly backups (§13) are kept 30 days, so text cleared from the live database remains in backup files for up to 30 more days.

### What Claude can see and do (§14)

- `list_whatsapp_chats` (read) — the linked contacts, with message counts, how far each summary reaches, and how many messages are waiting to be summarised.
- `get_whatsapp_chat` (read) — one linked contact's summary and messages, up to 200 a call, marked as data. A contact with no link has nothing to read, and after "Delete WhatsApp data" there is nothing left.
- `get_contacts` shows `whatsapp: { savedInWhatsAppAs, summary, … }` for a linked contact, and `find_contact` finds a person by their saved name ("John" → Chris) as a candidate.
- `save_whatsapp_summary` (write) — replaces the rolling summary. Sanitised like every text an agent writes, ledgered, undoable, and queued in "ask me first" mode with the full text shown.

### Merging and deleting contacts

A linked chat follows a merge to the winner with its messages and day rows, and returns on undo. A merge is refused when both contacts have a chat (one would lose its messages); delete the WhatsApp data from one first. Deleting a contact deletes their WhatsApp data with them.

### Not built

- **The laptop collector.** Probe part 1 (`collector/probe.mjs`, run by the owner 2026-11-19 on WhatsApp 2.2645.101.0) found that messages are not in the encrypted native databases under `LocalState` but in the WebView's IndexedDB store (`LocalCache\EBWebView\Default\IndexedDB\https_web.whatsapp.com_0.indexeddb.leveldb`), that those files can be read while the app runs, and that a message reaches them within about a second. Still open: whether message *text* in that store is readable — WhatsApp Web is reported to keep it in a per-message encrypted envelope. Part 2 (`collector/inspect.mjs`) reports the store's shape and whether keys kept in the same store open the text, with no content in the report. It is built on `collector/idb.mjs`, a dependency-free reader that treats the store as bytes — never opening the database, which would lock and rewrite WhatsApp's files — and is tested against a real Chromium store. The collector is designed after part 2's result.
- **The collector's Settings card** (create and rotate the token, last seen). Until it exists the endpoint is closed.
- **Commitments → reminders.** Left to Claude through the connector, which already has `create_reminder`.

### Acceptance criteria

- [ ] Pure: a number becomes the same `wa_id` however typed, a national number needs a region, and names, group ids and JIDs are not numbers; the fingerprint ignores milliseconds and spacing; an export line gets the same key on every upload and repeats get their own; a day row dates itself to the owner's last message, counts as a touch only with an outbound message, keeps its counts when its text is gone, and is cut with a mark when very long; `wantsForLink` asks for the link date, an earlier chosen date, exactly the missing stretch, and the tail; `purgeEligible` needs both conditions.
- [ ] Export parser: iPhone and Android forms; multi-line messages; media, calls, deleted and edited messages; WhatsApp's own lines skipped; summer time; 12-hour clocks and two-digit years; date order by evidence, by time order, and assumed with a flag; impossible dates skipped; a zip yields its text and not its media; a file that is not an export is refused.
- [ ] Against a migrated database: linking refuses a non-number, an empty name, a second chat and a number someone else has; an export lands as day rows in the owner's timezone and moves the clock only by what was sent; the same file twice adds nothing and a longer one adds the difference; an unknown saved name asks and takes the answer; a group export, a future-dated file and an unlinked contact are refused.
- [ ] Collector contract: closed without a token; `wants` holds numbers and dates only and nobody whose sync is off; a delivery stores the enabled chat and discards a disabled one, an unlinked one and a group id without any of their text reaching any table, recording a failed run; the same delivery twice changes nothing; toggling off empties `wants` and a late delivery is discarded; "import history from" asks for exactly the stretch and nothing older is kept; an edit updates; malformed, oversized and extra-field deliveries are refused; media arrives without text whatever was sent.
- [ ] Two sources: an export of messages the collector delivered adds nothing, and the reverse; a third identical message is new.
- [ ] Retention: with no summary a year-old message keeps its text; a summary must be real, cover only what exists, and move forward; text is scheduled only when past 90 days and covered, kept through day 6, cleared on day 7, and only that text; purged text does not return from either source; undoing a summary restores the previous one and unschedules its text; only the latest update can be undone, once.
- [ ] Deleting WhatsApp data removes the link, messages, summary and day rows for that person, restores the clock to what the rest says, and leaves the contact, their note and their hand-logged interaction; deleting the contact cascades; renaming the saved name rewrites transcripts, not identity.
- [ ] Connector: only linked chats are listed and readable; text is marked as data; a profile carries the saved name and summary; "John" finds Chris; `save_whatsapp_summary` is refused for a short text, a future or backward `coversThrough`, an unlinked contact and a read-only grant, is sanitised, undoable, and queued whole in review mode; the widest call stays under the size cap on a 400-message, maximum-length chat.
- [ ] Merge: a linked chat moves with its messages and day rows and returns on undo; both-linked is refused with neither changed.
- [ ] E2E in a real browser: link by number and saved name (a non-number is refused); upload an export and see one row per day with the day's words behind it; upload it again and nothing is added; a group export is refused; the saved name, sync toggle and history date are remembered; Delete WhatsApp data removes the WhatsApp rows and leaves a hand-logged interaction.
- [ ] Manual, the owner's: run the probe on the Windows laptop and send the report; upload a real iPhone export for one contact and check the dates.

---

## 16. Outreach

*Added 2026-11-19 (PLAN.md Phase 16, owner decisions of the same day). It builds on §14: Claude chooses and writes, Rolo remembers and shows. Two non-goals bind it and are not amended: Rolo sends no mail, and there is no pipeline stage anyone sets or drags.*

**What it is for.** From a goal — "coffee chats with tech bankers at the top firms" — to emails sent in the owner's own words from the owner's own Outlook, with the follow-ups surfacing by themselves a week later.

### Campaigns

A campaign is a Rolo **group** plus a goal, a brief and a start date. The people in it are the group's members, managed exactly like any other group (bulk actions on the contact list, `tag_contacts`, `save_campaign`'s `addContactIds`). The goal, brief and start date live in one settings value, `outreach.campaigns`, keyed by group id — no new table, and **nothing is stored per person** (owner decision 7).

- A stored brief belongs to its group only while the group's `created_at` matches the one recorded with it: SQLite gives a deleted group's id to the next group made, and that group must not inherit a campaign.
- **Start date.** Only what was sent or received from that day on counts towards the campaign; anything earlier shows as "last in touch". It defaults to the day the campaign is created and the owner can move it back ("Count what was sent since").
- Archiving a campaign takes its people off Today and nothing else. Deleting the group ends the campaign.

### Where each person stands

Derived every time it is shown, by `deriveStage` (`src/lib/outreach/stage.ts`, pure) from what Rolo already holds. First match wins:

| Stage | When |
|---|---|
| Not pursuing | the contact has the tag `not pursuing` |
| Call booked | a future calendar event has them as an attendee (not cancelled), or an open reminder an agent created with `purpose: "call"` is due in the future |
| Met | a meeting or call with them since the campaign started |
| Bad address | the tag `bad address`, and they have not written since the campaign started |
| Draft ready / Not contacted | nothing sent since the start; "draft ready" when a draft is waiting |
| Your move | the last message since the start is theirs |
| No reply | the last message is the owner's and it is at least 30 days old |
| Awaiting reply | the last message is the owner's; a follow-up is **due** after 7 days unless a draft is already waiting |

- "Sent" and "received" are the timeline's own rows: emails and messages with a direction, whoever logged them. For a linked WhatsApp chat (§15) the individual messages are used rather than the one-row-per-day summary, so a reply later the same day counts as a reply.
- The two tags are ordinary tags, matched case-insensitively, set by the owner or by Claude with `tag_contacts`. They are the only facts no message carries.
- 7 and 30 days are the owner's to change (Outreach → Settings).

### Drafts to send

`outreach_drafts` (SCHEMA.md): one row per email written for the owner to send — by Claude through `save_draft`. Each open draft is a card under **Outreach** with the subject and text editable in place and:

- **Open in Outlook** — `https://outlook.office.com/mail/deeplink/compose` with `to`, `subject`, `body` (and `bcc` when set), each percent-encoded. Offered while the link is under 7,500 characters.
- **Open in mail app** — a `mailto:` link, offered under 2,000 characters.
- **Copy** — recipient, subject and text as plain text; always available, and the fallback when the email is too long for a link.
- **Sent** — saves any edit, writes an outbound email to the person's timeline (`source = 'user'`, `source_key = 'draft:<id>'`, counts as a touch), and marks the draft sent. This click is the record: Rolo cannot see the owner's Outlook.
- **Discard…** then **Discard** — two clicks; nothing reaches the timeline.

Rules, enforced in `outreach-core.ts`:

- **The address must already be on the contact.** A draft can name one of the contact's addresses or default to their first; any other address is refused. A contact with none can still have a draft, and the card says the address is missing. The links are built in the browser from a validated address (`isEmailAddress` admits no character that could add a second parameter).
- **One open draft per person per campaign.** A second is refused unless it names the one it replaces, which is then discarded.
- **A draft retires itself** when an outbound email to the same person with the same subject (ignoring `Re:`/`Fw:`) is logged some other way, dated no earlier than five minutes before the draft was written — the owner sent it without clicking, and Claude or the Gmail sync recorded it. Checked whenever drafts are listed.
- **The forwarded copy is not logged twice.** `log_interaction` treats a `draft:` row for the same person and subject within three days as the same exchange.
- **BCC (optional setting).** An address added to every compose link, so each email also arrives in the mailbox Claude reads, with its real recipient and time.

Nothing here sends mail, and no host is contacted by Rolo: the links open in the owner's browser. `outlook.office.com` is listed in the no-phoning-home test as a link the UI may show.

### Today

A section **Awaiting reply** lists people in live campaigns for whom a follow-up is due, longest wait first, each once (the campaign they have waited longest in), with a link to "Drafts to send" when any are waiting. A person with a follow-up already drafted is not listed.

### What Claude can see and do (§14)

- `list_campaigns` (read) — campaigns with their goal, brief, start date and a count per stage; how many drafts are waiting.
- `get_pipeline` (read) — one campaign's people with stage, days waiting, whether a follow-up is due, how many emails are unanswered, whether Rolo holds an address; filterable by stage, paged.
- `list_drafts` (read) — drafts by status, with their text.
- `get_today` now includes `awaitingReply` and `draftsToSend`.
- `save_campaign` (write) — create a campaign (a new group) or update the goal, brief and start date of one; add up to 50 people. The brief is sanitised like every text an agent writes.
- `save_draft` (write) — put an email in "Drafts to send", under the rules above. There is no send argument.
- `update_voice_guide` (write) — replace the voice guide (§11's `ai.voice_guide`), keeping one earlier version for undo.
- `create_reminder` gains `purpose: "call"` (needs a contact): the reminder that marks a call as booked.

All four are ledgered, queued in "ask me first" mode, and undoable: a draft is removed while it is still open and unedited (and the one it replaced comes back); a campaign save returns the previous goal, brief and start, or removes a campaign it created — and its group while that group is still empty; a voice guide returns to the previous version. In each case only the latest save can be undone, and anything the owner has changed since is left alone.

**The playbook** is `.claude/skills/rolo-outreach/SKILL.md`: how to choose people (fit, warmth, one per team at a time, nobody already in motion), how to read an Outlook forward, how to write the first email and the one-week follow-up, what to log and what never to. Claude Code reads it from the repository; zipped, the same folder uploads to claude.ai as a Skill. It is instructions, not code — Rolo enforces the rules above whether or not the playbook is followed.

### Merging and deleting contacts

A draft follows a merge to the winner and is deleted with its contact. A draft whose campaign group is deleted is kept, without a campaign.

### Decided while building, cheap to reverse

- Campaign details in a settings value rather than a table: a handful of campaigns, no per-person state, no migration to change their shape.
- "Met" is any meeting or call since the start, whoever logged it.
- The owner cannot write a draft from scratch in Rolo — drafts come from Claude; the owner edits them. Rolo's existing "open Gmail compose" on Today is unchanged.
- A second follow-up becomes due a week after the first. The playbook tells Claude not to write it unasked.

### Not built

- Sending. Not a stub: a non-goal.
- Seeing the owner's Sent Items. The record is the Sent click, the BCC, or the forwarded copy Claude reads.
- Unattended runs (Phase 17) and suggested addresses (Phase 18).

### Acceptance criteria

- [ ] Pure, stage: each row of the table above; a reply after a follow-up is "your move"; a bounce tag yields to a later reply; events before the start feed only "last in touch"; a follow-up is due on day 7 and not on day 6, and not while a draft waits; "no reply" from day 30; "not pursuing" outranks everything; a past call books nothing.
- [ ] Pure, compose: the Outlook link and the `mailto:` link carry recipient, subject and a 250-word body intact, with line breaks; punctuation, accents and line breaks survive a round trip, and a space is never a `+`; a link over its limit is not offered; an address that could carry a second parameter is refused; a BCC is added only when valid.
- [ ] Against a migrated database, campaigns: a campaign is a group plus a settings entry and no table; no goal, a taken name, a missing group and a future start are refused; a deleted group takes its campaign, and a new group reusing its id is not a campaign and starts clean; moving the start date back brings earlier mail in; archiving takes people off Today and back.
- [ ] Pipeline: one person walks nothing → draft → sent → follow-up due → followed up → reply → call booked → met; a cancelled event books nothing; both tags work case-insensitively; a WhatsApp reply later the same day is "your move" though the day's row is the owner's; archived contacts are left out.
- [ ] Drafts: addressed to the contact's own address, with a foreign address refused and none stored; a second draft is refused without `replaceDraftId` and replaces with it; empty, control-character-only and oversized text, an unknown person and an unknown campaign are refused; Sent writes one outbound email with the edited subject, moves the keep-in-touch clock, and cannot be repeated, edited or discarded afterwards; a draft retires on a matching logged send and not on an older email, another subject or an inbound one; Discard leaves the timeline untouched.
- [ ] Today: people due a follow-up are listed longest-wait first and once across two campaigns; inside the week, outside any campaign, or with a follow-up drafted they are not; the two waits and the BCC are saved and validated.
- [ ] Connector: `save_campaign` creates, sanitises the brief, reports unknown ids, honours `startedOn`, and keeps the brief on a goal-only update; `get_pipeline` returns exactly the documented shape and filters by stage; `save_draft` cleans subject and line endings, answers a repeated key from the first call, refuses a second draft, a foreign address, an unknown kind, an extra `send` argument and a read-only grant, and reports a missing address; undo removes a draft and restores the one it replaced, and keeps an edited or sent one; a forwarded copy of an email sent from a draft is not logged again while a different email the same day is; `purpose: "call"` needs a contact, books the call, and undoing it unbooks it; campaign undo restores the last edit, removes an empty created campaign with its group, and leaves a campaign changed since; the voice guide is replaced, length-checked and undone one version back; in review mode a draft and a campaign wait and apply on approval; `get_today` carries who is waiting and how many drafts are unsent.
- [ ] The widest call of each new read tool stays under the size cap on 10,000 contacts, and no tool output contains a planted secret.
- [ ] Merge: a draft moves to the winner; deleting the contact deletes it.
- [ ] E2E in a real browser: create a campaign from the form (a duplicate name is refused); a draft Claude wrote shows its address and an Outlook link whose only parameters are `to`, `subject` and `body`; editing the subject changes the link; Sent empties the list, puts the edited subject on the timeline once and moves the person to "Awaiting reply"; nine days on they are on Today once the start date is moved back; a drafted follow-up takes them off; Discard takes two clicks and logs nothing; archiving the campaign clears Today.
- [ ] Manual, the owner's: (1) one draft → Open in Outlook on the school account: recipient, subject and text arrive intact; with a BCC set, check the copy lands in Gmail. (2) In Claude: "set up a campaign for …, pick ten, draft them" → ten cards → send and click Sent → a week later the non-repliers are on Today.

---

## Decisions (resolved with owner, 2026-08-12)

1. **"What counts for touch"** (§3): CONFIRMED — inbound-only email does not reset the cadence clock; only outbound emails, meetings, LinkedIn messages, manual logs, and counting notes do.
2. **Snooze-all parameters** (§3): CONFIRMED — 21-day horizon, weekday-only, per-day floor of 3, as defaults (all settings).
3. **Cross-source conflict default** (§8): keep stored value, report conflict. (Owner can request per-source precedence later if it gets annoying.)
4. **Geocoding provider** (§1/§7): CONFIRMED — Nominatim (OpenStreetMap) with heavy caching, off by default; radius filter disabled with tooltip until enabled in settings.
5. **Notes counting as interactions** (§3): default toggle stands as specced — on for notes created via Today's "log interaction", off for plain notes.
6. **Auth setup** (owner decision): first-run setup screen creates the password (hash in `settings`), changeable in settings; recovery via documented CLI reset script. No password env var.
   - **Failed-login throttle** (added 2026-11-19): the login is on the public internet, so consecutive wrong passwords are counted. Four are free; the 5th starts a 30 s lockout that doubles with each further failure (30 s, 1, 2, 4, 8 min) up to a 15-minute cap. During a lockout every attempt is refused before the password is checked — the correct one included — and refused attempts neither count nor extend the wait. The form says how long is left. A successful login resets the count; so does the reset script.
   - The counter is **global**, not per client IP: there is one account, so every guess targets the same password, and a per-IP count is exactly what rotating addresses gets around. The cost is that a stranger hammering the login can keep a logged-out owner waiting (never more than 15 minutes per attempt; an existing session is unaffected). State (`auth.login_throttle` in `settings`: failure count + time of the last one) survives restarts. Decision logic is pure, in `lib/auth/login-throttle.ts`.
7. **LinkedIn automatic sync** (owner decision, 2026-08-13): add the Member Data Portability API as a second official ingestion channel (§9a); the scraping/automation prohibition stands.
8. **Agent connector** (owner decision, 2026-11-19, §14): an owner-only MCP endpoint; direct agent writes for appended, undoable records and provenance-guarded field writes; the data flow into the owner's Claude conversations accepted; an OAuth authorization server inside Rolo with the password gate as consent; migration 0020 (`agent_grants`, `agent_calls`); `@modelcontextprotocol/server` as the one new dependency, to be added with Phase 14; campaigns as a group plus a brief with the stage derived from interactions; the Outbox's "Sent" as the record of sent mail. Hosting on a public HTTPS address is the owner's to confirm before Phase 14.
