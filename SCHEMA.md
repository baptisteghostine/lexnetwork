# SCHEMA.md — Rolo Data Model

SQLite via better-sqlite3 + Drizzle. Conventions:
- `id` = `INTEGER PRIMARY KEY` (SQLite rowid alias) unless noted.
- Timestamps = `INTEGER` unix epoch **milliseconds**, named `*_at`. Nullable when the event may not have happened.
- Booleans = `INTEGER` 0/1.
- `source` columns = TEXT enum: `'user' | 'csv' | 'vcard' | 'linkedin' | 'google_contacts' | 'gmail' | 'calendar' | 'merge' | 'ai'` (ai only ever via approved suggestions).
- All FKs declared with `ON DELETE` behavior stated; `PRAGMA foreign_keys = ON` at every connection open, plus `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`.

Tables the brief listed are all here, plus **four additions** (each flagged inline): `contact_field_sources`, `duplicate_candidates`, `ai_suggestions`, `settings`. Rationale in their sections; if you'd rather fold any of them elsewhere, say so before Phase 1.

---

## contacts

| column | type | notes |
|---|---|---|
| id | INTEGER PK | |
| first_name | TEXT | nullable |
| last_name | TEXT | nullable |
| display_name | TEXT NOT NULL | maintained by app on write: `first last` → else email → else phone → else "Unnamed"; avoids COALESCE soup in every query and is what FTS indexes |
| photo_path | TEXT | relative path under `data/attachments/` |
| title | TEXT | current title (denormalized from work_history's current row when imports write both) |
| company | TEXT | current company, same note |
| location | TEXT | freeform as entered |
| location_lat / location_lng | REAL | nullable; set by geocoder |
| bio | TEXT | short one-liner from imports |
| description_md | TEXT | owner's freeform markdown |
| birthday_month | INTEGER | 1–12, nullable |
| birthday_day | INTEGER | 1–31, nullable (month+day set together, CHECK) |
| birthday_year | INTEGER | nullable independently |
| starred | INTEGER NOT NULL DEFAULT 0 | |
| archived_at | INTEGER | null = active; timestamp beats a boolean (you'll want "archived when") |
| cadence_days | INTEGER | null = no keep-in-touch |
| cadence_assigned_at | INTEGER | base for next_touch when no interaction yet |
| cadence_reviewed_at | INTEGER | when the owner last made a keep-in-touch decision. Splits the two meanings of `cadence_days IS NULL`: never triaged (null) vs deliberately excluded (set) — the board's `Uncategorized` and `Don't keep in touch` columns (SPEC §3a). Added in migration 0014 |
| snoozed_until | INTEGER | cleared by counting interactions |
| last_interaction_at | INTEGER | **derived** — max counting interaction; recomputed by cadence engine |
| next_touch_at | INTEGER | **derived** — see SPEC §3; the single most-queried column |
| created_at / updated_at | INTEGER NOT NULL | |

Why birthday as three INTs, not a date string: year-less birthdays are the common case; separate columns make the "birthdays in next 7 days incl. year wrap" query a sane indexed expression instead of substr() gymnastics.

**Indexes**
- `idx_contacts_next_touch ON contacts(next_touch_at) WHERE archived_at IS NULL AND cadence_days IS NOT NULL` — the Today queue.
- `idx_contacts_birthday ON contacts(birthday_month, birthday_day) WHERE archived_at IS NULL`
- `idx_contacts_company ON contacts(company)` , `idx_contacts_created ON contacts(created_at)`, `idx_contacts_starred ON contacts(starred) WHERE starred = 1`
- `idx_contacts_last_interaction ON contacts(last_interaction_at)` — "haven't spoken since" filters.

## contact_field_sources  *(added table — provenance per scalar field)*

| column | type | notes |
|---|---|---|
| contact_id | INTEGER FK → contacts ON DELETE CASCADE | |
| field | TEXT | e.g. 'title', 'company', 'location', 'bio', 'birthday' |
| source | TEXT NOT NULL | enum above |
| sync_run_id | INTEGER FK → sync_runs ON DELETE SET NULL | which run set it |
| updated_at | INTEGER NOT NULL | |
| PK | (contact_id, field) | |

Of the four added tables this is the one I feel strongest about: per-field provenance is a stated core requirement, and a JSON blob on `contacts` would be unqueryable for "show me everything LinkedIn last touched" and un-diffable in conflict resolution. Multi-value tables below carry their own `source` column instead (each row has exactly one origin).

## contact_emails

| column | type |
|---|---|
| id | INTEGER PK |
| contact_id | INTEGER NOT NULL FK → contacts ON DELETE CASCADE |
| email | TEXT NOT NULL (as entered) |
| email_normalized | TEXT NOT NULL (lowercased; gmail dot/plus-stripped) |
| label | TEXT ('work','home','other'…) |
| priority | INTEGER NOT NULL DEFAULT 0 (0 = primary) |
| source | TEXT NOT NULL |
| created_at | INTEGER NOT NULL |

- `UNIQUE(contact_id, email_normalized)`
- `idx_emails_normalized ON contact_emails(email_normalized)` — **the** join column for Gmail sync, dedupe, and import identity. Not globally unique: two not-yet-merged contacts may share one; dedupe finds them via this index.

## contact_phones

Same shape: `phone_raw`, `phone_e164` (nullable — not everything parses), `label`, `priority`, `source`. `UNIQUE(contact_id, phone_e164)`, `idx_phones_e164 ON contact_phones(phone_e164) WHERE phone_e164 IS NOT NULL`.

## contact_socials

`id, contact_id FK CASCADE, platform TEXT ('linkedin','twitter','github','website','other'), url TEXT NOT NULL, handle TEXT, source, created_at`.
- `UNIQUE(contact_id, url)`
- `idx_socials_url ON contact_socials(url)` — LinkedIn profile URL is the identity key for LinkedIn imports; this index makes that lookup fast. Partial index `idx_socials_linkedin ON contact_socials(contact_id) WHERE platform='linkedin'` serves the has-linkedin filter.

## work_history

`id, contact_id FK CASCADE, company TEXT NOT NULL, company_normalized TEXT NOT NULL, title TEXT, start_date TEXT (ISO 'YYYY-MM' or 'YYYY'), end_date TEXT nullable, is_current INTEGER NOT NULL DEFAULT 0, source, created_at`.
- `idx_work_company ON work_history(company_normalized)` — powers "current OR past company" filters ("ex-Googlers").
- Dates as TEXT because sources give partial dates ('2021', '2021-03'); lexicographic ISO ordering still sorts correctly. Flagged below.

## education

`id, contact_id FK CASCADE, school TEXT NOT NULL, degree TEXT, field TEXT, start_year INTEGER, end_year INTEGER, source, created_at`. `idx_education_school ON education(school)`.

## notes

`id, contact_id INTEGER FK → contacts ON DELETE CASCADE nullable (null = standalone note), body_md TEXT NOT NULL DEFAULT '', summary_ai TEXT nullable, counts_for_touch INTEGER NOT NULL DEFAULT 0, created_at, updated_at`.
- `idx_notes_contact ON notes(contact_id, created_at DESC)`.
- The note's timeline entry is the note row itself (kind 'note' in the union), *not* duplicated into `interactions` — one source of truth; the cadence engine's "max counting interaction" query unions notes where `counts_for_touch=1`.

## note_mentions

`id, note_id FK → notes ON DELETE CASCADE, contact_id FK → contacts ON DELETE CASCADE nullable, group_id FK → groups ON DELETE CASCADE nullable, CHECK (one of contact_id/group_id set)`.
- `UNIQUE(note_id, contact_id, group_id)`; `idx_mentions_contact ON note_mentions(contact_id)` — "notes mentioning this person" on their timeline.

## attachments

`id, note_id INTEGER NOT NULL FK → notes ON DELETE CASCADE, filename TEXT NOT NULL, mime TEXT NOT NULL, size_bytes INTEGER NOT NULL, path TEXT NOT NULL (relative, under data/attachments/), created_at`.
- `idx_attachments_note ON attachments(note_id)`. Files on disk, path in DB (SQLite blobs would bloat backups and exports). Contact photos reuse the same directory but are referenced from `contacts.photo_path` directly — photos aren't note-owned.

## interactions

Everything externally-sourced or manually logged (notes live in `notes`):

| column | type | notes |
|---|---|---|
| id | INTEGER PK | |
| contact_id | INTEGER NOT NULL FK → contacts ON DELETE CASCADE | |
| kind | TEXT NOT NULL | 'email' \| 'meeting' \| 'message' \| 'manual' \| 'reminder_fired' |
| direction | TEXT | 'inbound' \| 'outbound' \| null |
| occurred_at | INTEGER NOT NULL | |
| title | TEXT | subject / event title / free text. For email: subject only — never a body |
| meta | TEXT (JSON) | thread id, other participants, event id, conversation id |
| source | TEXT NOT NULL | |
| source_key | TEXT | idempotency key: gmail msg id, calendar event+occurrence id, linkedin convo+ts |
| counts_for_touch | INTEGER NOT NULL | precomputed at insert per SPEC §3 rules |
| sync_run_id | INTEGER FK → sync_runs ON DELETE SET NULL | |
| created_at | INTEGER NOT NULL | |

- `UNIQUE(contact_id, source, source_key) WHERE source_key IS NOT NULL` — the idempotency backbone: one email to 3 contacts = 3 rows, each unique per contact; re-sync upserts cleanly.
- `idx_interactions_contact_time ON interactions(contact_id, occurred_at DESC)` — per-contact timeline.
- `idx_interactions_time ON interactions(occurred_at DESC)` — global timeline.
- `idx_interactions_touch ON interactions(contact_id, occurred_at DESC) WHERE counts_for_touch = 1` — the cadence engine's max() lookup.

## reminders

`id, contact_id FK → contacts ON DELETE SET NULL nullable, title TEXT NOT NULL, body TEXT, due_at INTEGER NOT NULL, rrule TEXT nullable, series_id INTEGER nullable (self-reference: occurrences point at the defining reminder), fired_at INTEGER, completed_at INTEGER, snoozed_until INTEGER, created_at, updated_at`.
- Recurring model: the defining row holds the RRULE; each materialized occurrence is its own row with `series_id` → definer, so firing/completing an occurrence is a plain update and history is queryable. Next occurrence materialized when the current fires/completes.
- `idx_reminders_due ON reminders(due_at) WHERE completed_at IS NULL AND rrule IS NULL` (occurrences + one-offs), `idx_reminders_contact ON reminders(contact_id)`.

## tags / contact_tags

- `tags: id, name TEXT NOT NULL UNIQUE COLLATE NOCASE, color TEXT NOT NULL, created_at`.
- `contact_tags: contact_id FK CASCADE, tag_id FK → tags ON DELETE CASCADE, created_at, PK(contact_id, tag_id)`, `idx_contact_tags_tag ON contact_tags(tag_id)` (filter side).

## groups / group_members

- `groups: id, name TEXT NOT NULL, emoji TEXT, parent_id INTEGER FK → groups ON DELETE SET NULL, sort_order INTEGER, created_at`. Uniqueness is two partial indexes rather than one `UNIQUE(parent_id, name)`: SQLite treats NULLs as distinct in unique indexes, so root-level names need `UNIQUE(name) WHERE parent_id IS NULL` plus `UNIQUE(parent_id, name) WHERE parent_id IS NOT NULL`. Depth capped in app at 3 — descendant queries use a recursive CTE; fine at personal scale.
- `group_members: group_id FK CASCADE, contact_id FK CASCADE, created_at, PK(group_id, contact_id)`, index on `(contact_id)`.

## custom_fields / custom_field_values

- `custom_fields: id, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL ('text','number','date','single_select','multi_select'), options TEXT (JSON array for selects), sort_order INTEGER, created_at`.
- `custom_field_values: id, custom_field_id FK CASCADE, contact_id FK CASCADE, value_text TEXT, value_number REAL, value_date INTEGER, value_json TEXT (multi_select array), UNIQUE(custom_field_id, contact_id)`.
- Typed columns (one populated per kind) instead of a single TEXT: keeps number/date filters real comparisons with `idx_cfv_field_number ON custom_field_values(custom_field_id, value_number)`, `..._date`, `..._text` indexes.

## views

`id, name TEXT NOT NULL, filter_json TEXT NOT NULL (versioned {v:1,...}), sort_json TEXT, pinned INTEGER NOT NULL DEFAULT 0, sort_order INTEGER, created_at, updated_at`.
- Filters are code-versioned JSON; a migration bumps `v` and rewrites when the filter schema changes. Flagged below.

## contact_relationships

`id, contact_a_id FK CASCADE, contact_b_id FK CASCADE, label TEXT ('introduced_by','colleague','spouse','friend','knows'…free text allowed), directed INTEGER 0/1, note TEXT, created_at`.
- `UNIQUE(contact_a_id, contact_b_id, label)`, index on `contact_b_id`. Ordering rule (amended in Phase 9 — the original "always canonicalize a<b + directed flag" was self-contradictory, since forcing a<b can flip a directed edge's meaning): **undirected edges are stored canonicalized `contact_a_id < contact_b_id`; directed edges store semantic order**, reading A→B ("A introduced_by B"). UI renders both ways.

## integration_accounts

`id, provider TEXT NOT NULL ('google','linkedin' — UNIQUE, one connection per provider), account_email TEXT NOT NULL, scopes TEXT NOT NULL, access_token TEXT, refresh_token TEXT, token_expires_at INTEGER, gmail_history_id TEXT, gmail_backfill_done INTEGER DEFAULT 0, calendar_sync_token TEXT, people_sync_token TEXT, my_addresses TEXT (JSON array incl. aliases, for direction detection), linkedin_domains TEXT (JSON array — snapshot domains observed for this token; CONNECTIONS is required for sync and must be discovered, not assumed), linkedin_snapshot_at INTEGER, status TEXT ('active','error','revoked'), last_error TEXT, created_at, updated_at`.
- Tokens at rest are encrypted with a key from `SESSION_SECRET`-derived KDF (single-user box, but the SQLite file gets backed up/copied around — don't leave refresh tokens plaintext in backups). Implemented in `src/lib/crypto.ts` (AES-256-GCM, scrypt-derived key); rotating the secret invalidates stored tokens, which surfaces as a "reconnect" status. When `SESSION_SECRET` isn't set, the generated secret is persisted to `data/secret.key` (0600) — deliberately **outside the database**, so a copied `rolo.db` doesn't carry the key that decrypts its own tokens.
- 'linkedin' rows added 2026-08-13 for the Member Data Portability API (SPEC §9a). LinkedIn self-serve tokens usually have no refresh token — expiry (~60 days) means reconnect.

## calendar_events  *(added table — Today agenda cache)*

`id, event_key TEXT NOT NULL UNIQUE (Google event id; recurring instances are unique under singleEvents=true), account_id FK → integration_accounts ON DELETE CASCADE, summary TEXT, starts_at INTEGER NOT NULL, ends_at INTEGER, all_day INTEGER DEFAULT 0, status TEXT NOT NULL ('confirmed','tentative' — cancelled events are deleted rows), my_response TEXT ('accepted','declined','tentative','needsAction'), attendees TEXT (JSON [{email, name, contact_id|null}] — matched at sync time), html_link TEXT, updated_at`.
- `idx_calendar_events_start ON calendar_events(starts_at)` — the agenda query.
- Why a table: interactions hold only *past* meetings; the agenda needs today's and upcoming events without a live API call at page render. Bounded by the sync window (past 1y/future 60d), so it self-prunes as the window slides.

## sync_runs

Covers **both** API syncs and file imports (one lifecycle: started → stats → finished/failed):

`id, kind TEXT NOT NULL ('gmail','calendar','google_contacts','csv_import','vcard_import','linkedin_import','linkedin_api_sync','linkedin_voyager_sync','dedupe_scan','export','backup'), integration_account_id FK ON DELETE SET NULL, file_name TEXT, file_sha256 TEXT, mapping_json TEXT (CSV column mapping used), cursor_before TEXT, cursor_after TEXT, status TEXT ('running','success','failed','partial'), stats_json TEXT ({new, updated, unchanged, conflicts, errors,…}), report_json TEXT (row-level diff report; large, loaded lazily), error TEXT, started_at, finished_at`.
- `idx_sync_runs_kind ON sync_runs(kind, started_at DESC)`, `idx_sync_runs_sha ON sync_runs(file_sha256)` (the "already imported this exact file" check).

## contact_changes

`id, contact_id FK CASCADE, field TEXT NOT NULL, old_value TEXT, new_value TEXT, source TEXT NOT NULL, sync_run_id FK SET NULL, detected_at INTEGER NOT NULL, dismissed_at INTEGER, acted_at INTEGER (owner logged an interaction from the card)`.
- `idx_changes_open ON contact_changes(detected_at DESC) WHERE dismissed_at IS NULL AND acted_at IS NULL` — the Today cards. `idx_changes_contact ON contact_changes(contact_id, detected_at DESC)` — timeline.

## merge_log

`id, winner_contact_id INTEGER NOT NULL (no FK — winner may itself later merge away; keep the log immutable), loser_contact_id INTEGER NOT NULL, loser_snapshot_json TEXT NOT NULL (full loser row + all child rows), repointed_json TEXT NOT NULL (id lists per table moved to winner), field_decisions_json TEXT NOT NULL, merged_at INTEGER NOT NULL, undone_at INTEGER`.
- Everything needed for undo is in the log itself; no soft-deleted ghost contact rows.
- `field_decisions_json` holds `{decisions, winnerBefore, winnerAfter}` — the winner's full pre-merge row (undo restores it byte-identical) and post-merge row (undo compares profile columns against it and refuses when they've since been edited).

## duplicate_candidates  *(added table — dedupe queue)*

`id, contact_a_id FK CASCADE, contact_b_id FK CASCADE (canonical a<b), score REAL NOT NULL, reasons_json TEXT NOT NULL (['email_match','jw:0.93','same_company']), status TEXT NOT NULL ('open','dismissed','merged'), created_at, resolved_at`.
- `UNIQUE(contact_a_id, contact_b_id)` — dismissal memory lives here (`status='dismissed'` rows persist and suppress re-suggestion).

## jobs

`id, kind TEXT NOT NULL ('gmail_sync','calendar_sync','linkedin_sync','linkedin_voyager_sync','digest','backup','dedupe_scan','reminder_fire','geocode','ai_batch_tag'), payload_json TEXT, dedupe_key TEXT (UNIQUE where NOT NULL — prevents double-enqueue of e.g. today's digest), run_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, status TEXT NOT NULL ('pending','running','success','failed','dead'), attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 5, last_error TEXT, created_at`.
- `idx_jobs_pending ON jobs(run_at) WHERE status = 'pending'` — the scheduler's poll (every ~15 s). Backoff: `run_at += 2^attempts * 30s`. Stale 'running' rows older than a lease window are reclaimed at startup (crash recovery). Recurring jobs re-enqueue their next run on completion — schedule lives in code, durability in this table.
- Implementation note (Phase 5): reminder firing does NOT create per-fire job rows — the scheduler tick sweeps due reminders inline, with `reminders.fired_at` as the exactly-once ledger (idempotent across crashes, no reminder↔job sync to keep straight). The `reminder_fire` kind stays reserved for future one-off scheduled fires if ever needed.

## ai_calls

`id, feature TEXT NOT NULL ('nl_search','auto_tag','openers','summarize'), model TEXT NOT NULL, prompt TEXT NOT NULL, response TEXT, input_tokens INTEGER, output_tokens INTEGER, latency_ms INTEGER, status TEXT ('success','error'), error TEXT, created_at`.
- `idx_ai_calls_feature ON ai_calls(feature, created_at DESC)`. Prompt/response stored verbatim for audit; a settings toggle can truncate stored prompts later if the table gets fat.

## ai_suggestions  *(added table — approval queue)*

`id, kind TEXT NOT NULL ('tag'), contact_id FK CASCADE, payload_json TEXT NOT NULL ({tagName, isNewTag, confidence, rationale}), ai_call_id FK SET NULL, status TEXT ('pending','approved','rejected'), created_at, resolved_at`.
- Generic enough for future suggestion types; "AI never writes directly" is enforced by making this the only path.

## settings  *(added table)*

`key TEXT PRIMARY KEY, value TEXT NOT NULL (JSON)`. Timezone, digest hour, SMTP config, snooze-all params, password hash, birthday-Feb-29 rule, my-addresses default, geocoder config. A settings table beats env vars for anything the UI should edit.

- `linkedin_voyager.session` → the owner's pasted LinkedIn cookie pair (SPEC §9b), boxed with `lib/crypto` `encryptToken` (same at-rest encryption as OAuth tokens — a live LinkedIn login must not sit plaintext in backups; rotating the session secret invalidates it, surfaced as "reconnect"). `linkedin_voyager.enabled` → boolean, the weekly-sync opt-in toggle.

---

## FTS5 setup

Two external-content virtual tables (index only; content stays in the base tables), kept in sync by triggers — checked into a hand-written migration since Drizzle doesn't model virtual tables:

```sql
CREATE VIRTUAL TABLE contacts_fts USING fts5(
  display_name, company, title, location, bio,
  content='contacts', content_rowid='id',
  tokenize='trigram remove_diacritics 1'
);
-- trigram tokenizer => substring + typo-tolerant matching on short fields,
-- at the cost of a bigger index. Fine at personal scale (<100k rows).
-- remove_diacritics folds "björn" → "bjorn" at index time (migration 0012)
-- because the query side strips diacritics — both sides must agree or
-- accented names are unfindable.

CREATE VIRTUAL TABLE notes_fts USING fts5(
  body_md,
  content='notes', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);
-- word-based for prose; trigram on note bodies would triple index size for
-- little gain — you search notes by words, contacts by name fragments.

-- Sync triggers (same pattern for notes_fts):
CREATE TRIGGER contacts_ai AFTER INSERT ON contacts BEGIN
  INSERT INTO contacts_fts(rowid, display_name, company, title, location, bio)
  VALUES (new.id, new.display_name, new.company, new.title, new.location, new.bio);
END;
CREATE TRIGGER contacts_ad AFTER DELETE ON contacts BEGIN
  INSERT INTO contacts_fts(contacts_fts, rowid, display_name, company, title, location, bio)
  VALUES ('delete', old.id, old.display_name, old.company, old.title, old.location, old.bio);
END;
CREATE TRIGGER contacts_au AFTER UPDATE ON contacts BEGIN
  INSERT INTO contacts_fts(contacts_fts, rowid, ...) VALUES ('delete', old.id, ...);
  INSERT INTO contacts_fts(rowid, ...) VALUES (new.id, ...);
END;
```

Search flow: FTS candidates (name/company/title/notes) → app-side re-rank with Jaro-Winkler + nickname map on the name portion → grouped results. Emails/phones are searched via their normalized-column indexes (prefix `LIKE 'x%'`), not FTS.

## Filter → index map (every SPEC §7 filter has a plan)

| Filter | Served by |
|---|---|
| group (incl. descendants) | recursive CTE on groups + `group_members(contact_id)` PK |
| tag | `idx_contact_tags_tag` |
| last-interaction before/after | `idx_contacts_last_interaction` |
| title contains | `contacts_fts` (trigram) |
| company current/past | `idx_contacts_company` + `idx_work_company` (UNION) |
| education | `idx_education_school` |
| location radius | bounding-box on `location_lat/lng` then haversine in app (no R-tree needed at this scale) |
| has-linkedin | `idx_socials_linkedin` |
| created-at | `idx_contacts_created` |
| custom field predicates | typed `idx_cfv_*` indexes |
| due / starred / archived | partial indexes on contacts |
| birthdays upcoming | `idx_contacts_birthday` |

## Things you might regret in 6 months (flagged now)

1. **Denormalized `title`/`company` on contacts alongside `work_history`.** Two writers must stay consistent (imports write both; the "current" work_history row is the truth). I chose it because every list row and FTS entry needs title/company and joining work_history for that is silly — but it's the classic drift risk. The import layer is the only writer of both; keep it that way.
2. **`report_json` on sync_runs** can get large (a 5k-row LinkedIn diff). It's lazy-loaded and prunable (keep last N reports per kind), but if it annoys, it splits into a `sync_run_rows` table later — cheap migration, flagged so it's a decision not an accident.
3. **Partial dates as TEXT in work_history.** Sorts fine, but no arithmetic. If you ever want "tenure length" features, this becomes a parse. Accepted for import fidelity.
4. **Filter JSON in `views` (and `mapping_json`, `payload_json`, …).** Versioned (`{v:1}`) and validated with Zod at read time, but JSON-in-TEXT always rots quietly. The version field + a "rewrite on load, warn on unknown" policy is the mitigation.
5. **Notes outside `interactions`.** The timeline is a UNION of notes + interactions + contact_changes + fired reminders. Keeps one source of truth per entity but makes the global timeline query a 4-way UNION ALL with per-branch limits. At single-user scale this is fine; if it ever isn't, the fix is a materialized `timeline_entries` table fed by the same writers.
6. **`merge_log` has no FK on contact ids** (deliberate — log must survive later merges/deletes), which means the undo path must verify referents still exist. The code owns that invariant, not the DB.
7. **Epoch-ms integers everywhere** are great for math and indexing, invisible in `sqlite3` CLI spelunking. `strftime` wrappers in a `queries.md` crib sheet will help; alternatively a `datetime` view per table if you find yourself in the CLI often.
