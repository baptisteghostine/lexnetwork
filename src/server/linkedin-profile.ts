import "server-only";

import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { contactFieldSources, contacts, education, workHistory } from "@/db/schema";
import { normalizeForChange } from "@/lib/imports/linkedin-plan";
import {
  parseAbout,
  parseEducation,
  parseExperience,
  planEducation,
  planWorkHistory,
  PROFILE_SOURCE,
  type CapturedSections,
} from "@/lib/linkedin/profile-sections";
import { upsertProvenance } from "@/server/import-engine";

// Career history from a captured profile (SPEC §9c, 2026-11-19): the
// roles, schools and About text the owner's own page view showed, fitted
// to what Rolo already holds. Adds and fills in; never removes — a
// profile page shows only its first few roles.

export type ProfileSectionsResult = {
  /** What the page was read as, before fitting. */
  read: { roles: number; schools: number; about: boolean };
  rolesAdded: number;
  rolesUpdated: number;
  schoolsAdded: number;
  schoolsUpdated: number;
  /** 'set' | 'kept' (the owner wrote their own) | 'unchanged' | 'none' */
  bio: "set" | "kept" | "unchanged" | "none";
};

export function applyProfileSections(contactId: number, sections: CapturedSections, now = Date.now()): ProfileSectionsResult {
  const roles = parseExperience(sections.experience ?? []);
  const schools = parseEducation(sections.education ?? []);
  const about = parseAbout(sections.about ?? null);
  const result: ProfileSectionsResult = {
    read: { roles: roles.length, schools: schools.length, about: about !== null },
    rolesAdded: 0,
    rolesUpdated: 0,
    schoolsAdded: 0,
    schoolsUpdated: 0,
    bio: about === null ? "none" : "unchanged",
  };
  db.transaction(() => {
    const contact = db.select({ id: contacts.id, bio: contacts.bio }).from(contacts).where(eq(contacts.id, contactId)).get();
    if (!contact) return;

    const normalize = (company: string) => normalizeForChange("company", company);
    const rolePlan = planWorkHistory(db.select().from(workHistory).where(eq(workHistory.contactId, contactId)).all(), roles, normalize);
    for (const role of rolePlan.inserts) {
      db.insert(workHistory)
        .values({
          contactId,
          company: role.company,
          companyNormalized: normalize(role.company),
          title: role.title,
          startDate: role.startDate,
          endDate: role.endDate,
          isCurrent: role.isCurrent,
          description: role.description,
          source: PROFILE_SOURCE,
          createdAt: now,
        })
        .run();
    }
    for (const { id, ...set } of rolePlan.updates) {
      db.update(workHistory).set(set).where(and(eq(workHistory.id, id), eq(workHistory.contactId, contactId))).run();
    }
    result.rolesAdded = rolePlan.inserts.length;
    result.rolesUpdated = rolePlan.updates.length;

    const schoolPlan = planEducation(db.select().from(education).where(eq(education.contactId, contactId)).all(), schools);
    for (const school of schoolPlan.inserts) {
      db.insert(education).values({ contactId, ...school, source: PROFILE_SOURCE, createdAt: now }).run();
    }
    for (const { id, ...set } of schoolPlan.updates) {
      db.update(education).set(set).where(and(eq(education.id, id), eq(education.contactId, contactId))).run();
    }
    result.schoolsAdded = schoolPlan.inserts.length;
    result.schoolsUpdated = schoolPlan.updates.length;

    if (about !== null && about !== contact.bio) {
      // The About text fills an empty bio or refreshes one LinkedIn wrote;
      // a bio from anywhere else — the owner above all — is kept.
      const source = db
        .select({ source: contactFieldSources.source })
        .from(contactFieldSources)
        .where(and(eq(contactFieldSources.contactId, contactId), eq(contactFieldSources.field, "bio")))
        .get()?.source;
      const empty = contact.bio === null || contact.bio.trim() === "";
      if (empty || source === "linkedin") {
        db.update(contacts).set({ bio: about }).where(eq(contacts.id, contactId)).run();
        upsertProvenance(contactId, "bio", "linkedin", null, now);
        result.bio = "set";
      } else {
        result.bio = "kept";
      }
    }
    if (result.rolesAdded + result.rolesUpdated + result.schoolsAdded + result.schoolsUpdated > 0 || result.bio === "set") {
      db.update(contacts).set({ updatedAt: now }).where(eq(contacts.id, contactId)).run();
    }
  });
  return result;
}
