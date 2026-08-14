"use server";

import fs from "node:fs";
import path from "node:path";

import { eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { DATA_DIR, db } from "@/db/client";
import {
  attachments,
  contactEmails,
  contactFieldSources,
  contactPhones,
  contacts,
  contactSocials,
  contactTags,
  groupMembers,
  notes,
  reminders,
} from "@/db/schema";
import { requireAuth } from "@/lib/auth";
import {
  deriveDisplayName,
  isValidBirthday,
  normalizeEmail,
} from "@/lib/contacts/normalize";
import { toE164 } from "@/lib/imports/phone";
import { getSetting } from "@/lib/settings";

const emailRow = z.object({
  email: z.string().trim().email(),
  label: z.string().trim().max(40).optional().default(""),
});
const phoneRow = z.object({
  phone: z.string().trim().min(1).max(40),
  label: z.string().trim().max(40).optional().default(""),
});
const socialRow = z.object({
  platform: z.enum(["linkedin", "twitter", "github", "website", "other"]),
  url: z.string().trim().url(),
});

const contactPayload = z.object({
  firstName: z.string().trim().max(100).default(""),
  lastName: z.string().trim().max(100).default(""),
  title: z.string().trim().max(200).default(""),
  company: z.string().trim().max(200).default(""),
  location: z.string().trim().max(200).default(""),
  bio: z.string().trim().max(1000).default(""),
  descriptionMd: z.string().max(100_000).default(""),
  birthdayMonth: z.number().int().nullable().default(null),
  birthdayDay: z.number().int().nullable().default(null),
  birthdayYear: z.number().int().min(1900).max(2100).nullable().default(null),
  emails: z.array(emailRow).max(20).default([]),
  phones: z.array(phoneRow).max(20).default([]),
  socials: z.array(socialRow).max(20).default([]),
  tagIds: z.array(z.number().int()).max(100).default([]),
  groupIds: z.array(z.number().int()).max(100).default([]),
});

export type ContactPayload = z.infer<typeof contactPayload>;
export type ContactFormState = { error?: string };

// Scalar fields whose provenance we track (SPEC §1). Multi-value rows carry
// their own source column.
type ScalarFieldName =
  | "first_name"
  | "last_name"
  | "title"
  | "company"
  | "location"
  | "bio"
  | "description_md"
  | "birthday";

function parsePayload(formData: FormData): ContactPayload | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(String(formData.get("payload") ?? "{}"));
  } catch {
    return { error: "Malformed form payload." };
  }
  const parsed = contactPayload.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { error: `${first.path.join(".")}: ${first.message}` };
  }
  const p = parsed.data;
  if (!isValidBirthday(p.birthdayMonth, p.birthdayDay)) {
    return { error: "Birthday needs both a valid month and day." };
  }
  if (
    !p.firstName &&
    !p.lastName &&
    p.emails.length === 0 &&
    p.phones.length === 0
  ) {
    return { error: "A contact needs at least a name, email, or phone." };
  }
  return p;
}

function scalarValues(p: ContactPayload) {
  return {
    firstName: p.firstName || null,
    lastName: p.lastName || null,
    title: p.title || null,
    company: p.company || null,
    location: p.location || null,
    bio: p.bio || null,
    descriptionMd: p.descriptionMd || null,
    birthdayMonth: p.birthdayMonth,
    birthdayDay: p.birthdayDay,
    birthdayYear: p.birthdayYear,
    displayName: deriveDisplayName({
      firstName: p.firstName,
      lastName: p.lastName,
      primaryEmail: p.emails[0]?.email ?? null,
      primaryPhone: p.phones[0]?.phone ?? null,
    }),
  };
}

function writeMultiValueRows(contactId: number, p: ContactPayload, now: number) {
  db.delete(contactEmails).where(eq(contactEmails.contactId, contactId)).run();
  const seenEmails = new Set<string>();
  p.emails.forEach((e, i) => {
    const normalized = normalizeEmail(e.email);
    if (seenEmails.has(normalized)) return;
    seenEmails.add(normalized);
    db.insert(contactEmails)
      .values({
        contactId,
        email: e.email,
        emailNormalized: normalized,
        label: e.label || null,
        priority: i,
        source: "user",
        createdAt: now,
      })
      .run();
  });

  db.delete(contactPhones).where(eq(contactPhones.contactId, contactId)).run();
  const region = getSetting<string>("phone_default_region") ?? undefined;
  p.phones.forEach((ph, i) => {
    db.insert(contactPhones)
      .values({
        contactId,
        phoneRaw: ph.phone,
        phoneE164: toE164(ph.phone, region),
        label: ph.label || null,
        priority: i,
        source: "user",
        createdAt: now,
      })
      .run();
  });

  db.delete(contactSocials)
    .where(eq(contactSocials.contactId, contactId))
    .run();
  const seenUrls = new Set<string>();
  p.socials.forEach((s) => {
    if (seenUrls.has(s.url)) return;
    seenUrls.add(s.url);
    db.insert(contactSocials)
      .values({
        contactId,
        platform: s.platform,
        url: s.url,
        handle: null,
        source: "user",
        createdAt: now,
      })
      .run();
  });
}

// Stamp provenance only for fields this save actually changed (SPEC §1:
// hand-editing *a field* flips that field to user — an untouched save must
// not flip imported fields and provoke false conflicts on re-import).
function changedScalarFields(
  p: ContactPayload,
  prev: typeof contacts.$inferSelect | undefined
): ScalarFieldName[] {
  const vals = scalarValues(p);
  const pairs: [ScalarFieldName, unknown, unknown][] = [
    ["first_name", vals.firstName, prev?.firstName ?? null],
    ["last_name", vals.lastName, prev?.lastName ?? null],
    ["title", vals.title, prev?.title ?? null],
    ["company", vals.company, prev?.company ?? null],
    ["location", vals.location, prev?.location ?? null],
    ["bio", vals.bio, prev?.bio ?? null],
    ["description_md", vals.descriptionMd, prev?.descriptionMd ?? null],
  ];
  const changed = pairs
    .filter(([, next, before]) => next !== before)
    .map(([field]) => field);
  const birthdayBefore = prev
    ? [prev.birthdayMonth, prev.birthdayDay, prev.birthdayYear]
    : [null, null, null];
  const birthdayNext = [p.birthdayMonth, p.birthdayDay, p.birthdayYear];
  if (birthdayNext.some((v, i) => v !== birthdayBefore[i])) {
    changed.push("birthday");
  }
  return changed;
}

function writeProvenance(
  contactId: number,
  fields: ScalarFieldName[],
  now: number
) {
  for (const field of fields) {
    db.insert(contactFieldSources)
      .values({ contactId, field, source: "user", updatedAt: now })
      .onConflictDoUpdate({
        target: [contactFieldSources.contactId, contactFieldSources.field],
        set: { source: "user", updatedAt: now },
      })
      .run();
  }
}

function writeTags(contactId: number, tagIds: number[], now: number) {
  db.delete(contactTags).where(eq(contactTags.contactId, contactId)).run();
  for (const tagId of tagIds) {
    db.insert(contactTags).values({ contactId, tagId, createdAt: now }).run();
  }
}

function writeGroups(contactId: number, groupIds: number[], now: number) {
  db.delete(groupMembers).where(eq(groupMembers.contactId, contactId)).run();
  for (const groupId of groupIds) {
    db.insert(groupMembers)
      .values({ contactId, groupId, createdAt: now })
      .run();
  }
}

export async function createContactAction(
  _prev: ContactFormState,
  formData: FormData
): Promise<ContactFormState> {
  await requireAuth();
  const p = parsePayload(formData);
  if ("error" in p) return p;
  const now = Date.now();
  // better-sqlite3 is a single synchronous connection: statements issued via
  // `db` inside this callback run within the BEGIN/COMMIT drizzle emits.
  const contactId = db.transaction(() => {
    const row = db
      .insert(contacts)
      .values({ ...scalarValues(p), createdAt: now, updatedAt: now })
      .returning({ id: contacts.id })
      .get();
    writeMultiValueRows(row.id, p, now);
    writeProvenance(row.id, changedScalarFields(p, undefined), now);
    writeTags(row.id, p.tagIds, now);
    writeGroups(row.id, p.groupIds, now);
    return row.id;
  });
  revalidatePath("/contacts");
  redirect(`/contacts/${contactId}`);
}

export async function updateContactAction(
  contactId: number,
  _prev: ContactFormState,
  formData: FormData
): Promise<ContactFormState> {
  await requireAuth();
  const p = parsePayload(formData);
  if ("error" in p) return p;
  const now = Date.now();
  db.transaction(() => {
    const prev = db
      .select()
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .get();
    db.update(contacts)
      .set({ ...scalarValues(p), updatedAt: now })
      .where(eq(contacts.id, contactId))
      .run();
    writeMultiValueRows(contactId, p, now);
    writeProvenance(contactId, changedScalarFields(p, prev), now);
    writeTags(contactId, p.tagIds, now);
    writeGroups(contactId, p.groupIds, now);
  });
  revalidatePath("/contacts");
  revalidatePath(`/contacts/${contactId}`);
  redirect(`/contacts/${contactId}`);
}

export async function toggleStarAction(contactId: number): Promise<void> {
  await requireAuth();
  const row = db
    .select({ starred: contacts.starred })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .get();
  if (!row) return;
  db.update(contacts)
    .set({ starred: !row.starred, updatedAt: Date.now() })
    .where(eq(contacts.id, contactId))
    .run();
  revalidatePath("/contacts");
  revalidatePath(`/contacts/${contactId}`);
}

export async function setArchivedAction(
  contactId: number,
  archived: boolean
): Promise<void> {
  await requireAuth();
  db.update(contacts)
    .set({
      archivedAt: archived ? Date.now() : null,
      updatedAt: Date.now(),
    })
    .where(eq(contacts.id, contactId))
    .run();
  revalidatePath("/contacts");
  revalidatePath(`/contacts/${contactId}`);
}

export async function bulkAddTagAction(
  contactIds: number[],
  tagId: number
): Promise<void> {
  await requireAuth();
  const ids = contactIds.filter((n) => Number.isInteger(n)).slice(0, 1000);
  const now = Date.now();
  db.transaction(() => {
    for (const contactId of ids) {
      db.insert(contactTags)
        .values({ contactId, tagId, createdAt: now })
        .onConflictDoNothing()
        .run();
    }
  });
  revalidatePath("/contacts");
}

export async function bulkSetArchivedAction(
  contactIds: number[],
  archived: boolean
): Promise<void> {
  await requireAuth();
  const ids = contactIds.filter((n) => Number.isInteger(n)).slice(0, 1000);
  const now = Date.now();
  db.transaction(() => {
    for (const contactId of ids) {
      db.update(contacts)
        .set({ archivedAt: archived ? now : null, updatedAt: now })
        .where(eq(contacts.id, contactId))
        .run();
    }
  });
  revalidatePath("/contacts");
  revalidatePath("/today");
}

export async function deleteContactAction(
  contactId: number,
  confirmName: string
): Promise<{ error?: string }> {
  await requireAuth();
  const row = db
    .select({
      displayName: contacts.displayName,
      photoPath: contacts.photoPath,
    })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .get();
  if (!row) return {};
  if (confirmName.trim() !== row.displayName) {
    return { error: "Typed name doesn't match — contact not deleted." };
  }
  // Collect file paths before the cascade removes the rows that point at
  // them; note attachments and the photo are owned by the contact's data.
  const noteIds = db
    .select({ id: notes.id })
    .from(notes)
    .where(eq(notes.contactId, contactId))
    .all()
    .map((n) => n.id);
  const files = noteIds.length
    ? db
        .select({ path: attachments.path })
        .from(attachments)
        .where(inArray(attachments.noteId, noteIds))
        .all()
        .map((f) => f.path)
    : [];
  if (row.photoPath) files.push(row.photoPath);
  // SPEC §4: a surviving reminder becomes standalone *with a note in its
  // body* — "Send Sarah the deck" firing later must still say who Sarah
  // was. The FK only nulls contact_id; the annotation is on us.
  const attachedReminders = db
    .select({ id: reminders.id, body: reminders.body })
    .from(reminders)
    .where(eq(reminders.contactId, contactId))
    .all();
  for (const r of attachedReminders) {
    const note = `(Was attached to deleted contact "${row.displayName}".)`;
    db.update(reminders)
      .set({
        body: r.body ? `${r.body}\n\n${note}` : note,
        updatedAt: Date.now(),
      })
      .where(eq(reminders.id, r.id))
      .run();
  }
  db.delete(contacts).where(eq(contacts.id, contactId)).run();
  for (const rel of files) {
    fs.rmSync(path.join(DATA_DIR, rel), { force: true });
  }
  revalidatePath("/contacts");
  redirect("/contacts");
}
