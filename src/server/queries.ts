import "server-only";

import { and, asc, desc, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";

import { db, rawDb } from "@/db/client";
import {
  attachments,
  contactChanges,
  contactEmails,
  contactFieldSources,
  contactPhones,
  contacts,
  contactSocials,
  contactTags,
  customFields,
  education,
  groupMembers,
  groups,
  interactions,
  noteMentions,
  notes,
  tags,
  workHistory,
} from "@/db/schema";
import { compileFilter, haversineKm } from "@/lib/filters/compile";
import type { FilterSet, SortSpec } from "@/lib/filters/types";

// ---------- filter executor ----------

export type FilteredContact = typeof contacts.$inferSelect;

export type FilterRunResult = {
  contacts: FilteredContact[];
  /** Total matches before `limit` — callers show "N of total". */
  total: number;
  warnings: string[];
};

/** The compiled SQL is `SELECT c.* …`, so raw rows are snake_case. */
type RawFilterRow = {
  id: number;
  location_lat: number | null;
  location_lng: number | null;
};

/**
 * Compile + run a filter set and return the matching ids in order — every
 * one of them, without loading the rows. What the pager and the agent
 * connector's search build on (a total, then a page).
 * No session check: callers are the `runFilter` action (which gates on
 * the cookie) and the agent connector (which gates on its token).
 */
export function filterContactIds(
  filter: FilterSet,
  opts: { now: number; sort?: SortSpec; includeArchived?: boolean }
): { ids: number[]; warnings: string[] } {
  const catalog = {
    tagIds: new Set(db.select({ id: tags.id }).from(tags).all().map((t) => t.id)),
    groupIds: new Set(
      db.select({ id: groups.id }).from(groups).all().map((g) => g.id)
    ),
    customFieldIds: new Set(
      db.select({ id: customFields.id }).from(customFields).all().map((f) => f.id)
    ),
    geocoderConfigured: false,
  };
  const compiled = compileFilter(filter, {
    now: opts.now,
    sort: opts.sort,
    catalog,
    includeArchived: opts.includeArchived,
  });
  let rows = rawDb
    .prepare(compiled.sql)
    .all(...(compiled.params as unknown[])) as unknown as RawFilterRow[];
  if (compiled.radius) {
    const { lat, lng, km } = compiled.radius;
    rows = rows.filter(
      (c) =>
        c.location_lat !== null &&
        c.location_lng !== null &&
        haversineKm(lat, lng, c.location_lat, c.location_lng) <= km
    );
  }
  return { ids: rows.map((r) => r.id), warnings: compiled.warnings };
}

/** Compile + run a filter set and load the page asked for (geocoder: not yet). */
export function executeFilter(
  filter: FilterSet,
  opts: { now: number; sort?: SortSpec; limit?: number; offset?: number }
): FilterRunResult {
  const all = filterContactIds(filter, opts);
  const total = all.ids.length;
  // Hydrate only the rows the caller will render: cap before the drizzle
  // re-select (raw rows are snake_case; the re-select yields camelCase)
  // so a 5k-row import can't balloon the page render. `offset` is the
  // contacts page's pager — the full ordered id list is already in memory,
  // so paging is a slice, not a second query.
  const offset = opts.offset ?? 0;
  const ids =
    opts.limit !== undefined ? all.ids.slice(offset, offset + opts.limit) : all.ids;
  if (ids.length === 0) return { contacts: [], total, warnings: all.warnings };
  const byId = new Map(
    db
      .select()
      .from(contacts)
      .where(inArray(contacts.id, ids))
      .all()
      .map((c) => [c.id, c] as const)
  );
  return {
    contacts: ids
      .map((id) => byId.get(id))
      .filter((c): c is FilteredContact => c !== undefined),
    total,
    warnings: all.warnings,
  };
}

export type ContactSort = "name" | "company" | "recent";

export function listContacts(opts: { sort: ContactSort; archived: boolean }) {
  const order =
    opts.sort === "company"
      ? [asc(contacts.company), asc(contacts.displayName)]
      : opts.sort === "recent"
        ? [desc(contacts.createdAt)]
        : [asc(contacts.displayName)];

  const rows = db
    .select()
    .from(contacts)
    .where(
      opts.archived ? isNotNull(contacts.archivedAt) : isNull(contacts.archivedAt)
    )
    .orderBy(desc(contacts.starred), ...order)
    .all();

  const tagRows = db
    .select({
      contactId: contactTags.contactId,
      id: tags.id,
      name: tags.name,
      color: tags.color,
    })
    .from(contactTags)
    .innerJoin(tags, eq(tags.id, contactTags.tagId))
    .all();
  const tagsByContact = new Map<
    number,
    { id: number; name: string; color: string }[]
  >();
  for (const t of tagRows) {
    const list = tagsByContact.get(t.contactId) ?? [];
    list.push({ id: t.id, name: t.name, color: t.color });
    tagsByContact.set(t.contactId, list);
  }
  return rows.map((c) => ({ ...c, tags: tagsByContact.get(c.id) ?? [] }));
}

export function getContactDetail(contactId: number) {
  const contact = db
    .select()
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .get();
  if (!contact) return null;
  return {
    contact,
    emails: db
      .select()
      .from(contactEmails)
      .where(eq(contactEmails.contactId, contactId))
      .orderBy(asc(contactEmails.priority))
      .all(),
    phones: db
      .select()
      .from(contactPhones)
      .where(eq(contactPhones.contactId, contactId))
      .orderBy(asc(contactPhones.priority))
      .all(),
    socials: db
      .select()
      .from(contactSocials)
      .where(eq(contactSocials.contactId, contactId))
      .all(),
    tagIds: db
      .select({ tagId: contactTags.tagId })
      .from(contactTags)
      .where(eq(contactTags.contactId, contactId))
      .all()
      .map((r) => r.tagId),
    workHistory: db
      .select()
      .from(workHistory)
      .where(eq(workHistory.contactId, contactId))
      .orderBy(desc(workHistory.isCurrent), desc(workHistory.startDate))
      .all(),
    education: db
      .select()
      .from(education)
      .where(eq(education.contactId, contactId))
      .orderBy(desc(education.endYear))
      .all(),
    // field → where its current value came from (SPEC §1 hover provenance).
    provenance: Object.fromEntries(
      db
        .select({
          field: contactFieldSources.field,
          source: contactFieldSources.source,
          updatedAt: contactFieldSources.updatedAt,
        })
        .from(contactFieldSources)
        .where(eq(contactFieldSources.contactId, contactId))
        .all()
        .map((r) => [r.field, { source: r.source, updatedAt: r.updatedAt }])
    ) as Record<string, { source: string; updatedAt: number }>,
  };
}

export function listTags() {
  return db.select().from(tags).orderBy(asc(tags.name)).all();
}

export function listGroups() {
  return db
    .select()
    .from(groups)
    .orderBy(asc(groups.sortOrder), asc(groups.name))
    .all();
}

export function getContactGroupIds(contactId: number): number[] {
  return db
    .select({ groupId: groupMembers.groupId })
    .from(groupMembers)
    .where(eq(groupMembers.contactId, contactId))
    .all()
    .map((r) => r.groupId);
}

export type TimelineNote = {
  type: "note";
  at: number;
  note: typeof notes.$inferSelect;
  attachments: (typeof attachments.$inferSelect)[];
  mentionedOnly: boolean;
};
export type TimelineInteraction = {
  type: "interaction";
  at: number;
  interaction: typeof interactions.$inferSelect;
};
export type TimelineChange = {
  type: "change";
  at: number;
  change: typeof contactChanges.$inferSelect;
};
export type TimelineItem = TimelineNote | TimelineInteraction | TimelineChange;

export function getContactTimeline(contactId: number): TimelineItem[] {
  const ownNotes = db
    .select()
    .from(notes)
    .where(eq(notes.contactId, contactId))
    .all();
  const mentionedNoteIds = db
    .select({ noteId: noteMentions.noteId })
    .from(noteMentions)
    .where(eq(noteMentions.contactId, contactId))
    .all()
    .map((r) => r.noteId);
  const mentionedNotes = mentionedNoteIds.length
    ? db
        .select()
        .from(notes)
        .where(
          and(
            inArray(notes.id, mentionedNoteIds),
            // A note both owned by and mentioning the contact appears once.
            isNull(notes.contactId)
          )
        )
        .all()
        .concat(
          db
            .select()
            .from(notes)
            .where(
              and(
                inArray(notes.id, mentionedNoteIds),
                isNotNull(notes.contactId),
                ne(notes.contactId, contactId)
              )
            )
            .all()
        )
    : [];

  const allNoteIds = [...ownNotes, ...mentionedNotes].map((n) => n.id);
  const files = allNoteIds.length
    ? db
        .select()
        .from(attachments)
        .where(inArray(attachments.noteId, allNoteIds))
        .all()
    : [];
  const filesByNote = new Map<number, (typeof attachments.$inferSelect)[]>();
  for (const f of files) {
    const list = filesByNote.get(f.noteId) ?? [];
    list.push(f);
    filesByNote.set(f.noteId, list);
  }

  const rows = db
    .select()
    .from(interactions)
    .where(eq(interactions.contactId, contactId))
    .all();

  const items: TimelineItem[] = [
    ...ownNotes.map(
      (n): TimelineNote => ({
        type: "note",
        at: n.createdAt,
        note: n,
        attachments: filesByNote.get(n.id) ?? [],
        mentionedOnly: false,
      })
    ),
    ...mentionedNotes.map(
      (n): TimelineNote => ({
        type: "note",
        at: n.createdAt,
        note: n,
        attachments: filesByNote.get(n.id) ?? [],
        mentionedOnly: true,
      })
    ),
    ...rows.map(
      (i): TimelineInteraction => ({
        type: "interaction",
        at: i.occurredAt,
        interaction: i,
      })
    ),
    // Field changes belong on the timeline (SPEC §2) — dismissed or not.
    ...db
      .select()
      .from(contactChanges)
      .where(eq(contactChanges.contactId, contactId))
      .all()
      .map(
        (c): TimelineChange => ({ type: "change", at: c.detectedAt, change: c })
      ),
  ];
  items.sort((a, b) => b.at - a.at);
  return items;
}
