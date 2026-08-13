"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { db } from "@/db/client";
import {
  contactEmails,
  contactFieldSources,
  contactPhones,
  contacts,
  contactSocials,
  contactTags,
  groupMembers,
} from "@/db/schema";
import { requireAuth } from "@/lib/auth";
import {
  deriveDisplayName,
  isValidBirthday,
  normalizeEmail,
} from "@/lib/contacts/normalize";

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
const SCALAR_FIELDS = [
  "first_name",
  "last_name",
  "title",
  "company",
  "location",
  "bio",
  "description_md",
  "birthday",
] as const;

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
  p.phones.forEach((ph, i) => {
    db.insert(contactPhones)
      .values({
        contactId,
        phoneRaw: ph.phone,
        // E.164 parsing arrives with libphonenumber-js in Phase 3 (imports);
        // until then phone identity matching is not needed.
        phoneE164: null,
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

function writeProvenance(contactId: number, now: number) {
  for (const field of SCALAR_FIELDS) {
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
    writeProvenance(row.id, now);
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
    db.update(contacts)
      .set({ ...scalarValues(p), updatedAt: now })
      .where(eq(contacts.id, contactId))
      .run();
    writeMultiValueRows(contactId, p, now);
    writeProvenance(contactId, now);
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

export async function deleteContactAction(
  contactId: number,
  confirmName: string
): Promise<{ error?: string }> {
  await requireAuth();
  const row = db
    .select({ displayName: contacts.displayName })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .get();
  if (!row) return {};
  if (confirmName.trim() !== row.displayName) {
    return { error: "Typed name doesn't match — contact not deleted." };
  }
  db.delete(contacts).where(eq(contacts.id, contactId)).run();
  revalidatePath("/contacts");
  redirect("/contacts");
}
