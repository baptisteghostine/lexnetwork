import { inArray, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { contacts, noteMentions, notes } from "@/db/schema";
import {
  ftsQueryForContacts,
  ftsQueryForNotes,
  matchesEveryWord,
  nameScore,
  normalizeForSearch,
  queryWords,
} from "@/lib/search/rank";

// Search flow (SCHEMA.md): FTS candidates → Jaro-Winkler + nickname
// re-rank on names → grouped results. Emails via the normalized-column
// prefix index, not FTS.

export type ContactHit = {
  id: number;
  name: string;
  detail: string;
  hasPhoto: boolean;
  starred: boolean;
};

export type NoteHit = {
  noteId: number;
  contactId: number;
  contactName: string;
  snippet: string;
};

export type SearchResults = { contacts: ContactHit[]; notes: NoteHit[] };

function contactCandidateIds(query: string, includeArchived: boolean): Set<number> {
  const ids = new Set<number>();
  // Archived contacts are excluded inside each candidate query, before its
  // LIMIT — filtering after the cap would let archived rows crowd live ones
  // out of the candidate set on a heavily-archived database. The "include
  // archived" toggle (SPEC §1) widens the pool to everything.
  const pool = includeArchived
    ? sql`(SELECT id FROM contacts)`
    : sql`(SELECT id FROM contacts WHERE archived_at IS NULL)`;
  const match = ftsQueryForContacts(query);
  if (match !== null) {
    try {
      const rows = db.all<{ id: number }>(
        sql`SELECT rowid AS id FROM contacts_fts
            WHERE contacts_fts MATCH ${match}
              AND rowid IN ${pool}
            LIMIT 80`
      );
      for (const r of rows) ids.add(r.id);
    } catch {
      // A malformed MATCH must never 500 the search (SPEC §7 edge case);
      // the LIKE fallbacks below still run.
    }
  }
  // Short queries (trigram can't) and prefix name hits.
  const q = normalizeForSearch(query);
  if (q.length > 0) {
    const pattern = `${q.replaceAll(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const nameRows = db.all<{ id: number }>(
      sql`SELECT id FROM contacts
          WHERE display_name LIKE ${pattern} ESCAPE '\\'
            AND id IN ${pool}
          LIMIT 20`
    );
    for (const r of nameRows) ids.add(r.id);
    const emailRows = db.all<{ contact_id: number }>(
      sql`SELECT contact_id FROM contact_emails
          WHERE email_normalized LIKE ${pattern} ESCAPE '\\'
            AND contact_id IN ${pool}
          LIMIT 20`
    );
    for (const r of emailRows) ids.add(r.contact_id);
  }
  return ids;
}

export function searchContacts(
  query: string,
  limit = 10,
  includeArchived = false
): ContactHit[] {
  const ids = [...contactCandidateIds(query, includeArchived)];
  if (ids.length === 0) return [];
  const rows = db
    .select({
      id: contacts.id,
      displayName: contacts.displayName,
      company: contacts.company,
      title: contacts.title,
      photoPath: contacts.photoPath,
      starred: contacts.starred,
    })
    .from(contacts)
    .where(inArray(contacts.id, ids))
    .all();

  const q = normalizeForSearch(query);
  const scored = rows.map((c) => {
    let score = nameScore(query, c.displayName);
    // Company/title/bio-only FTS hits still deserve a slot, below name hits.
    const hay = normalizeForSearch(
      `${c.company ?? ""} ${c.title ?? ""}`
    );
    if (hay.includes(q)) score = Math.max(score, 0.6);
    else score = Math.max(score, 0.45); // candidate via FTS on other fields
    if (c.starred) score += 0.03;
    return { c, score };
  });
  scored.sort(
    (a, b) => b.score - a.score || a.c.displayName.localeCompare(b.c.displayName)
  );
  return scored.slice(0, limit).map(({ c }) => ({
    id: c.id,
    name: c.displayName,
    detail: [c.title, c.company].filter(Boolean).join(" · "),
    hasPhoto: c.photoPath !== null,
    starred: c.starred,
  }));
}

/** How close a spelling has to be to count as "probably meant this name". */
const NEAR_NAME_SCORE = 0.84;

export type PreciseSearch = {
  /** Every match, best first. */
  ids: number[];
  /** True when nothing matched exactly and these are near spellings of a name. */
  approximate: boolean;
};

/**
 * Search for the agent connector (SPEC §14). The palette search above is
 * built for a person typing: it forgives typos, probes on three letters,
 * and shows ten. An agent asking "who is in investment banking" needs the
 * opposite — every match, and nothing that merely shares a trigram — so
 * here every word of the query must begin a word in the contact's name,
 * company, title, location or bio (in any of them, any order), and the
 * result is the complete list. A query with an "@" also matches email
 * addresses containing it.
 *
 * Order: people whose *name* matches first, then starred, then most
 * recently in touch — warm before cold. When nothing matches exactly the
 * palette search stands in for names only, flagged `approximate`, so a
 * misspelled name still finds its person.
 */
export function findContactsPrecisely(
  query: string,
  opts: { includeArchived?: boolean; nameOnly?: boolean } = {}
): PreciseSearch {
  const words = queryWords(query);
  if (words.length === 0) return { ids: [], approximate: false };
  const archivedCond = opts.includeArchived ? sql`1 = 1` : sql`c.archived_at IS NULL`;
  type Row = {
    id: number;
    display_name: string;
    company: string | null;
    title: string | null;
    location: string | null;
    bio: string | null;
    starred: number;
    last_interaction_at: number | null;
  };
  const columns = sql`c.id, c.display_name, c.company, c.title, c.location, c.bio, c.starred, c.last_interaction_at`;

  // The trigram index narrows the candidates for words of three letters or
  // more (a substring test, case- and accent-insensitive); the word-start
  // test below is what decides. Shorter words, or a query the index
  // refuses, scan the table — a few thousand short rows.
  const indexed = words.filter((w) => w.length >= 3);
  let candidates: Row[] | null = null;
  if (indexed.length > 0) {
    const match = indexed.map((w) => `"${w.replaceAll('"', '""')}"`).join(" AND ");
    try {
      candidates = db.all<Row>(
        sql`SELECT ${columns} FROM contacts c
            WHERE ${archivedCond}
              AND c.id IN (SELECT rowid FROM contacts_fts WHERE contacts_fts MATCH ${match})`
      );
    } catch {
      candidates = null;
    }
  }
  if (candidates === null) {
    candidates = db.all<Row>(sql`SELECT ${columns} FROM contacts c WHERE ${archivedCond}`);
  }

  const tier = new Map<number, 0 | 1>();
  const byId = new Map<number, Row>();
  for (const row of candidates) {
    const inName = matchesEveryWord(row.display_name, words);
    if (inName) {
      tier.set(row.id, 0);
    } else if (
      !opts.nameOnly &&
      matchesEveryWord(
        [row.display_name, row.company, row.title, row.location, row.bio].filter(Boolean).join(" | "),
        words
      )
    ) {
      tier.set(row.id, 1);
    } else {
      continue;
    }
    byId.set(row.id, row);
  }

  const compact = normalizeForSearch(query);
  if (!opts.nameOnly && compact.includes("@") && !/\s/.test(compact) && compact.length >= 3) {
    const pattern = `%${compact.replaceAll(/[%_\\]/g, (ch) => `\\${ch}`)}%`;
    const rows = db.all<Row>(
      sql`SELECT ${columns} FROM contacts c
          WHERE ${archivedCond}
            AND c.id IN (SELECT contact_id FROM contact_emails
                         WHERE email_normalized LIKE ${pattern} ESCAPE '\\'
                            OR LOWER(email) LIKE ${pattern} ESCAPE '\\')`
    );
    for (const row of rows) {
      tier.set(row.id, 0);
      byId.set(row.id, row);
    }
  }

  if (byId.size > 0) {
    const ids = [...byId.values()]
      .sort(
        (a, b) =>
          (tier.get(a.id) ?? 1) - (tier.get(b.id) ?? 1) ||
          b.starred - a.starred ||
          (b.last_interaction_at ?? -1) - (a.last_interaction_at ?? -1) ||
          (a.display_name < b.display_name ? -1 : a.display_name > b.display_name ? 1 : 0) ||
          a.id - b.id
      )
      .map((r) => r.id);
    return { ids, approximate: false };
  }

  const near = searchContacts(query, 20, opts.includeArchived ?? false)
    .filter((hit) => nameScore(query, hit.name) >= NEAR_NAME_SCORE)
    .map((hit) => hit.id);
  return { ids: near, approximate: near.length > 0 };
}

export function searchNotes(
  query: string,
  limit = 8,
  includeArchived = false
): NoteHit[] {
  const match = ftsQueryForNotes(query);
  if (match === null) return [];
  let hits: { id: number; snippet: string }[] = [];
  try {
    hits = db.all<{ id: number; snippet: string }>(
      sql`SELECT rowid AS id, snippet(notes_fts, 0, '', '', '…', 12) AS snippet
          FROM notes_fts WHERE notes_fts MATCH ${match}
          ORDER BY bm25(notes_fts) LIMIT ${limit * 3}`
    );
  } catch {
    return [];
  }
  if (hits.length === 0) return [];
  const noteRows = db
    .select({ id: notes.id, contactId: notes.contactId })
    .from(notes)
    .where(
      inArray(
        notes.id,
        hits.map((h) => h.id)
      )
    )
    .all();
  const mentionRows = db
    .select({ noteId: noteMentions.noteId, contactId: noteMentions.contactId })
    .from(noteMentions)
    .where(
      inArray(
        noteMentions.noteId,
        noteRows.filter((n) => n.contactId === null).map((n) => n.id)
      )
    )
    .all();
  const mentionByNote = new Map<number, number>();
  for (const m of mentionRows) {
    if (m.contactId !== null && !mentionByNote.has(m.noteId)) {
      mentionByNote.set(m.noteId, m.contactId);
    }
  }
  // A note-body hit opens the right contact (SPEC §7 AC): the note's own
  // contact, else its first mentioned contact.
  const contactByNote = new Map<number, number>();
  for (const n of noteRows) {
    const cid = n.contactId ?? mentionByNote.get(n.id);
    if (cid !== undefined && cid !== null) contactByNote.set(n.id, cid);
  }
  const contactIds = [...new Set(contactByNote.values())];
  const contactRows = contactIds.length
    ? db
        .select({
          id: contacts.id,
          displayName: contacts.displayName,
          archivedAt: contacts.archivedAt,
        })
        .from(contacts)
        .where(inArray(contacts.id, contactIds))
        .all()
    : [];
  // Archiving hides the contact from search (SPEC §1) — their notes too,
  // unless the archived toggle is on.
  const visible = new Set(
    contactRows
      .filter((c) => includeArchived || c.archivedAt === null)
      .map((c) => c.id)
  );
  const names = new Map(
    contactRows.map((c) => [c.id, c.displayName] as const)
  );
  const out: NoteHit[] = [];
  for (const h of hits) {
    const contactId = contactByNote.get(h.id);
    if (contactId === undefined || !visible.has(contactId)) continue;
    out.push({
      noteId: h.id,
      contactId,
      contactName: names.get(contactId) ?? "Unknown",
      snippet: h.snippet,
    });
    if (out.length >= limit) break;
  }
  return out;
}

export function searchAll(
  query: string,
  opts?: { includeArchived?: boolean }
): SearchResults {
  const q = query.trim();
  if (!q) return { contacts: [], notes: [] };
  const includeArchived = opts?.includeArchived ?? false;
  return {
    contacts: searchContacts(q, 10, includeArchived),
    notes: searchNotes(q, 8, includeArchived),
  };
}
