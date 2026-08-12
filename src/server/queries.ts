import "server-only";

import { asc, desc, eq, isNotNull, isNull } from "drizzle-orm";

import { db } from "@/db/client";
import {
  contactEmails,
  contactPhones,
  contacts,
  contactSocials,
  contactTags,
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
