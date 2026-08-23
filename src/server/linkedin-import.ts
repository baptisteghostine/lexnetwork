import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  contactChanges,
  contactEmails,
  contactFieldSources,
  contacts,
  contactSocials,
  interactions,
  syncRuns,
  workHistory,
} from "@/db/schema";
import { recomputeContact } from "@/lib/cadence/recompute";
import { deriveDisplayName, normalizeEmail } from "@/lib/contacts/normalize";
import {
  extractArchiveFiles,
  normalizeLinkedInUrl,
  parseConnections,
  parseMessages,
  parseProfileOwnerName,
  type LinkedInConnection,
  type LinkedInMessage,
} from "@/lib/imports/linkedin";
import {
  normalizeForChange,
  planConnection,
  type LinkedInScalarField,
  type LinkedInSnapshot,
} from "@/lib/imports/linkedin-plan";
import { localParts } from "@/lib/time";
import { ownerTimezone } from "@/server/today-data";

const SOURCE = "linkedin";

export type UnmatchedConversation = {
  conversationId: string;
  counterpartName: string;
  counterpartProfileUrl: string | null;
  messages: {
    direction: "inbound" | "outbound";
    occurredAt: number;
    /** Absent in reports written before snippets existed. */
    snippet?: string | null;
  }[];
};

export type LinkedInReport = {
  kind: "linkedin";
  ownerName: string | null;
  stats: {
    total: number;
    new: number;
    updated: number;
    unchanged: number;
    conflicts: number;
    errors: number;
  };
  conflicts: {
    contactId: number;
    displayName: string;
    field: LinkedInScalarField;
    stored: string;
    incoming: string;
  }[];
  jobChanges: {
    contactId: number;
    displayName: string;
    field: "company" | "title";
    old: string;
    new: string;
  }[];
  messagesLinked: number;
  messageContacts: number;
  unmatched: UnmatchedConversation[];
};

export type LinkedInImportResult =
  | { duplicateOf: number }
  | { error: string }
  | { runId: number; report: LinkedInReport };

// ---------- identity maps ----------

function linkedinUrlMap(): Map<string, number> {
  const map = new Map<string, number>();
  const rows = db
    .select({ contactId: contactSocials.contactId, url: contactSocials.url })
    .from(contactSocials)
    .where(eq(contactSocials.platform, "linkedin"))
    .all();
  for (const r of rows) {
    const norm = normalizeLinkedInUrl(r.url);
    if (norm && !map.has(norm)) map.set(norm, r.contactId);
  }
  return map;
}

/**
 * Active contacts by normalized full name; null marks ambiguous names.
 * `linkedInSourcedOnly` restricts the pool to contacts carrying a LinkedIn
 * profile URL — SPEC §8 scopes message counterpart name-matching to
 * "LinkedIn-sourced contacts", so a same-named contact from another source
 * doesn't silently absorb a stranger's conversation.
 */
function nameMap(linkedInSourcedOnly = false): Map<string, number | null> {
  const map = new Map<string, number | null>();
  let rows: { id: number; displayName: string }[];
  if (linkedInSourcedOnly) {
    rows = db
      .selectDistinct({ id: contacts.id, displayName: contacts.displayName })
      .from(contacts)
      .innerJoin(contactSocials, eq(contactSocials.contactId, contacts.id))
      .where(
        and(isNull(contacts.archivedAt), eq(contactSocials.platform, "linkedin"))
      )
      .all();
  } else {
    rows = db
      .select({ id: contacts.id, displayName: contacts.displayName })
      .from(contacts)
      .where(isNull(contacts.archivedAt))
      .all();
  }
  for (const r of rows) {
    const key = r.displayName.trim().toLowerCase().replace(/\s+/g, " ");
    map.set(key, map.has(key) ? null : r.id);
  }
  return map;
}

function loadSnapshot(contactId: number): LinkedInSnapshot | null {
  const c = db.select().from(contacts).where(eq(contacts.id, contactId)).get();
  if (!c) return null;
  const provenance: LinkedInSnapshot["provenance"] = {};
  for (const r of db
    .select()
    .from(contactFieldSources)
    .where(eq(contactFieldSources.contactId, contactId))
    .all()) {
    if (
      r.field === "first_name" ||
      r.field === "last_name" ||
      r.field === "company" ||
      r.field === "title" ||
      r.field === "location"
    ) {
      provenance[r.field] = r.source;
    }
  }
  return {
    contactId,
    values: {
      first_name: c.firstName,
      last_name: c.lastName,
      company: c.company,
      title: c.title,
      location: c.location,
    },
    provenance,
  };
}

const FIELD_COLUMN: Record<
  LinkedInScalarField,
  "firstName" | "lastName" | "company" | "title" | "location"
> = {
  first_name: "firstName",
  last_name: "lastName",
  company: "company",
  title: "title",
  location: "location",
};

function upsertProvenance(
  contactId: number,
  field: LinkedInScalarField,
  runId: number,
  now: number
): void {
  db.insert(contactFieldSources)
    .values({ contactId, field, source: SOURCE, syncRunId: runId, updatedAt: now })
    .onConflictDoUpdate({
      target: [contactFieldSources.contactId, contactFieldSources.field],
      set: { source: SOURCE, syncRunId: runId, updatedAt: now },
    })
    .run();
}

/** Keep the linkedin-sourced current work_history row in sync; a company
 * switch end-dates the old row — this is what feeds ex-company filters. */
function upsertWorkHistory(
  contactId: number,
  row: LinkedInConnection,
  now: number
): void {
  if (!row.company) return;
  const normalized = normalizeForChange("company", row.company);
  const current = db
    .select()
    .from(workHistory)
    .where(
      and(
        eq(workHistory.contactId, contactId),
        eq(workHistory.isCurrent, true),
        eq(workHistory.source, SOURCE)
      )
    )
    .get();
  if (current && current.companyNormalized === normalized) {
    if ((current.title ?? "") !== (row.position ?? "")) {
      db.update(workHistory)
        .set({ title: row.position })
        .where(eq(workHistory.id, current.id))
        .run();
    }
    return;
  }
  const tz = ownerTimezone();
  const p = localParts(tz, now);
  const yearMonth = `${p.year}-${String(p.month).padStart(2, "0")}`;
  if (current) {
    db.update(workHistory)
      .set({ isCurrent: false, endDate: yearMonth })
      .where(eq(workHistory.id, current.id))
      .run();
  }
  db.insert(workHistory)
    .values({
      contactId,
      company: row.company,
      companyNormalized: normalized,
      title: row.position,
      startDate: current ? yearMonth : null,
      isCurrent: true,
      source: SOURCE,
      createdAt: now,
    })
    .run();
}

function ensureSocialUrl(contactId: number, rawUrl: string, now: number): void {
  db.insert(contactSocials)
    .values({
      contactId,
      platform: "linkedin",
      url: rawUrl,
      source: SOURCE,
      createdAt: now,
    })
    .onConflictDoNothing()
    .run();
}

// ---------- messages ----------

export function insertLinkedInMessages(
  contactId: number,
  conversationId: string,
  messages: {
    direction: "inbound" | "outbound";
    occurredAt: number;
    snippet?: string | null;
  }[],
  runId: number | null
): number {
  const now = Date.now();
  let inserted = 0;
  for (const m of messages) {
    const res = db
      .insert(interactions)
      .values({
        contactId,
        kind: "message",
        direction: m.direction,
        occurredAt: m.occurredAt,
        // The snippet is the message's timeline face ("Hi Kate, it's
        // Baptiste from LBS…") — same column manual and email interactions
        // use for theirs.
        title: m.snippet ?? null,
        source: SOURCE,
        sourceKey: `${conversationId}:${m.occurredAt}`,
        // LinkedIn messages count in either direction (SPEC §3).
        countsForTouch: true,
        syncRunId: runId,
        createdAt: now,
      })
      // Re-importing a ZIP is the normal ritual, and messages imported
      // before snippets existed sit with title NULL — fill exactly those,
      // touch nothing else. The WHERE keeps `changes` honest: pure dupes
      // still count 0, so messagesLinked doesn't inflate on re-import.
      .onConflictDoUpdate({
        target: [interactions.contactId, interactions.source, interactions.sourceKey],
        // uq_interactions_source is a partial index; SQLite only matches
        // the ON CONFLICT target when its WHERE is restated.
        targetWhere: sql`source_key IS NOT NULL`,
        set: { title: sql`excluded.title` },
        setWhere: sql`${interactions.title} IS NULL AND excluded.title IS NOT NULL`,
      })
      .run();
    inserted += res.changes;
  }
  return inserted;
}

// ---------- orchestration ----------

export function executeLinkedInImport(opts: {
  zip: Uint8Array;
  fileName: string;
  fileSha256: string;
  force?: boolean;
}): LinkedInImportResult {
  if (!opts.force) {
    const dup = db
      .select({ id: syncRuns.id })
      .from(syncRuns)
      .where(
        and(
          eq(syncRuns.fileSha256, opts.fileSha256),
          eq(syncRuns.kind, "linkedin_import"),
          eq(syncRuns.status, "success")
        )
      )
      .get();
    if (dup) return { duplicateOf: dup.id };
  }

  let files;
  try {
    files = extractArchiveFiles(opts.zip);
  } catch {
    return { error: "That file doesn't look like a ZIP archive." };
  }
  if (!files.connections) {
    return {
      error:
        "No Connections.csv found in the ZIP — make sure you export 'Connections' from LinkedIn.",
    };
  }

  const ownerName = files.profile
    ? parseProfileOwnerName(files.profile)
    : null;
  const connections = parseConnections(files.connections);
  const messages = files.messages
    ? parseMessages(files.messages, ownerName)
    : [];

  return executeLinkedInRows({
    connections,
    messages,
    ownerName,
    runKind: "linkedin_import",
    fileName: opts.fileName,
    fileSha256: opts.fileSha256,
  });
}

/**
 * Row-level core of the LinkedIn import: identity ladder, provenance
 * merge, job-change detection, message linking. Shared by the ZIP upload
 * (kind 'linkedin_import'), the Member Data Portability API sync
 * (kind 'linkedin_api_sync', SPEC §9a), and the opt-in Voyager cookie sync
 * (kind 'linkedin_voyager_sync', SPEC §9b) — all sources produce the same
 * `LinkedInConnection` rows, so the merge semantics stay identical.
 */
export function executeLinkedInRows(opts: {
  connections: LinkedInConnection[];
  messages: LinkedInMessage[];
  ownerName: string | null;
  runKind:
    | "linkedin_import"
    | "linkedin_api_sync"
    | "linkedin_voyager_sync"
    | "linkedin_profile_enrich";
  fileName?: string;
  fileSha256?: string | null;
}): { runId: number; report: LinkedInReport } {
  const { connections, messages, ownerName } = opts;
  const runId = db
    .insert(syncRuns)
    .values({
      kind: opts.runKind,
      fileName: opts.fileName ?? null,
      fileSha256: opts.fileSha256 ?? null,
      status: "running",
      startedAt: Date.now(),
    })
    .returning({ id: syncRuns.id })
    .get().id;

  const report: LinkedInReport = {
    kind: "linkedin",
    ownerName,
    stats: {
      total: connections.length,
      new: 0,
      updated: 0,
      unchanged: 0,
      conflicts: 0,
      errors: 0,
    },
    conflicts: [],
    jobChanges: [],
    messagesLinked: 0,
    messageContacts: 0,
    unmatched: [],
  };

  const byUrl = linkedinUrlMap();
  const byName = nameMap();
  const touched = new Set<number>();

  for (const row of connections) {
    try {
      db.transaction(() => {
        const now = Date.now();
        // Identity ladder (SPEC §8): profile URL → email → unique name.
        let contactId: number | null = null;
        if (row.profileUrl && byUrl.has(row.profileUrl)) {
          contactId = byUrl.get(row.profileUrl)!;
        } else if (row.email) {
          const hit = db
            .select({ contactId: contactEmails.contactId })
            .from(contactEmails)
            .where(eq(contactEmails.emailNormalized, normalizeEmail(row.email)))
            .get();
          if (hit) contactId = hit.contactId;
        } else {
          const key = [row.firstName, row.lastName]
            .filter(Boolean)
            .join(" ")
            .trim()
            .toLowerCase()
            .replace(/\s+/g, " ");
          const unique = byName.get(key);
          if (unique !== undefined && unique !== null) contactId = unique;
        }

        const snapshot = contactId !== null ? loadSnapshot(contactId) : null;
        const plan = planConnection(row, snapshot);

        if (snapshot === null) {
          const displayName = deriveDisplayName({
            firstName: row.firstName,
            lastName: row.lastName,
            primaryEmail: row.email,
          });
          contactId = db
            .insert(contacts)
            .values({
              firstName: row.firstName || null,
              lastName: row.lastName || null,
              company: row.company,
              title: row.position,
              displayName,
              createdAt: now,
              updatedAt: now,
            })
            .returning({ id: contacts.id })
            .get().id;
          for (const w of plan.writes) {
            upsertProvenance(contactId, w.field, runId, now);
          }
          if (row.email) {
            db.insert(contactEmails)
              .values({
                contactId,
                email: row.email,
                emailNormalized: normalizeEmail(row.email),
                priority: 0,
                source: SOURCE,
                createdAt: now,
              })
              .onConflictDoNothing()
              .run();
          }
          report.stats.new++;
        } else {
          const cid = contactId as number;
          for (const w of plan.writes) {
            db.update(contacts)
              .set({ [FIELD_COLUMN[w.field]]: w.value, updatedAt: now })
              .where(eq(contacts.id, cid))
              .run();
            upsertProvenance(cid, w.field, runId, now);
          }
          // Derived display_name must follow name writes: a contact created
          // email-only ("ana@x.com") who matched by email and just gained
          // first/last names should stop displaying as her address.
          if (plan.writes.some((w) => w.field === "first_name" || w.field === "last_name")) {
            const final = db.select().from(contacts).where(eq(contacts.id, cid)).get();
            if (final) {
              const primaryEmail = db
                .select({ email: contactEmails.email })
                .from(contactEmails)
                .where(eq(contactEmails.contactId, cid))
                .orderBy(contactEmails.priority)
                .get();
              const displayName = deriveDisplayName({
                firstName: final.firstName,
                lastName: final.lastName,
                primaryEmail: primaryEmail?.email ?? null,
              });
              if (displayName !== final.displayName) {
                db.update(contacts)
                  .set({ displayName })
                  .where(eq(contacts.id, cid))
                  .run();
              }
            }
          }
          for (const change of plan.changes) {
            db.insert(contactChanges)
              .values({
                contactId: cid,
                field: change.field,
                oldValue: change.old,
                newValue: change.new,
                source: SOURCE,
                syncRunId: runId,
                detectedAt: now,
              })
              .run();
            report.jobChanges.push({
              contactId: cid,
              displayName: snapshot.values.first_name
                ? `${snapshot.values.first_name} ${snapshot.values.last_name ?? ""}`.trim()
                : String(cid),
              ...change,
            });
          }
          for (const conflict of plan.conflicts) {
            report.conflicts.push({
              contactId: cid,
              displayName:
                `${snapshot.values.first_name ?? ""} ${snapshot.values.last_name ?? ""}`.trim() ||
                String(cid),
              ...conflict,
            });
          }
          if (plan.status === "updated") report.stats.updated++;
          else if (plan.conflicts.length > 0) report.stats.conflicts++;
          else report.stats.unchanged++;
        }

        const cid = contactId as number;
        if (row.profileUrlRaw) {
          ensureSocialUrl(cid, row.profileUrlRaw, now);
          if (row.profileUrl) byUrl.set(row.profileUrl, cid);
        }
        upsertWorkHistory(cid, row, now);
      });
    } catch {
      report.stats.errors++;
    }
  }
  report.stats.conflicts = report.conflicts.length;

  // ---------- messages → interactions ----------
  const byConversation = new Map<string, LinkedInMessage[]>();
  for (const m of messages) {
    const list = byConversation.get(m.conversationId) ?? [];
    list.push(m);
    byConversation.set(m.conversationId, list);
  }
  const freshNames = nameMap(true);
  for (const [conversationId, msgs] of byConversation) {
    // Counterpart identity: profile URL first, else exact unique name.
    const url = msgs.find((m) => m.counterpartProfileUrl)?.counterpartProfileUrl;
    const name = msgs[0].counterpartName;
    let contactId: number | null = null;
    if (url && byUrl.has(url)) contactId = byUrl.get(url)!;
    else {
      const unique = freshNames.get(
        name.trim().toLowerCase().replace(/\s+/g, " ")
      );
      if (unique !== undefined && unique !== null) contactId = unique;
    }
    if (contactId === null) {
      report.unmatched.push({
        conversationId,
        counterpartName: name,
        counterpartProfileUrl: url ?? null,
        messages: msgs.slice(0, 200).map((m) => ({
          direction: m.direction,
          occurredAt: m.occurredAt,
          // Kept in the report so linking the conversation later writes
          // the same snippets a direct match would have.
          snippet: m.snippet ?? null,
        })),
      });
      continue;
    }
    report.messagesLinked += insertLinkedInMessages(
      contactId,
      conversationId,
      msgs.map((m) => ({
        direction: m.direction,
        occurredAt: m.occurredAt,
        snippet: m.snippet ?? null,
      })),
      runId
    );
    touched.add(contactId);
  }
  report.messageContacts = touched.size;
  for (const id of touched) recomputeContact(id);

  // Fail loud with a reason (CLAUDE.md): zero parsed rows means the file
  // shape drifted, not that the network emptied; all-errors means every
  // row failed to apply. Both must say so, not sit as failed-with-null.
  const failure =
    report.stats.total === 0
      ? "No connections parsed — Connections.csv is missing or its header has drifted; the messages (if any) were still processed."
      : report.stats.errors === report.stats.total
        ? `All ${report.stats.total} row(s) failed to apply.`
        : null;
  db.update(syncRuns)
    .set({
      status: failure ? "failed" : "success",
      error: failure,
      statsJson: JSON.stringify(report.stats),
      reportJson: JSON.stringify(report),
      finishedAt: Date.now(),
    })
    .where(eq(syncRuns.id, runId))
    .run();

  return { runId, report };
}
