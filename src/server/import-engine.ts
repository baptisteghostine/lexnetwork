import "server-only";

import fs from "node:fs";
import path from "node:path";

import { and, eq, isNull, lt } from "drizzle-orm";

import { DATA_DIR, db } from "@/db/client";
import {
  contactChanges,
  contactEmails,
  contactFieldSources,
  contactPhones,
  contacts,
  contactSocials,
  syncRuns,
} from "@/db/schema";
import {
  deriveDisplayName,
  normalizeEmail,
} from "@/lib/contacts/normalize";
import { toE164 } from "@/lib/imports/phone";
import { planRow, type StoredSnapshot } from "@/lib/imports/planner";
import { isImportableRow } from "@/lib/imports/mapping";
import {
  summarize,
  type ImportRow,
  type ImportStats,
  type RowPlan,
  type ScalarField,
} from "@/lib/imports/types";
import { getSetting } from "@/lib/settings";

export type ImportKind = "csv_import" | "vcard_import";

/** Provenance source string for a run kind. */
function sourceOf(kind: ImportKind): string {
  return kind === "csv_import" ? "csv" : "vcard";
}

function phoneRegion(): string | undefined {
  return getSetting<string>("phone_default_region") ?? undefined;
}

// ---------- identity ladder (SPEC §8) ----------

function matchContact(
  row: ImportRow,
  e164: (raw: string) => string | null
): { contactId: number; matchedBy: "email" | "phone" | "name" } | null {
  for (const e of row.emails) {
    const hit = db
      .select({ contactId: contactEmails.contactId })
      .from(contactEmails)
      .where(eq(contactEmails.emailNormalized, normalizeEmail(e.email)))
      .get();
    if (hit) return { contactId: hit.contactId, matchedBy: "email" };
  }
  for (const p of row.phones) {
    const num = e164(p.phone);
    if (!num) continue;
    const hit = db
      .select({ contactId: contactPhones.contactId })
      .from(contactPhones)
      .where(eq(contactPhones.phoneE164, num))
      .get();
    if (hit) return { contactId: hit.contactId, matchedBy: "phone" };
  }
  // Name match only when the row has no email/phone AND exactly one
  // active contact matches — otherwise create new, dedupe queue handles it.
  if (row.emails.length === 0 && row.phones.length === 0) {
    const name = [row.firstName, row.lastName]
      .filter(Boolean)
      .join(" ")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
    const full = name || row.fullName?.trim().toLowerCase().replace(/\s+/g, " ");
    if (full) {
      const hits = db
        .select({ id: contacts.id, displayName: contacts.displayName })
        .from(contacts)
        .where(isNull(contacts.archivedAt))
        .all()
        .filter((c) => c.displayName.toLowerCase().replace(/\s+/g, " ") === full);
      if (hits.length === 1) {
        return { contactId: hits[0].id, matchedBy: "name" };
      }
    }
  }
  return null;
}

function loadSnapshot(contactId: number): StoredSnapshot | null {
  const c = db.select().from(contacts).where(eq(contacts.id, contactId)).get();
  if (!c) return null;
  const provenanceRows = db
    .select()
    .from(contactFieldSources)
    .where(eq(contactFieldSources.contactId, contactId))
    .all();
  const provenance: StoredSnapshot["provenance"] = {};
  for (const r of provenanceRows) {
    provenance[r.field as ScalarField] = r.source;
  }
  const emails = db
    .select()
    .from(contactEmails)
    .where(eq(contactEmails.contactId, contactId))
    .all();
  const phones = db
    .select()
    .from(contactPhones)
    .where(eq(contactPhones.contactId, contactId))
    .all();
  const socials = db
    .select()
    .from(contactSocials)
    .where(eq(contactSocials.contactId, contactId))
    .all();
  const birthday =
    c.birthdayMonth && c.birthdayDay
      ? `${String(c.birthdayMonth).padStart(2, "0")}-${String(c.birthdayDay).padStart(2, "0")}${c.birthdayYear ? `-${c.birthdayYear}` : ""}`
      : null;
  return {
    id: c.id,
    values: {
      first_name: c.firstName,
      last_name: c.lastName,
      title: c.title,
      company: c.company,
      location: c.location,
      bio: c.bio,
      birthday,
    },
    provenance,
    emailsNormalized: emails.map((e) => e.emailNormalized),
    phonesE164: phones.map((p) => p.phoneE164).filter((v): v is string => !!v),
    phonesRaw: phones.map((p) => p.phoneRaw),
    socialUrls: socials.map((s) => s.url),
  };
}

// ---------- apply ----------

const FIELD_COLUMNS: Record<
  Exclude<ScalarField, "birthday">,
  "firstName" | "lastName" | "title" | "company" | "location" | "bio"
> = {
  first_name: "firstName",
  last_name: "lastName",
  title: "title",
  company: "company",
  location: "location",
  bio: "bio",
};

export function applyScalarWrite(
  contactId: number,
  field: ScalarField,
  value: string | null,
  birthday: ImportRow["birthday"] | undefined,
  now: number
): void {
  if (field === "birthday") {
    db.update(contacts)
      .set({
        birthdayMonth: birthday?.month ?? null,
        birthdayDay: birthday?.day ?? null,
        birthdayYear: birthday?.year ?? null,
        updatedAt: now,
      })
      .where(eq(contacts.id, contactId))
      .run();
    return;
  }
  db.update(contacts)
    .set({ [FIELD_COLUMNS[field]]: value, updatedAt: now })
    .where(eq(contacts.id, contactId))
    .run();
}

export function upsertProvenance(
  contactId: number,
  field: ScalarField,
  source: string,
  syncRunId: number | null,
  now: number
): void {
  db.insert(contactFieldSources)
    .values({ contactId, field, source, syncRunId, updatedAt: now })
    .onConflictDoUpdate({
      target: [contactFieldSources.contactId, contactFieldSources.field],
      set: { source, syncRunId, updatedAt: now },
    })
    .run();
}

function applyPlan(
  plan: RowPlan,
  row: ImportRow,
  kind: ImportKind,
  runId: number,
  e164: (raw: string) => string | null
): number {
  const now = Date.now();
  const source = sourceOf(kind);

  let contactId: number;
  if (plan.contactId === null) {
    const inserted = db
      .insert(contacts)
      .values({
        displayName: plan.displayName,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: contacts.id })
      .get();
    contactId = inserted.id;
  } else {
    contactId = plan.contactId;
  }

  for (const w of plan.writes) {
    applyScalarWrite(contactId, w.field, w.incoming, row.birthday, now);
    upsertProvenance(contactId, w.field, source, runId, now);
    // SPEC §5: every import carrying title/company emits a change row when
    // it overwrites a real prior value (filling an empty field is new info,
    // not a change; the planner already filtered normalization-only diffs).
    if (
      (w.field === "title" || w.field === "company") &&
      w.previous !== null &&
      w.previous !== ""
    ) {
      db.insert(contactChanges)
        .values({
          contactId,
          field: w.field,
          oldValue: w.previous,
          newValue: w.incoming,
          source,
          syncRunId: runId,
          detectedAt: now,
        })
        .run();
    }
  }

  const existingEmailCount = db
    .select({ id: contactEmails.id })
    .from(contactEmails)
    .where(eq(contactEmails.contactId, contactId))
    .all().length;
  plan.newEmails.forEach((e, i) => {
    db.insert(contactEmails)
      .values({
        contactId,
        email: e.email,
        emailNormalized: normalizeEmail(e.email),
        label: e.label ?? null,
        priority: existingEmailCount + i,
        source,
        createdAt: now,
      })
      .onConflictDoNothing()
      .run();
  });

  const existingPhoneCount = db
    .select({ id: contactPhones.id })
    .from(contactPhones)
    .where(eq(contactPhones.contactId, contactId))
    .all().length;
  plan.newPhones.forEach((p, i) => {
    db.insert(contactPhones)
      .values({
        contactId,
        phoneRaw: p.phone,
        phoneE164: e164(p.phone),
        label: p.label ?? null,
        priority: existingPhoneCount + i,
        source,
        createdAt: now,
      })
      .onConflictDoNothing()
      .run();
  });

  for (const s of plan.newSocials) {
    db.insert(contactSocials)
      .values({
        contactId,
        platform: s.platform,
        url: s.url,
        source,
        createdAt: now,
      })
      .onConflictDoNothing()
      .run();
  }

  // Photo: only fills an empty slot — imports never replace a chosen photo.
  if (row.photoBase64) {
    const c = db
      .select({ photoPath: contacts.photoPath })
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .get();
    if (c && !c.photoPath) {
      const ext = row.photoBase64.mime.split("/")[1]?.slice(0, 5) || "jpg";
      const rel = path.join("attachments", "photos", `${contactId}.${ext}`);
      fs.mkdirSync(path.join(DATA_DIR, "attachments", "photos"), {
        recursive: true,
      });
      try {
        fs.writeFileSync(
          path.join(DATA_DIR, rel),
          Buffer.from(row.photoBase64.data, "base64")
        );
        db.update(contacts)
          .set({ photoPath: rel })
          .where(eq(contacts.id, contactId))
          .run();
      } catch {
        // Bad base64 → skip photo, keep the rest of the row.
      }
    }
  }

  // Keep display_name in sync with final name/email state.
  const final = db
    .select()
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .get();
  if (final) {
    const primaryEmail = db
      .select({ email: contactEmails.email })
      .from(contactEmails)
      .where(eq(contactEmails.contactId, contactId))
      .orderBy(contactEmails.priority)
      .get();
    const primaryPhone = db
      .select({ phoneRaw: contactPhones.phoneRaw })
      .from(contactPhones)
      .where(eq(contactPhones.contactId, contactId))
      .orderBy(contactPhones.priority)
      .get();
    const displayName = deriveDisplayName({
      firstName: final.firstName,
      lastName: final.lastName,
      primaryEmail: primaryEmail?.email ?? null,
      primaryPhone: primaryPhone?.phoneRaw ?? null,
    });
    if (displayName !== final.displayName) {
      db.update(contacts)
        .set({ displayName })
        .where(eq(contacts.id, contactId))
        .run();
    }
  }
  return contactId;
}

// ---------- orchestration ----------

// A run older than this still marked 'running' means the process died
// mid-import (rows are applied per-row transactionally, so partial work
// is consistent — the run just never got its final status).
const STALE_RUN_MS = 60 * 60 * 1000;

export function reclaimStaleRuns(): void {
  db.update(syncRuns)
    .set({
      status: "failed",
      error: "Interrupted — the app stopped before this run finished.",
      finishedAt: Date.now(),
    })
    .where(
      and(
        eq(syncRuns.status, "running"),
        lt(syncRuns.startedAt, Date.now() - STALE_RUN_MS)
      )
    )
    .run();
}

export type ImportRunResult =
  | { duplicateOf: number }
  | { runId: number | null; stats: ImportStats; plans: RowPlan[] };

export function executeImport(opts: {
  rows: ImportRow[];
  kind: ImportKind;
  fileName: string;
  fileSha256: string;
  mappingJson?: string;
  dryRun: boolean;
  force?: boolean;
}): ImportRunResult {
  const region = phoneRegion();
  const e164 = (raw: string) => toE164(raw, region);

  if (!opts.dryRun && !opts.force) {
    const dup = db
      .select({ id: syncRuns.id })
      .from(syncRuns)
      .where(
        and(
          eq(syncRuns.fileSha256, opts.fileSha256),
          eq(syncRuns.status, "success")
        )
      )
      .get();
    if (dup) return { duplicateOf: dup.id };
  }

  let runId: number | null = null;
  if (!opts.dryRun) {
    runId = db
      .insert(syncRuns)
      .values({
        kind: opts.kind,
        fileName: opts.fileName,
        fileSha256: opts.fileSha256,
        mappingJson: opts.mappingJson ?? null,
        status: "running",
        startedAt: Date.now(),
      })
      .returning({ id: syncRuns.id })
      .get().id;
  }

  const plans: RowPlan[] = [];
  // Dry-run can't see its own would-be inserts, so track provisional keys to
  // flag in-file duplicates honestly.
  const provisionalKeys = new Set<string>();

  for (const row of opts.rows) {
    if (!isImportableRow(row)) {
      plans.push({
        status: "error",
        contactId: null,
        matchedBy: null,
        displayName: "(empty row)",
        writes: [],
        conflicts: [],
        newEmails: [],
        newPhones: [],
        newSocials: [],
        error: "Row has no name, email, or phone.",
      });
      continue;
    }
    try {
      const match = matchContact(row, e164);
      const snapshot = match ? loadSnapshot(match.contactId) : null;
      const plan = planRow(row, snapshot, sourceOf(opts.kind), e164);
      plan.matchedBy = match?.matchedBy ?? null;

      if (opts.dryRun && plan.status === "new") {
        const keys = row.emails.map((e) => normalizeEmail(e.email));
        const dupKey = keys.find((k) => provisionalKeys.has(k));
        if (dupKey) {
          plan.status = "updated";
          plan.error = "Merges with an earlier row in this file.";
        }
        keys.forEach((k) => provisionalKeys.add(k));
      }

      if (!opts.dryRun && plan.status !== "error") {
        db.transaction(() => {
          // Backfill the id so the stored report can link new contacts.
          plan.contactId = applyPlan(plan, row, opts.kind, runId as number, e164);
        });
      }
      plans.push(plan);
    } catch (err) {
      plans.push({
        status: "error",
        contactId: null,
        matchedBy: null,
        displayName: row.fullName ?? row.emails[0]?.email ?? "(row)",
        writes: [],
        conflicts: [],
        newEmails: [],
        newPhones: [],
        newSocials: [],
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  const stats = summarize(plans);
  if (runId !== null) {
    db.update(syncRuns)
      .set({
        status: stats.errors === stats.total ? "failed" : "success",
        statsJson: JSON.stringify(stats),
        reportJson: JSON.stringify(plans.slice(0, 5000)),
        finishedAt: Date.now(),
      })
      .where(eq(syncRuns.id, runId))
      .run();
  }
  return { runId, stats, plans };
}
