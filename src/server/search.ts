import { inArray, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { contacts, noteMentions, notes } from "@/db/schema";
import {
  ftsQueryForContacts,
  ftsQueryForNotes,
  nameScore,
  normalizeForSearch,
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

function contactCandidateIds(query: string): Set<number> {
  const ids = new Set<number>();
  const match = ftsQueryForContacts(query);
  if (match !== null) {
    try {
      const rows = db.all<{ id: number }>(
        sql`SELECT rowid AS id FROM contacts_fts WHERE contacts_fts MATCH ${match} LIMIT 80`
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
      sql`SELECT id FROM contacts WHERE display_name LIKE ${pattern} ESCAPE '\\' LIMIT 20`
    );
    for (const r of nameRows) ids.add(r.id);
    const emailRows = db.all<{ contact_id: number }>(
      sql`SELECT contact_id FROM contact_emails WHERE email_normalized LIKE ${pattern} ESCAPE '\\' LIMIT 20`
    );
    for (const r of emailRows) ids.add(r.contact_id);
  }
  return ids;
}

export function searchContacts(query: string, limit = 10): ContactHit[] {
  const ids = [...contactCandidateIds(query)];
  if (ids.length === 0) return [];
  const rows = db
    .select({
      id: contacts.id,
      displayName: contacts.displayName,
      company: contacts.company,
      title: contacts.title,
      photoPath: contacts.photoPath,
      starred: contacts.starred,
      archivedAt: contacts.archivedAt,
    })
    .from(contacts)
    .where(inArray(contacts.id, ids))
    .all()
    .filter((c) => c.archivedAt === null);

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

export function searchNotes(query: string, limit = 8): NoteHit[] {
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
  const names = new Map(
    contactIds.length
      ? db
          .select({ id: contacts.id, displayName: contacts.displayName })
          .from(contacts)
          .where(inArray(contacts.id, contactIds))
          .all()
          .map((c) => [c.id, c.displayName] as const)
      : []
  );
  const out: NoteHit[] = [];
  for (const h of hits) {
    const contactId = contactByNote.get(h.id);
    if (contactId === undefined) continue;
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

export function searchAll(query: string): SearchResults {
  const q = query.trim();
  if (!q) return { contacts: [], notes: [] };
  return { contacts: searchContacts(q), notes: searchNotes(q) };
}
