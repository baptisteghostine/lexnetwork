// Merge engine (SPEC §10): repoint-everything transaction, full-snapshot
// merge log, and undo. Operates on a raw better-sqlite3 handle — the same
// connection the app's Drizzle client wraps — so the whole engine can be
// exercised against an in-memory DB built from the real migrations.
//
// The model is uniform: every loser child row is snapshotted verbatim;
// rows that can move to the winner without violating a uniqueness rule
// are repointed (ids recorded); rows that would conflict stay on the
// loser and die with it via FK cascade. Undo reverses exactly that:
// recorded moves are repointed back, everything else is reinserted from
// the snapshot, and both contact rows are restored byte-identical.

import type { Database } from "better-sqlite3";

import { computeNextTouchAt } from "@/lib/cadence/engine";
import { deriveDisplayName } from "@/lib/contacts/normalize";

type Row = Record<string, unknown>;

export type MergeField =
  | "firstName"
  | "lastName"
  | "title"
  | "company"
  | "location"
  | "bio"
  | "descriptionMd"
  | "birthday"
  | "photoPath"
  | "cadence";

export type MergeDecisions = Record<MergeField, "winner" | "loser">;

/** DB columns each logical merge field owns (groups move together). */
const FIELD_COLUMNS: Record<MergeField, string[]> = {
  firstName: ["first_name"],
  lastName: ["last_name"],
  title: ["title"],
  company: ["company"],
  location: ["location", "location_lat", "location_lng"],
  bio: ["bio"],
  descriptionMd: ["description_md"],
  birthday: ["birthday_month", "birthday_day", "birthday_year"],
  photoPath: ["photo_path"],
  cadence: ["cadence_days", "cadence_assigned_at", "snoozed_until"],
};

const FIELD_EMPTY_PROBE: Record<MergeField, string> = {
  firstName: "first_name",
  lastName: "last_name",
  title: "title",
  company: "company",
  location: "location",
  bio: "bio",
  descriptionMd: "description_md",
  birthday: "birthday_month",
  photoPath: "photo_path",
  cadence: "cadence_days",
};

// contact_field_sources.field keys (= SCALAR_FIELDS in lib/imports/types).
// Fields without a key have no import provenance to adopt.
const FIELD_SOURCE_KEY: Partial<Record<MergeField, string>> = {
  firstName: "first_name",
  lastName: "last_name",
  title: "title",
  company: "company",
  location: "location",
  bio: "bio",
  birthday: "birthday",
};

export const MERGE_FIELDS = Object.keys(FIELD_COLUMNS) as MergeField[];

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === "";
}

/** SPEC §10 defaults: winner's field, unless empty → loser's. */
export function defaultDecisions(winner: Row, loser: Row): MergeDecisions {
  const out = {} as MergeDecisions;
  for (const field of MERGE_FIELDS) {
    const probe = FIELD_EMPTY_PROBE[field];
    out[field] =
      isEmpty(winner[probe]) && !isEmpty(loser[probe]) ? "loser" : "winner";
  }
  return out;
}

// Id-keyed child tables, with the uniqueness rule that decides whether a
// loser row can repoint. `conflictSql` selects loser-row ids that would
// collide with an existing winner row; those stay behind and cascade.
const CHILD_TABLES: { name: string; conflictSql: string | null }[] = [
  {
    name: "contact_emails",
    conflictSql: `SELECT l.id FROM contact_emails l WHERE l.contact_id = @loser AND EXISTS (
      SELECT 1 FROM contact_emails w WHERE w.contact_id = @winner AND w.email_normalized = l.email_normalized)`,
  },
  {
    name: "contact_phones",
    conflictSql: `SELECT l.id FROM contact_phones l WHERE l.contact_id = @loser AND l.phone_e164 IS NOT NULL AND EXISTS (
      SELECT 1 FROM contact_phones w WHERE w.contact_id = @winner AND w.phone_e164 = l.phone_e164)`,
  },
  {
    name: "contact_socials",
    conflictSql: `SELECT l.id FROM contact_socials l WHERE l.contact_id = @loser AND EXISTS (
      SELECT 1 FROM contact_socials w WHERE w.contact_id = @winner AND w.url = l.url)`,
  },
  {
    name: "interactions",
    conflictSql: `SELECT l.id FROM interactions l WHERE l.contact_id = @loser AND l.source_key IS NOT NULL AND EXISTS (
      SELECT 1 FROM interactions w WHERE w.contact_id = @winner AND w.source = l.source AND w.source_key = l.source_key)`,
  },
  {
    name: "notes",
    conflictSql: null,
  },
  {
    name: "note_mentions",
    conflictSql: `SELECT l.id FROM note_mentions l WHERE l.contact_id = @loser AND EXISTS (
      SELECT 1 FROM note_mentions w WHERE w.note_id = l.note_id AND w.contact_id = @winner)`,
  },
  { name: "contact_changes", conflictSql: null },
  { name: "work_history", conflictSql: null },
  { name: "education", conflictSql: null },
  { name: "reminders", conflictSql: null },
  {
    name: "custom_field_values",
    conflictSql: `SELECT l.id FROM custom_field_values l WHERE l.contact_id = @loser AND EXISTS (
      SELECT 1 FROM custom_field_values w WHERE w.contact_id = @winner AND w.custom_field_id = l.custom_field_id)`,
  },
];

type Repointed = {
  moved: Record<string, number[]>;
  movedTagIds: number[];
  movedGroupIds: number[];
  movedFieldSourceFields: string[];
  replacedFieldSources: Row[];
  movedRelationshipIds: number[];
};

type Snapshot = {
  loser: Row;
  children: Record<string, Row[]>;
};

type DecisionsPayload = {
  decisions: MergeDecisions;
  winnerBefore: Row;
  winnerAfter: Row;
};

function selectAll(db: Database, sql: string, params: Row): Row[] {
  return db.prepare(sql).all(params) as Row[];
}

function contactRow(db: Database, id: number): Row | undefined {
  return db.prepare("SELECT * FROM contacts WHERE id = ?").get(id) as
    | Row
    | undefined;
}

function snapshotLoser(db: Database, loserId: number): Snapshot {
  const loser = contactRow(db, loserId);
  if (!loser) throw new Error(`Contact ${loserId} not found.`);
  const children: Record<string, Row[]> = {};
  for (const t of CHILD_TABLES) {
    children[t.name] = selectAll(
      db,
      `SELECT * FROM ${t.name} WHERE contact_id = @loser`,
      { loser: loserId }
    );
  }
  children.contact_tags = selectAll(
    db,
    "SELECT * FROM contact_tags WHERE contact_id = @loser",
    { loser: loserId }
  );
  children.group_members = selectAll(
    db,
    "SELECT * FROM group_members WHERE contact_id = @loser",
    { loser: loserId }
  );
  children.contact_field_sources = selectAll(
    db,
    "SELECT * FROM contact_field_sources WHERE contact_id = @loser",
    { loser: loserId }
  );
  children.contact_relationships = selectAll(
    db,
    "SELECT * FROM contact_relationships WHERE contact_a_id = @loser OR contact_b_id = @loser",
    { loser: loserId }
  );
  children.duplicate_candidates = selectAll(
    db,
    "SELECT * FROM duplicate_candidates WHERE contact_a_id = @loser OR contact_b_id = @loser",
    { loser: loserId }
  );
  return { loser, children };
}

function repointChildren(
  db: Database,
  winnerId: number,
  loserId: number
): Repointed {
  const params = { winner: winnerId, loser: loserId };
  const repointed: Repointed = {
    moved: {},
    movedTagIds: [],
    movedGroupIds: [],
    movedFieldSourceFields: [],
    replacedFieldSources: [],
    movedRelationshipIds: [],
  };

  for (const t of CHILD_TABLES) {
    const conflicting = new Set(
      t.conflictSql
        ? selectAll(db, t.conflictSql, params).map((r) => r.id as number)
        : []
    );
    const movable = selectAll(
      db,
      `SELECT id FROM ${t.name} WHERE contact_id = @loser`,
      params
    )
      .map((r) => r.id as number)
      .filter((id) => !conflicting.has(id));
    if (movable.length > 0) {
      const placeholders = movable.map(() => "?").join(",");
      db.prepare(
        `UPDATE ${t.name} SET contact_id = ? WHERE id IN (${placeholders})`
      ).run(winnerId, ...movable);
    }
    repointed.moved[t.name] = movable;
  }

  // contact_tags / group_members: composite PKs — move by key.
  for (const row of selectAll(
    db,
    `SELECT tag_id FROM contact_tags WHERE contact_id = @loser AND tag_id NOT IN (
       SELECT tag_id FROM contact_tags WHERE contact_id = @winner)`,
    params
  )) {
    db.prepare(
      "UPDATE contact_tags SET contact_id = @winner WHERE contact_id = @loser AND tag_id = @tag"
    ).run({ ...params, tag: row.tag_id });
    repointed.movedTagIds.push(row.tag_id as number);
  }
  for (const row of selectAll(
    db,
    `SELECT group_id FROM group_members WHERE contact_id = @loser AND group_id NOT IN (
       SELECT group_id FROM group_members WHERE contact_id = @winner)`,
    params
  )) {
    db.prepare(
      "UPDATE group_members SET contact_id = @winner WHERE contact_id = @loser AND group_id = @grp"
    ).run({ ...params, grp: row.group_id });
    repointed.movedGroupIds.push(row.group_id as number);
  }

  // Field provenance: move loser rows only for fields the winner has no
  // provenance for — decision-adopted fields are handled by the caller,
  // which knows the field decisions.
  for (const row of selectAll(
    db,
    `SELECT field FROM contact_field_sources WHERE contact_id = @loser AND field NOT IN (
       SELECT field FROM contact_field_sources WHERE contact_id = @winner)`,
    params
  )) {
    db.prepare(
      "UPDATE contact_field_sources SET contact_id = @winner WHERE contact_id = @loser AND field = @field"
    ).run({ ...params, field: row.field });
    repointed.movedFieldSourceFields.push(row.field as string);
  }

  // Relationships: substitute the winner for the loser, drop self-edges
  // and duplicates (they stay on the loser and cascade away). Undirected
  // edges re-canonicalize a<b; directed edges keep their semantic order
  // (the stored order IS the direction — see SCHEMA.md).
  for (const rel of selectAll(
    db,
    "SELECT * FROM contact_relationships WHERE contact_a_id = @loser OR contact_b_id = @loser",
    params
  )) {
    let a = rel.contact_a_id === loserId ? winnerId : (rel.contact_a_id as number);
    let b = rel.contact_b_id === loserId ? winnerId : (rel.contact_b_id as number);
    if (a === b) continue; // self-edge after merge — cascade.
    if (rel.directed !== 1 && a > b) [a, b] = [b, a];
    const exists = db
      .prepare(
        "SELECT 1 FROM contact_relationships WHERE contact_a_id = ? AND contact_b_id = ? AND label = ? AND id != ?"
      )
      .get(a, b, rel.label, rel.id);
    if (exists) continue; // duplicate edge — cascade.
    db.prepare(
      "UPDATE contact_relationships SET contact_a_id = ?, contact_b_id = ? WHERE id = ?"
    ).run(a, b, rel.id);
    repointed.movedRelationshipIds.push(rel.id as number);
  }

  return repointed;
}

/** Adopt the loser's provenance for fields whose decision picked the loser. */
function adoptFieldSources(
  db: Database,
  winnerId: number,
  loserId: number,
  decisions: MergeDecisions,
  repointed: Repointed
): void {
  for (const field of MERGE_FIELDS) {
    if (decisions[field] !== "loser") continue;
    const sourceField = FIELD_SOURCE_KEY[field];
    if (!sourceField) continue;
    const loserRow = db
      .prepare(
        "SELECT * FROM contact_field_sources WHERE contact_id = ? AND field = ?"
      )
      .get(loserId, sourceField) as Row | undefined;
    if (!loserRow) continue;
    const winnerRow = db
      .prepare(
        "SELECT * FROM contact_field_sources WHERE contact_id = ? AND field = ?"
      )
      .get(winnerId, sourceField) as Row | undefined;
    if (winnerRow) {
      repointed.replacedFieldSources.push(winnerRow);
      db.prepare(
        "DELETE FROM contact_field_sources WHERE contact_id = ? AND field = ?"
      ).run(winnerId, sourceField);
    }
    db.prepare(
      "UPDATE contact_field_sources SET contact_id = ? WHERE contact_id = ? AND field = ?"
    ).run(winnerId, loserId, sourceField);
    repointed.movedFieldSourceFields.push(sourceField);
  }
}

/** Recompute the winner's derived columns after rows moved (raw mirror of lib/cadence/recompute). */
function recomputeDerived(db: Database, contactId: number, now: number): void {
  const c = contactRow(db, contactId);
  if (!c) return;
  const latest = db
    .prepare(
      `SELECT MAX(at) AS at FROM (
         SELECT MAX(occurred_at) AS at FROM interactions WHERE contact_id = @id AND counts_for_touch = 1
         UNION ALL
         SELECT MAX(created_at) AS at FROM notes WHERE contact_id = @id AND counts_for_touch = 1)`
    )
    .get({ id: contactId }) as { at: number | null };
  const lastInteractionAt = latest.at ?? null;
  const snoozedUntil =
    lastInteractionAt !== null &&
    (c.last_interaction_at === null ||
      lastInteractionAt > (c.last_interaction_at as number))
      ? null
      : (c.snoozed_until as number | null);
  const nextTouchAt = computeNextTouchAt({
    cadenceDays: c.cadence_days as number | null,
    cadenceAssignedAt: c.cadence_assigned_at as number | null,
    lastInteractionAt,
    snoozedUntil,
  });

  const primaryEmail = db
    .prepare(
      "SELECT email FROM contact_emails WHERE contact_id = ? ORDER BY priority, id LIMIT 1"
    )
    .get(contactId) as { email: string } | undefined;
  const primaryPhone = db
    .prepare(
      "SELECT phone_raw FROM contact_phones WHERE contact_id = ? ORDER BY priority, id LIMIT 1"
    )
    .get(contactId) as { phone_raw: string } | undefined;
  const fresh = contactRow(db, contactId)!;
  const displayName = deriveDisplayName({
    firstName: fresh.first_name as string | null,
    lastName: fresh.last_name as string | null,
    primaryEmail: primaryEmail?.email ?? null,
    primaryPhone: primaryPhone?.phone_raw ?? null,
  });

  db.prepare(
    `UPDATE contacts SET display_name = @displayName, last_interaction_at = @lastInteractionAt,
       snoozed_until = @snoozedUntil, next_touch_at = @nextTouchAt, updated_at = @now WHERE id = @id`
  ).run({
    id: contactId,
    displayName,
    lastInteractionAt,
    snoozedUntil,
    nextTouchAt,
    now,
  });
}

export type MergeResult = { logId: number };

export function mergeContacts(
  db: Database,
  opts: {
    winnerId: number;
    loserId: number;
    decisions?: Partial<MergeDecisions>;
    now?: number;
  }
): MergeResult {
  const { winnerId, loserId } = opts;
  if (winnerId === loserId) throw new Error("Cannot merge a contact into itself.");
  const now = opts.now ?? Date.now();

  const run = db.transaction((): MergeResult => {
    const winnerBefore = contactRow(db, winnerId);
    if (!winnerBefore) throw new Error(`Contact ${winnerId} not found.`);
    const snapshot = snapshotLoser(db, loserId);
    const decisions: MergeDecisions = {
      ...defaultDecisions(winnerBefore, snapshot.loser),
      ...opts.decisions,
    };

    // Apply field decisions to the winner.
    const sets: string[] = [];
    const setParams: Row = { id: winnerId };
    for (const field of MERGE_FIELDS) {
      if (decisions[field] !== "loser") continue;
      for (const col of FIELD_COLUMNS[field]) {
        sets.push(`${col} = @${col}`);
        setParams[col] = snapshot.loser[col] ?? null;
      }
    }
    // Star survives from either side; it's a flag, not a contested field.
    if (snapshot.loser.starred === 1 && winnerBefore.starred !== 1) {
      sets.push("starred = 1");
    }
    if (sets.length > 0) {
      db.prepare(
        `UPDATE contacts SET ${sets.join(", ")} WHERE id = @id`
      ).run(setParams);
    }

    const repointed = repointChildren(db, winnerId, loserId);
    adoptFieldSources(db, winnerId, loserId, decisions, repointed);

    // Dismissal memory survives the merge (SPEC §10: dismissed pairs are
    // "never re-suggested"): a pair the owner rejected as (loser, C) is the
    // same two humans as (winner, C) once the loser's identity folds into
    // the winner — transfer the dismissal before the cascade destroys it.
    const dismissed = selectAll(
      db,
      `SELECT * FROM duplicate_candidates
       WHERE status = 'dismissed' AND (contact_a_id = @loser OR contact_b_id = @loser)`,
      { loser: loserId }
    );
    for (const row of dismissed) {
      const other =
        (row.contact_a_id as number) === loserId
          ? (row.contact_b_id as number)
          : (row.contact_a_id as number);
      if (other === winnerId) continue;
      const [a, b] = winnerId < other ? [winnerId, other] : [other, winnerId];
      const existing = db
        .prepare(
          "SELECT id, status FROM duplicate_candidates WHERE contact_a_id = ? AND contact_b_id = ?"
        )
        .get(a, b) as { id: number; status: string } | undefined;
      if (!existing) {
        db.prepare(
          `INSERT INTO duplicate_candidates (contact_a_id, contact_b_id, score, reasons_json, status, created_at, resolved_at)
           VALUES (?, ?, ?, ?, 'dismissed', ?, ?)`
        ).run(a, b, row.score, row.reasons_json, now, now);
      } else if (existing.status === "open") {
        db.prepare(
          "UPDATE duplicate_candidates SET status = 'dismissed', resolved_at = ? WHERE id = ?"
        ).run(now, existing.id);
      }
    }

    // The loser goes away; conflicting child rows cascade with it. All of
    // them are in the snapshot for undo.
    db.prepare("DELETE FROM contacts WHERE id = ?").run(loserId);

    recomputeDerived(db, winnerId, now);
    const winnerAfter = contactRow(db, winnerId)!;

    const payload: DecisionsPayload = { decisions, winnerBefore, winnerAfter };
    const logId = db
      .prepare(
        `INSERT INTO merge_log (winner_contact_id, loser_contact_id, loser_snapshot_json,
           repointed_json, field_decisions_json, merged_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        winnerId,
        loserId,
        JSON.stringify(snapshot),
        JSON.stringify(repointed),
        JSON.stringify(payload),
        now
      ).lastInsertRowid as number;
    return { logId: Number(logId) };
  });
  return run();
}

// Columns whose post-merge change should block undo: the owner (or an
// import) rewrote identity data and undo would trample it. Derived and
// activity columns deliberately excluded — new interactions arriving
// after a merge are not a conflicting edit.
const CONFLICT_COLUMNS = [
  "first_name",
  "last_name",
  "title",
  "company",
  "location",
  "location_lat",
  "location_lng",
  "bio",
  "description_md",
  "birthday_month",
  "birthday_day",
  "birthday_year",
  "photo_path",
  "cadence_days",
  "cadence_assigned_at",
] as const;

export type UndoResult = { ok: true } | { ok: false; reason: string };

function insertRow(db: Database, table: string, row: Row): void {
  const cols = Object.keys(row);
  db.prepare(
    `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols
      .map((c) => `@${c}`)
      .join(", ")})`
  ).run(row);
}

/**
 * Reinsert a snapshotted child row whose referents may have been deleted
 * since the merge (a tag removed, a third contact deleted, a sync run
 * pruned). SCHEMA.md: "the undo path must verify referents still exist" —
 * an FK failure means the referent is gone by the owner's own hand, so
 * the orphaned assignment is skipped rather than crashing the whole undo.
 * SQLite rolls back only the failed statement, not the transaction.
 */
function insertRowIfReferentsExist(
  db: Database,
  table: string,
  row: Row
): boolean {
  try {
    insertRow(db, table, row);
    return true;
  } catch (err) {
    if (
      err instanceof Error &&
      (err as { code?: string }).code === "SQLITE_CONSTRAINT_FOREIGNKEY"
    ) {
      return false;
    }
    throw err;
  }
}

export function undoMerge(
  db: Database,
  logId: number,
  now: number = Date.now()
): UndoResult {
  const log = db
    .prepare("SELECT * FROM merge_log WHERE id = ?")
    .get(logId) as Row | undefined;
  if (!log) return { ok: false, reason: "Merge log entry not found." };
  if (log.undone_at !== null) {
    return { ok: false, reason: "This merge was already undone." };
  }

  const winnerId = log.winner_contact_id as number;
  const loserId = log.loser_contact_id as number;
  const snapshot = JSON.parse(log.loser_snapshot_json as string) as Snapshot;
  const repointed = JSON.parse(log.repointed_json as string) as Repointed;
  const payload = JSON.parse(
    log.field_decisions_json as string
  ) as DecisionsPayload;

  const winnerNow = contactRow(db, winnerId);
  if (!winnerNow) {
    return {
      ok: false,
      reason:
        "The merged contact no longer exists (deleted or merged again) — this merge can't be undone.",
    };
  }
  if (contactRow(db, loserId)) {
    return {
      ok: false,
      reason: "A contact already occupies the restored contact's id.",
    };
  }
  const changed = CONFLICT_COLUMNS.filter(
    (col) => winnerNow[col] !== payload.winnerAfter[col]
  );
  if (changed.length > 0) {
    return {
      ok: false,
      reason: `The merged contact was edited since (${changed.join(", ")}) — undoing would overwrite those edits.`,
    };
  }

  const run = db.transaction((): void => {
    // 1. The loser comes back, byte-identical.
    insertRow(db, "contacts", snapshot.loser);

    // 2. Moved id-keyed rows repoint back; cascade-deleted ones reinsert.
    for (const t of CHILD_TABLES) {
      const movedIds = new Set(repointed.moved[t.name] ?? []);
      for (const row of snapshot.children[t.name] ?? []) {
        const id = row.id as number;
        if (movedIds.has(id)) {
          const still = db
            .prepare(`SELECT contact_id FROM ${t.name} WHERE id = ?`)
            .get(id) as Row | undefined;
          if (still && still.contact_id === winnerId) {
            db.prepare(
              `UPDATE ${t.name} SET contact_id = ? WHERE id = ?`
            ).run(loserId, id);
            continue;
          }
        }
        if (
          !db.prepare(`SELECT 1 FROM ${t.name} WHERE id = ?`).get(id)
        ) {
          insertRowIfReferentsExist(db, t.name, row);
        }
      }
    }

    // 3. Composite-key tables.
    for (const row of snapshot.children.contact_tags ?? []) {
      if (repointed.movedTagIds.includes(row.tag_id as number)) {
        db.prepare(
          "DELETE FROM contact_tags WHERE contact_id = ? AND tag_id = ?"
        ).run(winnerId, row.tag_id);
      }
      insertRowIfReferentsExist(db, "contact_tags", row);
    }
    for (const row of snapshot.children.group_members ?? []) {
      if (repointed.movedGroupIds.includes(row.group_id as number)) {
        db.prepare(
          "DELETE FROM group_members WHERE contact_id = ? AND group_id = ?"
        ).run(winnerId, row.group_id);
      }
      insertRowIfReferentsExist(db, "group_members", row);
    }
    for (const row of snapshot.children.contact_field_sources ?? []) {
      if (repointed.movedFieldSourceFields.includes(row.field as string)) {
        db.prepare(
          "DELETE FROM contact_field_sources WHERE contact_id = ? AND field = ?"
        ).run(winnerId, row.field);
      }
      insertRowIfReferentsExist(db, "contact_field_sources", row);
    }
    for (const row of repointed.replacedFieldSources) {
      insertRowIfReferentsExist(db, "contact_field_sources", row);
    }

    // 4. Relationships: moved ones repoint back to their snapshot ends;
    //    cascade-killed ones reinsert.
    for (const row of snapshot.children.contact_relationships ?? []) {
      const id = row.id as number;
      if (repointed.movedRelationshipIds.includes(id)) {
        db.prepare(
          "UPDATE contact_relationships SET contact_a_id = ?, contact_b_id = ? WHERE id = ?"
        ).run(row.contact_a_id, row.contact_b_id, id);
      } else if (
        !db.prepare("SELECT 1 FROM contact_relationships WHERE id = ?").get(id)
      ) {
        insertRowIfReferentsExist(db, "contact_relationships", row);
      }
    }

    // 5. The dedupe queue rows that died with the loser (including the
    //    open winner/loser pair) come back as they were.
    for (const row of snapshot.children.duplicate_candidates ?? []) {
      if (
        !db
          .prepare("SELECT 1 FROM duplicate_candidates WHERE id = ?")
          .get(row.id)
      ) {
        insertRowIfReferentsExist(db, "duplicate_candidates", row);
      }
    }

    // 6. The winner returns to its pre-merge row, then derived columns
    //    recompute against what actually remains attached.
    const cols = Object.keys(payload.winnerBefore).filter((c) => c !== "id");
    db.prepare(
      `UPDATE contacts SET ${cols.map((c) => `${c} = @${c}`).join(", ")} WHERE id = @id`
    ).run(payload.winnerBefore);
    recomputeDerived(db, winnerId, now);
    recomputeDerived(db, loserId, now);

    db.prepare("UPDATE merge_log SET undone_at = ? WHERE id = ?").run(
      now,
      logId
    );
  });
  run();
  return { ok: true };
}
