import "server-only";

import { and, asc, desc, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";

import { db } from "@/db/client";
import {
  attachments,
  contactEmails,
  contactPhones,
  contacts,
  contactSocials,
  contactTags,
  groupMembers,
  groups,
  interactions,
  noteMentions,
  notes,
  tags,
} from "@/db/schema";

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
export type TimelineItem = TimelineNote | TimelineInteraction;

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
  ];
  items.sort((a, b) => b.at - a.at);
  return items;
}
