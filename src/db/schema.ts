import { sql } from "drizzle-orm";
import {
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
    index("idx_contacts_birthday").on(t.birthdayMonth, t.birthdayDay),
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
// sync_run_id will be added by the Phase 3 migration alongside sync_runs.
export const contactFieldSources = sqliteTable(
  "contact_field_sources",
  {
    contactId: integer("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    field: text("field").notNull(),
    source: text("source").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.contactId, t.field] })]
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  // JSON-encoded value.
  value: text("value").notNull(),
});

export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
export type ContactEmail = typeof contactEmails.$inferSelect;
export type ContactPhone = typeof contactPhones.$inferSelect;
export type ContactSocial = typeof contactSocials.$inferSelect;
export type Tag = typeof tags.$inferSelect;
