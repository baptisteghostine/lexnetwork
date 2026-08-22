import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// Timestamps are unix epoch milliseconds (see SCHEMA.md conventions).
// `source` values: 'user' | 'csv' | 'vcard' | 'linkedin' | 'google_contacts'
//                | 'gmail' | 'calendar' | 'merge' | 'ai'

export const contacts = sqliteTable(
  "contacts",
  {
    id: integer("id").primaryKey(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    // Derived: maintained by app on every write (see SCHEMA.md).
    displayName: text("display_name").notNull(),
    photoPath: text("photo_path"),
    title: text("title"),
    company: text("company"),
    location: text("location"),
    locationLat: real("location_lat"),
    locationLng: real("location_lng"),
    bio: text("bio"),
    descriptionMd: text("description_md"),
    birthdayMonth: integer("birthday_month"),
    birthdayDay: integer("birthday_day"),
    birthdayYear: integer("birthday_year"),
    starred: integer("starred", { mode: "boolean" }).notNull().default(false),
    archivedAt: integer("archived_at"),
    cadenceDays: integer("cadence_days"),
    cadenceAssignedAt: integer("cadence_assigned_at"),
    // When the owner last made a keep-in-touch decision about this person.
    // Distinguishes "deliberately no cadence" from "never triaged" — both
    // of which have cadence_days IS NULL. Drives the board's
    // Uncategorized vs "Don't keep in touch" columns (SPEC §3a).
    cadenceReviewedAt: integer("cadence_reviewed_at"),
    snoozedUntil: integer("snoozed_until"),
    // Derived: recomputed by the cadence engine, never hand-written.
    lastInteractionAt: integer("last_interaction_at"),
    // Derived: recomputed by the cadence engine, never hand-written.
    nextTouchAt: integer("next_touch_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("idx_contacts_next_touch")
      .on(t.nextTouchAt)
      .where(sql`archived_at IS NULL AND cadence_days IS NOT NULL`),
    index("idx_contacts_birthday")
      .on(t.birthdayMonth, t.birthdayDay)
      .where(sql`archived_at IS NULL`),
    index("idx_contacts_starred").on(t.starred).where(sql`starred = 1`),
    index("idx_contacts_company").on(t.company),
    index("idx_contacts_created").on(t.createdAt),
    index("idx_contacts_last_interaction").on(t.lastInteractionAt),
  ]
);

export const contactEmails = sqliteTable(
  "contact_emails",
  {
    id: integer("id").primaryKey(),
    contactId: integer("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    emailNormalized: text("email_normalized").notNull(),
    label: text("label"),
    priority: integer("priority").notNull().default(0),
    source: text("source").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_emails_contact_normalized").on(
      t.contactId,
      t.emailNormalized
    ),
    index("idx_emails_normalized").on(t.emailNormalized),
  ]
);

export const contactPhones = sqliteTable(
  "contact_phones",
  {
    id: integer("id").primaryKey(),
    contactId: integer("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    phoneRaw: text("phone_raw").notNull(),
    phoneE164: text("phone_e164"),
    label: text("label"),
    priority: integer("priority").notNull().default(0),
    source: text("source").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_phones_contact_e164").on(t.contactId, t.phoneE164),
    index("idx_phones_e164")
      .on(t.phoneE164)
      .where(sql`phone_e164 IS NOT NULL`),
  ]
);

export const contactSocials = sqliteTable(
  "contact_socials",
  {
    id: integer("id").primaryKey(),
    contactId: integer("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    url: text("url").notNull(),
    handle: text("handle"),
    source: text("source").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_socials_contact_url").on(t.contactId, t.url),
    index("idx_socials_url").on(t.url),
    index("idx_socials_linkedin")
      .on(t.contactId)
      .where(sql`platform = 'linkedin'`),
  ]
);

export const tags = sqliteTable("tags", {
  id: integer("id").primaryKey(),
  name: text("name").notNull().unique(),
  color: text("color").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const contactTags = sqliteTable(
  "contact_tags",
  {
    contactId: integer("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    tagId: integer("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.contactId, t.tagId] }),
    index("idx_contact_tags_tag").on(t.tagId),
  ]
);

// Per-field provenance for scalar contact fields (see SCHEMA.md).
export const contactFieldSources = sqliteTable(
  "contact_field_sources",
  {
    contactId: integer("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    field: text("field").notNull(),
    source: text("source").notNull(),
    syncRunId: integer("sync_run_id").references(() => syncRuns.id, {
      onDelete: "set null",
    }),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.contactId, t.field] })]
);

// One row per sync tick or file import (see SCHEMA.md).
export const syncRuns = sqliteTable(
  "sync_runs",
  {
    id: integer("id").primaryKey(),
    // 'csv_import' | 'vcard_import' | 'linkedin_import' | 'gmail' |
    // 'calendar' | 'google_contacts' | 'dedupe_scan' | 'export' | 'backup'
    kind: text("kind").notNull(),
    fileName: text("file_name"),
    fileSha256: text("file_sha256"),
    // Column mapping used (CSV), JSON.
    mappingJson: text("mapping_json"),
    cursorBefore: text("cursor_before"),
    cursorAfter: text("cursor_after"),
    // 'running' | 'success' | 'failed' | 'partial'
    status: text("status").notNull(),
    // {new, updated, unchanged, conflicts, errors}, JSON.
    statsJson: text("stats_json"),
    // Row-level diff report, JSON — large, load lazily.
    reportJson: text("report_json"),
    error: text("error"),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (t) => [
    index("idx_sync_runs_kind").on(t.kind, t.startedAt),
    index("idx_sync_runs_sha").on(t.fileSha256),
  ]
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  // JSON-encoded value.
  value: text("value").notNull(),
});

export const contactChanges = sqliteTable(
  "contact_changes",
  {
    id: integer("id").primaryKey(),
    contactId: integer("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    // 'company' | 'title'
    field: text("field").notNull(),
    oldValue: text("old_value"),
    newValue: text("new_value"),
    source: text("source").notNull(),
    syncRunId: integer("sync_run_id").references(() => syncRuns.id, {
      onDelete: "set null",
    }),
    detectedAt: integer("detected_at").notNull(),
    dismissedAt: integer("dismissed_at"),
    // Owner logged an interaction from the Today card.
    actedAt: integer("acted_at"),
    // Stamped when this change went out in a network-updates email, so the
    // next one only carries what the owner hasn't been told yet. Distinct
    // from the daily digest, which mirrors whatever Today shows right now
    // and may therefore repeat a change until it's dismissed or acted on.
    notifiedAt: integer("notified_at"),
  },
  (t) => [
    // The Today "reason to reach out" cards.
    index("idx_changes_open")
      .on(t.detectedAt)
      .where(sql`dismissed_at IS NULL AND acted_at IS NULL`),
    index("idx_changes_contact").on(t.contactId, t.detectedAt),
  ]
);

// Pulled forward from Phase 7 (shape verbatim from SCHEMA.md): the Phase 6
// filter compiler's "current OR past company" and education dimensions —
// and the ex-Googlers AC — need these to exist. LinkedIn import populates
// them in Phase 7.
export const workHistory = sqliteTable(
  "work_history",
  {
    id: integer("id").primaryKey(),
    contactId: integer("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    company: text("company").notNull(),
    companyNormalized: text("company_normalized").notNull(),
    title: text("title"),
    // ISO 'YYYY-MM' or 'YYYY' — sources give partial dates; lexicographic
    // ISO ordering still sorts correctly (SCHEMA.md).
    startDate: text("start_date"),
    endDate: text("end_date"),
    isCurrent: integer("is_current", { mode: "boolean" })
      .notNull()
      .default(false),
    source: text("source").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("idx_work_company").on(t.companyNormalized)]
);

export const education = sqliteTable(
  "education",
  {
    id: integer("id").primaryKey(),
    contactId: integer("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    school: text("school").notNull(),
    degree: text("degree"),
    field: text("field"),
    startYear: integer("start_year"),
    endYear: integer("end_year"),
    source: text("source").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("idx_education_school").on(t.school)]
);

export const customFields = sqliteTable("custom_fields", {
  id: integer("id").primaryKey(),
  name: text("name").notNull().unique(),
  // 'text' | 'number' | 'date' | 'single_select' | 'multi_select'
  kind: text("kind").notNull(),
  // JSON array for select kinds.
  options: text("options"),
  sortOrder: integer("sort_order"),
  createdAt: integer("created_at").notNull(),
});

export const customFieldValues = sqliteTable(
  "custom_field_values",
  {
    id: integer("id").primaryKey(),
    customFieldId: integer("custom_field_id")
      .notNull()
      .references(() => customFields.id, { onDelete: "cascade" }),
    contactId: integer("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    // One populated per kind — keeps number/date filters real comparisons.
    valueText: text("value_text"),
    valueNumber: real("value_number"),
    valueDate: integer("value_date"),
    // multi_select array, JSON.
    valueJson: text("value_json"),
  },
  (t) => [
    uniqueIndex("uq_cfv_field_contact").on(t.customFieldId, t.contactId),
    index("idx_cfv_field_number").on(t.customFieldId, t.valueNumber),
    index("idx_cfv_field_date").on(t.customFieldId, t.valueDate),
    index("idx_cfv_field_text").on(t.customFieldId, t.valueText),
  ]
);

export const views = sqliteTable("views", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  // Versioned {v:1,...} — code-versioned JSON (SCHEMA.md).
  filterJson: text("filter_json").notNull(),
  sortJson: text("sort_json"),
  pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
  sortOrder: integer("sort_order"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const integrationAccounts = sqliteTable(
  "integration_accounts",
  {
    id: integer("id").primaryKey(),
    // 'google' | 'linkedin' — one connection per provider (SPEC §9/§9a).
    provider: text("provider").notNull(),
    accountEmail: text("account_email").notNull(),
    scopes: text("scopes").notNull(),
    // Encrypted at rest via lib/crypto (SESSION_SECRET-derived key).
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    tokenExpiresAt: integer("token_expires_at"),
    gmailHistoryId: text("gmail_history_id"),
    gmailBackfillDone: integer("gmail_backfill_done", { mode: "boolean" })
      .notNull()
      .default(false),
    calendarSyncToken: text("calendar_sync_token"),
    peopleSyncToken: text("people_sync_token"),
    // JSON array incl. aliases, for email direction detection.
    myAddresses: text("my_addresses"),
    // JSON array of snapshot domains the LinkedIn token can actually pull
    // (observed at connect time — LinkedIn varies this per product/version).
    linkedinDomains: text("linkedin_domains"),
    linkedinSnapshotAt: integer("linkedin_snapshot_at"),
    // 'active' | 'error' | 'revoked'
    status: text("status").notNull(),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("uq_integration_provider").on(t.provider)]
);

export const calendarEvents = sqliteTable(
  "calendar_events",
  {
    id: integer("id").primaryKey(),
    // Google event id (instances of recurring events have unique ids
    // under singleEvents=true) — the upsert key.
    eventKey: text("event_key").notNull(),
    accountId: integer("account_id")
      .notNull()
      .references(() => integrationAccounts.id, { onDelete: "cascade" }),
    summary: text("summary"),
    startsAt: integer("starts_at").notNull(),
    endsAt: integer("ends_at"),
    allDay: integer("all_day", { mode: "boolean" }).notNull().default(false),
    // Google event status: 'confirmed' | 'tentative' (cancelled = deleted row).
    status: text("status").notNull(),
    // Owner's own response: 'accepted' | 'declined' | 'tentative' | 'needsAction'.
    myResponse: text("my_response"),
    // JSON [{email, name, contactId|null}] — matched at sync time.
    attendees: text("attendees"),
    htmlLink: text("html_link"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_calendar_event").on(t.eventKey),
    index("idx_calendar_events_start").on(t.startsAt),
  ]
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: integer("id").primaryKey(),
    // 'gmail_sync' | 'calendar_sync' | 'digest' | 'backup' | 'dedupe_scan' |
    // 'reminder_fire' | 'geocode' | 'ai_batch_tag'
    kind: text("kind").notNull(),
    payloadJson: text("payload_json"),
    // Prevents double-enqueue of e.g. today's digest.
    dedupeKey: text("dedupe_key"),
    runAt: integer("run_at").notNull(),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
    // 'pending' | 'running' | 'success' | 'failed' | 'dead'
    status: text("status").notNull(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("idx_jobs_pending").on(t.runAt).where(sql`status = 'pending'`),
    uniqueIndex("uq_jobs_dedupe")
      .on(t.dedupeKey)
      .where(sql`dedupe_key IS NOT NULL`),
  ]
);

export const reminders = sqliteTable(
  "reminders",
  {
    id: integer("id").primaryKey(),
    // Contact-attached reminders survive contact deletion as standalone.
    contactId: integer("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    body: text("body"),
    dueAt: integer("due_at").notNull(),
    // RFC 5545 recurrence — held only by the defining row of a series.
    rrule: text("rrule"),
    // Occurrences point at the defining reminder.
    seriesId: integer("series_id"),
    firedAt: integer("fired_at"),
    completedAt: integer("completed_at"),
    snoozedUntil: integer("snoozed_until"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    // Occurrences + one-offs — what the scheduler and Today scan.
    index("idx_reminders_due")
      .on(t.dueAt)
      .where(sql`completed_at IS NULL AND rrule IS NULL`),
    index("idx_reminders_contact").on(t.contactId),
  ]
);

export const groups = sqliteTable(
  "groups",
  {
    id: integer("id").primaryKey(),
    name: text("name").notNull(),
    emoji: text("emoji"),
    parentId: integer("parent_id").references((): AnySQLiteColumn => groups.id, {
      onDelete: "set null",
    }),
    sortOrder: integer("sort_order"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    // SQLite treats NULLs as distinct in unique indexes, so root-level
    // uniqueness needs its own partial index.
    uniqueIndex("uq_groups_parent_name")
      .on(t.parentId, t.name)
      .where(sql`parent_id IS NOT NULL`),
    uniqueIndex("uq_groups_root_name")
      .on(t.name)
      .where(sql`parent_id IS NULL`),
  ]
);

export const groupMembers = sqliteTable(
  "group_members",
  {
    groupId: integer("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    contactId: integer("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.contactId] }),
    index("idx_group_members_contact").on(t.contactId),
  ]
);

export const notes = sqliteTable(
  "notes",
  {
    id: integer("id").primaryKey(),
    // null = standalone note (not attached to a contact).
    contactId: integer("contact_id").references(() => contacts.id, {
      onDelete: "cascade",
    }),
    bodyMd: text("body_md").notNull().default(""),
    summaryAi: text("summary_ai"),
    countsForTouch: integer("counts_for_touch", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("idx_notes_contact").on(t.contactId, t.createdAt)]
);

export const noteMentions = sqliteTable(
  "note_mentions",
  {
    id: integer("id").primaryKey(),
    noteId: integer("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    contactId: integer("contact_id").references(() => contacts.id, {
      onDelete: "cascade",
    }),
    groupId: integer("group_id").references(() => groups.id, {
      onDelete: "cascade",
    }),
  },
  (t) => [
    uniqueIndex("uq_mentions_note_contact")
      .on(t.noteId, t.contactId)
      .where(sql`contact_id IS NOT NULL`),
    uniqueIndex("uq_mentions_note_group")
      .on(t.noteId, t.groupId)
      .where(sql`group_id IS NOT NULL`),
    index("idx_mentions_contact").on(t.contactId),
  ]
);

export const attachments = sqliteTable(
  "attachments",
  {
    id: integer("id").primaryKey(),
    noteId: integer("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    mime: text("mime").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    // Relative to DATA_DIR, e.g. "attachments/12/photo.png".
    path: text("path").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("idx_attachments_note").on(t.noteId)]
);

export const interactions = sqliteTable(
  "interactions",
  {
    id: integer("id").primaryKey(),
    contactId: integer("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    // 'email' | 'meeting' | 'message' | 'manual' | 'reminder_fired'
    kind: text("kind").notNull(),
    // 'inbound' | 'outbound' | null
    direction: text("direction"),
    occurredAt: integer("occurred_at").notNull(),
    title: text("title"),
    // JSON: thread id, participants, event id, conversation id…
    meta: text("meta"),
    source: text("source").notNull(),
    // Idempotency key for synced/imported rows (gmail msg id, event id…).
    sourceKey: text("source_key"),
    countsForTouch: integer("counts_for_touch", { mode: "boolean" }).notNull(),
    // Which sync/import run wrote this row (SCHEMA.md; column added by
    // migration #9 — 0001 omitted it).
    syncRunId: integer("sync_run_id").references(() => syncRuns.id, {
      onDelete: "set null",
    }),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_interactions_source")
      .on(t.contactId, t.source, t.sourceKey)
      .where(sql`source_key IS NOT NULL`),
    index("idx_interactions_contact_time").on(t.contactId, t.occurredAt),
    index("idx_interactions_time").on(t.occurredAt),
    index("idx_interactions_touch")
      .on(t.contactId, t.occurredAt)
      .where(sql`counts_for_touch = 1`),
  ]
);

// Dedupe suggestion queue (SCHEMA.md `duplicate_candidates`, SPEC §10).
// Dismissal memory lives here: 'dismissed' rows persist and suppress
// re-suggestion — and a merge transfers the loser's dismissals to the
// winner before the cascade. The merged pair's own row dies with the
// loser via FK cascade (the loser id no longer exists to re-suggest);
// 'merged' stays in the status enum for potential future use.
export const duplicateCandidates = sqliteTable(
  "duplicate_candidates",
  {
    id: integer("id").primaryKey(),
    // Canonical a < b.
    contactAId: integer("contact_a_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    contactBId: integer("contact_b_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    score: real("score").notNull(),
    // e.g. ["email_match","jw:0.93","same_company"]
    reasonsJson: text("reasons_json").notNull(),
    // 'open' | 'dismissed' | 'merged'
    status: text("status").notNull(),
    createdAt: integer("created_at").notNull(),
    resolvedAt: integer("resolved_at"),
  },
  (t) => [
    uniqueIndex("uq_duplicate_pair").on(t.contactAId, t.contactBId),
    index("idx_duplicates_status").on(t.status, t.score),
  ]
);

// Merge audit + undo source of truth (SCHEMA.md `merge_log`). Deliberately
// no FKs on contact ids: the winner may itself merge away later and the
// log must stay immutable — the undo path verifies referents in code.
export const mergeLog = sqliteTable(
  "merge_log",
  {
    id: integer("id").primaryKey(),
    winnerContactId: integer("winner_contact_id").notNull(),
    loserContactId: integer("loser_contact_id").notNull(),
    // Full loser row + all child rows, enough to rebuild it byte-identical.
    loserSnapshotJson: text("loser_snapshot_json").notNull(),
    // Id lists per table moved to the winner, for repointing back on undo.
    repointedJson: text("repointed_json").notNull(),
    fieldDecisionsJson: text("field_decisions_json").notNull(),
    mergedAt: integer("merged_at").notNull(),
    undoneAt: integer("undone_at"),
  },
  (t) => [index("idx_merge_log_time").on(t.mergedAt)]
);

// Related-contacts edges (SCHEMA.md `contact_relationships`). Canonical
// contact_a_id < contact_b_id; direction-bearing labels set `directed`
// with the convention that the relation reads A→B ("A introduced_by B").
export const contactRelationships = sqliteTable(
  "contact_relationships",
  {
    id: integer("id").primaryKey(),
    contactAId: integer("contact_a_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    contactBId: integer("contact_b_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    directed: integer("directed", { mode: "boolean" }).notNull().default(false),
    note: text("note"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_relationship").on(t.contactAId, t.contactBId, t.label),
    index("idx_relationships_b").on(t.contactBId),
  ]
);

// AI audit log (SCHEMA.md `ai_calls`, SPEC §11): one row per model call,
// prompt/response verbatim, token counts, latency — the audit screen's
// source of truth. No AI call ever skips this table.
export const aiCalls = sqliteTable(
  "ai_calls",
  {
    id: integer("id").primaryKey(),
    // 'nl_search' | 'auto_tag' | 'openers' | 'summarize'
    feature: text("feature").notNull(),
    model: text("model").notNull(),
    prompt: text("prompt").notNull(),
    response: text("response"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    latencyMs: integer("latency_ms"),
    // 'success' | 'error'
    status: text("status").notNull(),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("idx_ai_calls_feature").on(t.feature, t.createdAt)]
);

// AI suggestion queue (SCHEMA.md `ai_suggestions`, SPEC §11): output always
// lands here for review — "AI never writes user data directly" is enforced
// by making this the only path.
export const aiSuggestions = sqliteTable(
  "ai_suggestions",
  {
    id: integer("id").primaryKey(),
    // 'tag' for now; generic for future suggestion kinds.
    kind: text("kind").notNull(),
    contactId: integer("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    // {tagName, isNewTag, confidence, rationale}
    payloadJson: text("payload_json").notNull(),
    aiCallId: integer("ai_call_id").references(() => aiCalls.id, {
      onDelete: "set null",
    }),
    // 'pending' | 'approved' | 'rejected'
    status: text("status").notNull(),
    createdAt: integer("created_at").notNull(),
    resolvedAt: integer("resolved_at"),
  },
  (t) => [index("idx_ai_suggestions_status").on(t.status, t.createdAt)]
);

export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
export type ContactEmail = typeof contactEmails.$inferSelect;
export type ContactPhone = typeof contactPhones.$inferSelect;
export type ContactSocial = typeof contactSocials.$inferSelect;
export type Tag = typeof tags.$inferSelect;
