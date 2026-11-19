import "server-only";

import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { db, rawDb } from "@/db/client";
import {
  agentCalls,
  contactEmails,
  contactRelationships,
  contacts,
  contactSocials,
  contactTags,
  customFields,
  customFieldValues,
  interactions,
  reminders,
  tags,
} from "@/db/schema";
import { filterCompanies, groupCompanies } from "@/lib/agent/companies";
import { clip, clipBody, daysAgo, iso, parseDate, serializeCapped } from "@/lib/agent/shape";
import type { FilterClause, FilterSet, SortSpec } from "@/lib/filters/types";
import { bodyFromMeta } from "@/lib/imports/linkedin";
import { getSetting, ownerTimezone } from "@/lib/settings";
import { readProfileCard } from "@/server/ai-enrich";
import { outboundSnippets, readVoiceSettings } from "@/server/ai-voice";
import { findCallByKey, ledgerKey, recordAgentCall } from "@/server/agent/ledger";
import {
  DATA_NOTE,
  dateArg,
  defineTool,
  idList,
  ToolRefusal,
  type AgentTool,
  type ToolOutput,
} from "@/server/agent/tool-kit";
import { WRITE_TOOLS } from "@/server/agent/write-tools";
import { matchContact } from "@/server/import-engine";
import {
  filterContactIds,
  getContactDetail,
  getContactGroupIds,
  getContactTimeline,
  listGroups,
  listTags,
} from "@/server/queries";
import { findContactsPrecisely, searchNotes } from "@/server/search";
import { getTodayData } from "@/server/today-data";

// The connector's tools (SPEC §14, Phase 14: read-only). Each one is a
// thin, bounded view over a query Rolo already had — the reasoning is
// Claude's, the data and its limits are Rolo's.
//
// Rules every tool here keeps:
//   - arguments are validated (strict: an unknown key is a refusal, not
//     a guess), ids are checked against the database;
//   - answers are compact and capped, with ids to ask for more;
//   - nothing from `settings`, no token, no credential ever leaves;
//   - free text written by other people is returned as data, and the
//     server instructions say so.

function count(sqlText: string, ...params: unknown[]): number {
  return (rawDb.prepare(sqlText).get(...params) as { n: number }).n;
}

// ---------- compact contact rows ----------

type CompactContact = {
  id: number;
  name: string;
  title: string | null;
  company: string | null;
  location: string | null;
  email: string | null;
  linkedin: string | null;
  tags: string[];
  starred: boolean;
  archived: boolean;
  lastInteractionAt: string | null;
  daysSinceLastInteraction: number | null;
  keepInTouchEveryDays: number | null;
  nextTouchAt: string | null;
};

/** Compact rows for these ids, in the order given. Unknown ids are skipped. */
function compactContacts(ids: number[], now: number): CompactContact[] {
  if (ids.length === 0) return [];
  const rows = db.select().from(contacts).where(inArray(contacts.id, ids)).all();
  const byId = new Map(rows.map((c) => [c.id, c]));
  const emailBy = new Map<number, string>();
  for (const e of db
    .select({ contactId: contactEmails.contactId, email: contactEmails.email })
    .from(contactEmails)
    .where(inArray(contactEmails.contactId, ids))
    .orderBy(desc(contactEmails.priority), desc(contactEmails.id))
    .all()) {
    emailBy.set(e.contactId, e.email); // lowest priority number written last wins
  }
  const linkedinBy = new Map<number, string>();
  for (const s of db
    .select({ contactId: contactSocials.contactId, url: contactSocials.url })
    .from(contactSocials)
    .where(and(inArray(contactSocials.contactId, ids), eq(contactSocials.platform, "linkedin")))
    .all()) {
    if (!linkedinBy.has(s.contactId)) linkedinBy.set(s.contactId, s.url);
  }
  const tagsBy = new Map<number, string[]>();
  for (const t of db
    .select({ contactId: contactTags.contactId, name: tags.name })
    .from(contactTags)
    .innerJoin(tags, eq(tags.id, contactTags.tagId))
    .where(inArray(contactTags.contactId, ids))
    .orderBy(asc(tags.name))
    .all()) {
    tagsBy.set(t.contactId, [...(tagsBy.get(t.contactId) ?? []), t.name]);
  }
  const out: CompactContact[] = [];
  for (const id of ids) {
    const c = byId.get(id);
    if (!c) continue;
    out.push({
      id: c.id,
      name: c.displayName,
      title: clip(c.title, 160),
      company: clip(c.company, 120),
      location: clip(c.location, 120),
      email: emailBy.get(c.id) ?? null,
      linkedin: linkedinBy.get(c.id) ?? null,
      tags: tagsBy.get(c.id) ?? [],
      starred: c.starred,
      archived: c.archivedAt !== null,
      lastInteractionAt: iso(c.lastInteractionAt),
      daysSinceLastInteraction: daysAgo(c.lastInteractionAt, now),
      keepInTouchEveryDays: c.cadenceDays,
      nextTouchAt: iso(c.nextTouchAt),
    });
  }
  return out;
}

// ---------- rolo_overview ----------

/** Tags and groups listed in the overview. 150 of each, with names cut to
 * 48 characters, is under half the answer cap whatever the owner named them. */
const OVERVIEW_LIST_MAX = 150;

const overview = defineTool({
  name: "rolo_overview",
  title: "Overview of the CRM",
  description:
    "Start here. Returns the current time and the owner's timezone, how many contacts there are and how complete their data is, every tag and group with its id and size, the custom fields, when each sync last ran, and whether a voice guide exists. Use the ids it returns in search_contacts.",
  scope: "read",
  input: z.strictObject({}),
  run: (_args, ctx) => {
    const active = "archived_at IS NULL";
    const tagCounts = new Map(
      (
        rawDb
          .prepare(
            `SELECT ct.tag_id AS id, count(*) AS n FROM contact_tags ct
             JOIN contacts c ON c.id = ct.contact_id WHERE c.${active} GROUP BY ct.tag_id`
          )
          .all() as { id: number; n: number }[]
      ).map((r) => [r.id, r.n])
    );
    const groupCounts = new Map(
      (
        rawDb
          .prepare(
            `SELECT gm.group_id AS id, count(*) AS n FROM group_members gm
             JOIN contacts c ON c.id = gm.contact_id WHERE c.${active} GROUP BY gm.group_id`
          )
          .all() as { id: number; n: number }[]
      ).map((r) => [r.id, r.n])
    );
    const lastRuns = rawDb
      .prepare(
        `SELECT kind, status, started_at AS startedAt, finished_at AS finishedAt FROM sync_runs
         WHERE id IN (SELECT max(id) FROM sync_runs GROUP BY kind) ORDER BY started_at DESC`
      )
      .all() as { kind: string; status: string; startedAt: number; finishedAt: number | null }[];
    const voice = readVoiceSettings();
    const total = count(`SELECT count(*) AS n FROM contacts WHERE ${active}`);
    const allTags = listTags();
    const allGroups = listGroups();
    return {
      summary: "Read the CRM overview",
      data: {
        now: iso(ctx.now),
        timezone: ownerTimezone(),
        contacts: {
          active: total,
          archived: count("SELECT count(*) AS n FROM contacts WHERE archived_at IS NOT NULL"),
          starred: count(`SELECT count(*) AS n FROM contacts WHERE ${active} AND starred = 1`),
          withEmail: count(
            `SELECT count(DISTINCT e.contact_id) AS n FROM contact_emails e JOIN contacts c ON c.id = e.contact_id WHERE c.${active}`
          ),
          withLinkedin: count(
            `SELECT count(DISTINCT s.contact_id) AS n FROM contact_socials s JOIN contacts c ON c.id = s.contact_id WHERE c.${active} AND s.platform = 'linkedin'`
          ),
          withCompany: count(`SELECT count(*) AS n FROM contacts WHERE ${active} AND company IS NOT NULL AND company <> ''`),
          withTitle: count(`SELECT count(*) AS n FROM contacts WHERE ${active} AND title IS NOT NULL AND title <> ''`),
          withLocation: count(`SELECT count(*) AS n FROM contacts WHERE ${active} AND location IS NOT NULL AND location <> ''`),
          onKeepInTouchCadence: count(`SELECT count(*) AS n FROM contacts WHERE ${active} AND cadence_days IS NOT NULL`),
          everInteractedWith: count(`SELECT count(*) AS n FROM contacts WHERE ${active} AND last_interaction_at IS NOT NULL`),
        },
        records: {
          interactions: count("SELECT count(*) AS n FROM interactions"),
          notes: count("SELECT count(*) AS n FROM notes WHERE body_md <> ''"),
          openReminders: count("SELECT count(*) AS n FROM reminders WHERE completed_at IS NULL AND rrule IS NULL"),
        },
        // Lists the owner grows by hand are capped so this answer can never
        // outgrow its size limit and lock the first call out; the counts
        // say when there are more.
        tagCount: allTags.length,
        tags: allTags.slice(0, OVERVIEW_LIST_MAX).map((t) => ({
          id: t.id,
          name: clip(t.name, 48),
          contacts: tagCounts.get(t.id) ?? 0,
        })),
        groupCount: allGroups.length,
        groups: allGroups.slice(0, OVERVIEW_LIST_MAX).map((g) => ({
          id: g.id,
          name: clip(g.name, 48),
          parentId: g.parentId,
          contacts: groupCounts.get(g.id) ?? 0,
        })),
        customFields: db
          .select({ id: customFields.id, name: customFields.name, kind: customFields.kind })
          .from(customFields)
          .orderBy(asc(customFields.sortOrder), asc(customFields.name))
          .limit(100)
          .all()
          .map((f) => ({ id: f.id, name: clip(f.name, 60), kind: f.kind })),
        lastSyncs: lastRuns.map((r) => ({
          kind: r.kind,
          status: r.status,
          at: iso(r.finishedAt ?? r.startedAt),
        })),
        voiceGuide: { exists: Boolean(voice.guide), writtenAt: iso(voice.generatedAt) },
        note: DATA_NOTE,
      },
    };
  },
});

// ---------- search_contacts ----------

const searchContactsTool = defineTool({
  name: "search_contacts",
  title: "Search contacts",
  description:
    "Find people. `query` is free text: every word must begin a word in the contact's name, company, title, location or bio (any order, case- and accent-insensitive; \"bank\" finds \"Banking\", \"ana\" does not find \"Managing\"); a query containing @ also matches email addresses. Fewer, more distinctive words find more. The other arguments narrow by structured facts and combine with AND. Returns compact rows — id, name, title, company, location, primary email, LinkedIn URL, tags, when the owner last interacted — plus the total number of matches; page with `offset`. Archived contacts are left out unless `includeArchived` is true. To see which employers exist before searching by one, use list_companies.",
  scope: "read",
  input: z.strictObject({
    query: z.string().trim().min(1).max(200).optional().describe("Free text: a name, a firm, a role, a city."),
    company: z.string().trim().min(1).max(200).optional().describe("Employer name contains this."),
    companyMode: z
      .enum(["current", "past", "ex", "any"])
      .optional()
      .describe("current (default) = works there now; past = worked there; ex = worked there and has left; any = now or before."),
    titleContains: z.string().trim().min(1).max(200).optional().describe("Current title contains this."),
    tagIds: idList(20).optional().describe("Has any of these tags (ids from rolo_overview)."),
    groupIds: idList(20).optional().describe("Is in any of these groups, sub-groups included."),
    lastInteractionBefore: dateArg.optional().describe("Last interaction earlier than this date."),
    lastInteractionAfter: dateArg.optional().describe("Last interaction on or after this date."),
    neverInteracted: z.boolean().optional().describe("true = only people with no recorded interaction."),
    starred: z.boolean().optional(),
    includeArchived: z.boolean().optional(),
    sort: z
      .enum(["relevance", "name", "company", "recentlyAdded", "lastInteraction"])
      .optional()
      .describe("relevance needs `query` and is its default; otherwise name."),
    limit: z.number().int().min(1).max(50).optional().describe("Default 25."),
    offset: z.number().int().min(0).max(100_000).optional(),
  }),
  run: (args, ctx) => {
    const clauses: FilterClause[] = [];
    if (args.company) {
      clauses.push({ dim: "company", mode: args.companyMode ?? "current", value: args.company });
    }
    if (args.titleContains) clauses.push({ dim: "titleContains", value: args.titleContains });
    if (args.tagIds) clauses.push({ dim: "tag", ids: args.tagIds });
    if (args.groupIds) clauses.push({ dim: "group", ids: args.groupIds });
    if (args.neverInteracted) clauses.push({ dim: "lastInteraction", op: "never" });
    if (args.lastInteractionBefore) {
      clauses.push({
        dim: "lastInteraction",
        op: "before",
        at: parseDate(args.lastInteractionBefore) ?? ctx.now,
      });
    }
    if (args.lastInteractionAfter) {
      clauses.push({
        dim: "lastInteraction",
        op: "after",
        at: parseDate(args.lastInteractionAfter) ?? 0,
      });
    }
    if (args.starred !== undefined) clauses.push({ dim: "starred", value: args.starred });
    const filter: FilterSet = { v: 1, clauses };
    const limit = args.limit ?? 25;
    const offset = args.offset ?? 0;
    const sortKey = args.sort ?? (args.query ? "relevance" : "name");
    const sort: SortSpec =
      sortKey === "company"
        ? { key: "company", dir: "asc" }
        : sortKey === "recentlyAdded"
          ? { key: "recent", dir: "desc" }
          : sortKey === "lastInteraction"
            ? { key: "lastInteraction", dir: "desc" }
            : { key: "name", dir: "asc" };

    // Ids only: the page is hydrated afterwards, so a network of any size
    // costs one indexed query and a slice.
    const runFiltered = (): { ids: number[]; warnings: string[] } =>
      filterContactIds(filter, { now: ctx.now, sort, includeArchived: args.includeArchived });

    let ids: number[];
    let warnings: string[] = [];
    let approximate = false;
    if (args.query) {
      // Text matches come back complete and best-first. They are narrowed
      // by the structured filters, and re-ordered only when a sort was
      // asked for.
      const found = findContactsPrecisely(args.query, { includeArchived: args.includeArchived });
      approximate = found.approximate;
      if (clauses.length === 0 && sortKey === "relevance") {
        ids = found.ids;
      } else {
        const filtered = runFiltered();
        warnings = filtered.warnings;
        if (sortKey === "relevance") {
          const allowed = new Set(filtered.ids);
          ids = found.ids.filter((id) => allowed.has(id));
        } else {
          const matched = new Set(found.ids);
          ids = filtered.ids.filter((id) => matched.has(id));
        }
      }
    } else {
      const filtered = runFiltered();
      ids = filtered.ids;
      warnings = filtered.warnings;
    }

    const page = compactContacts(ids.slice(offset, offset + limit), ctx.now);
    const parts = [
      args.query ? `"${clip(args.query, 40)}"` : null,
      args.company ? `company ${clip(args.company, 30)}` : null,
      args.titleContains ? `title ${clip(args.titleContains, 30)}` : null,
      args.tagIds ? "by tag" : null,
      args.groupIds ? "by group" : null,
    ].filter(Boolean);
    return {
      summary: `Searched contacts${parts.length ? ` — ${parts.join(", ")}` : ""} (${ids.length} found)`,
      shrink: "contacts",
      data: {
        total: ids.length,
        offset,
        returned: page.length,
        hasMore: offset + page.length < ids.length,
        ...(approximate && ids.length > 0
          ? { note: "Nothing matched exactly. These are names spelled nearly like the query — check before relying on them." }
          : {}),
        ...(warnings.length ? { warnings } : {}),
        contacts: page,
      },
    };
  },
});

// ---------- list_companies ----------

const listCompaniesTool = defineTool({
  name: "list_companies",
  title: "List employers",
  description:
    "The employers across the owner's active contacts, largest first: the company name as most contacts spell it, how many contacts work there now, other spellings folded in, and the titles seen most often. Use it to see which firms are in the network before searching — for example to pick out the banks, funds or firms worth a closer look. `query` keeps the companies whose name contains it. Follow up with search_contacts(company=...).",
  scope: "read",
  input: z.strictObject({
    query: z.string().trim().min(1).max(120).optional(),
    minContacts: z.number().int().min(1).max(10_000).optional().describe("Only companies with at least this many contacts. Default 1."),
    limit: z.number().int().min(1).max(200).optional().describe("Default 100."),
    offset: z.number().int().min(0).max(100_000).optional(),
  }),
  run: (args) => {
    const rows = db
      .select({ company: contacts.company, title: contacts.title })
      .from(contacts)
      .where(isNull(contacts.archivedAt))
      .all();
    let groupsOut = groupCompanies(rows);
    const distinct = groupsOut.length;
    if (args.query) groupsOut = filterCompanies(groupsOut, args.query);
    const min = args.minContacts ?? 1;
    if (min > 1) groupsOut = groupsOut.filter((g) => g.count >= min);
    const limit = args.limit ?? 100;
    const offset = args.offset ?? 0;
    const page = groupsOut.slice(offset, offset + limit);
    return {
      summary: `Listed employers${args.query ? ` matching "${clip(args.query, 40)}"` : ""} (${groupsOut.length})`,
      shrink: "companies",
      data: {
        distinctCompanies: distinct,
        total: groupsOut.length,
        offset,
        returned: page.length,
        hasMore: offset + page.length < groupsOut.length,
        companies: page.map((g) => ({
          company: clip(g.company, 120),
          contacts: g.count,
          ...(g.spellings.length > 1 ? { alsoSpelled: g.spellings.slice(1).map((s) => clip(s, 120)) } : {}),
          sampleTitles: g.sampleTitles.map((t) => clip(t, 100)),
        })),
      },
    };
  },
});

// ---------- get_contacts ----------

/** Text budgets shrink as more people are asked for at once. */
function budgets(n: number): { notes: number; noteChars: number; interactions: number; bodyChars: number } {
  if (n <= 2) return { notes: 6, noteChars: 1500, interactions: 15, bodyChars: 1200 };
  if (n <= 5) return { notes: 4, noteChars: 600, interactions: 10, bodyChars: 450 };
  return { notes: 3, noteChars: 300, interactions: 8, bodyChars: 220 };
}

function customFieldPairs(contactId: number): { field: string; value: string | number | string[] }[] {
  const rows = db
    .select({
      name: customFields.name,
      kind: customFields.kind,
      valueText: customFieldValues.valueText,
      valueNumber: customFieldValues.valueNumber,
      valueDate: customFieldValues.valueDate,
      valueJson: customFieldValues.valueJson,
    })
    .from(customFieldValues)
    .innerJoin(customFields, eq(customFields.id, customFieldValues.customFieldId))
    .where(eq(customFieldValues.contactId, contactId))
    .orderBy(asc(customFields.sortOrder), asc(customFields.name))
    .all();
  const out: { field: string; value: string | number | string[] }[] = [];
  for (const r of rows) {
    if (r.valueNumber !== null) out.push({ field: r.name, value: r.valueNumber });
    else if (r.valueDate !== null) out.push({ field: r.name, value: iso(r.valueDate) ?? "" });
    else if (r.valueJson) {
      try {
        const parsed: unknown = JSON.parse(r.valueJson);
        if (Array.isArray(parsed)) out.push({ field: r.name, value: parsed.map((v) => String(v).slice(0, 80)) });
      } catch {
        // an unreadable value is left out rather than guessed
      }
    } else if (r.valueText) out.push({ field: r.name, value: clip(r.valueText, 300) ?? "" });
  }
  return out;
}

function relatedPeople(contactId: number): { contactId: number; name: string; relationship: string }[] {
  const rows = db
    .select()
    .from(contactRelationships)
    .where(
      sql`${contactRelationships.contactAId} = ${contactId} OR ${contactRelationships.contactBId} = ${contactId}`
    )
    .limit(20)
    .all();
  if (rows.length === 0) return [];
  const otherIds = rows.map((r) => (r.contactAId === contactId ? r.contactBId : r.contactAId));
  const names = new Map(
    db
      .select({ id: contacts.id, name: contacts.displayName })
      .from(contacts)
      .where(inArray(contacts.id, otherIds))
      .all()
      .map((c) => [c.id, c.name])
  );
  return rows.map((r) => {
    const isA = r.contactAId === contactId;
    const other = isA ? r.contactBId : r.contactAId;
    // A directed edge reads "A <label> B" (SCHEMA.md).
    const relationship = !r.directed ? r.label : isA ? `${r.label} →` : `← ${r.label}`;
    return { contactId: other, name: names.get(other) ?? "Unknown", relationship };
  });
}

function fullContact(id: number, now: number, budget: ReturnType<typeof budgets>) {
  const detail = getContactDetail(id);
  if (!detail) return null;
  const c = detail.contact;
  const tagNames = new Map(listTags().map((t) => [t.id, t.name]));
  const groupNames = new Map(listGroups().map((g) => [g.id, g.name]));
  const timeline = getContactTimeline(id);
  const notes = timeline.filter((t) => t.type === "note" && t.note.bodyMd.trim() !== "");
  const exchanges = timeline.filter((t) => t.type === "interaction");
  const card = readProfileCard(id);
  const openReminders = db
    .select({ id: reminders.id, title: reminders.title, dueAt: reminders.dueAt })
    .from(reminders)
    .where(and(eq(reminders.contactId, id), isNull(reminders.completedAt), isNull(reminders.rrule)))
    .orderBy(asc(reminders.dueAt))
    .limit(10)
    .all();
  return {
    id: c.id,
    name: c.displayName,
    firstName: c.firstName,
    lastName: c.lastName,
    title: clip(c.title, 200),
    company: clip(c.company, 160),
    location: clip(c.location, 160),
    bio: clip(c.bio, 400),
    ownerDescription: clipBody(c.descriptionMd, budget.noteChars),
    birthday:
      c.birthdayMonth && c.birthdayDay
        ? `${c.birthdayYear ? `${c.birthdayYear}-` : ""}${String(c.birthdayMonth).padStart(2, "0")}-${String(c.birthdayDay).padStart(2, "0")}`
        : null,
    starred: c.starred,
    archived: c.archivedAt !== null,
    addedAt: iso(c.createdAt),
    emails: detail.emails.slice(0, 20).map((e) => ({ email: clip(e.email, 320), label: clip(e.label, 40) })),
    phones: detail.phones.slice(0, 20).map((p) => ({ phone: clip(p.phoneRaw, 40), label: clip(p.label, 40) })),
    links: detail.socials.slice(0, 20).map((s) => ({ platform: s.platform, url: clip(s.url, 400) })),
    tags: detail.tagIds
      .map((t) => tagNames.get(t))
      .filter((n): n is string => Boolean(n))
      .slice(0, 50),
    groups: getContactGroupIds(id)
      .map((g) => groupNames.get(g))
      .filter((n): n is string => Boolean(n))
      .slice(0, 50),
    customFields: customFieldPairs(id).slice(0, 40),
    workHistory: detail.workHistory.slice(0, 12).map((w) => ({
      company: clip(w.company, 120),
      title: clip(w.title, 120),
      from: w.startDate,
      to: w.endDate,
      current: w.isCurrent,
    })),
    education: detail.education.slice(0, 6).map((e) => ({
      school: clip(e.school, 120),
      degree: clip(e.degree, 80),
      field: clip(e.field, 80),
      from: e.startYear,
      to: e.endYear,
    })),
    keepInTouch: {
      everyDays: c.cadenceDays,
      lastInteractionAt: iso(c.lastInteractionAt),
      daysSinceLastInteraction: daysAgo(c.lastInteractionAt, now),
      nextTouchAt: iso(c.nextTouchAt),
      due: c.cadenceDays !== null && c.nextTouchAt !== null && c.nextTouchAt <= now,
      snoozedUntil: iso(c.snoozedUntil),
    },
    // Which source last set each field: "user" means the owner typed it.
    fieldSources: Object.fromEntries(
      Object.entries(detail.provenance).map(([field, p]) => [field, p.source])
    ),
    counts: { notes: notes.length, interactions: exchanges.length },
    notes: notes.slice(0, budget.notes).map((t) =>
      t.type === "note"
        ? {
            id: t.note.id,
            at: iso(t.at),
            text: clipBody(t.note.bodyMd, budget.noteChars),
            countsAsInteraction: t.note.countsForTouch,
            ...(t.mentionedOnly ? { filedUnderAnotherContact: true } : {}),
          }
        : null
    ),
    interactions: exchanges.slice(0, budget.interactions).map((t) =>
      t.type === "interaction"
        ? {
            id: t.interaction.id,
            at: iso(t.at),
            kind: t.interaction.kind,
            direction: t.interaction.direction,
            title: clip(t.interaction.title, 200),
            text: clipBody(bodyFromMeta(t.interaction.meta), budget.bodyChars),
            source: t.interaction.source,
          }
        : null
    ),
    openChanges: timeline
      .filter((t) => t.type === "change" && t.change.dismissedAt === null && t.change.actedAt === null)
      .slice(0, 5)
      .map((t) =>
        t.type === "change"
          ? {
              field: t.change.field,
              from: clip(t.change.oldValue, 160),
              to: clip(t.change.newValue, 160),
              detectedAt: iso(t.at),
            }
          : null
      ),
    openReminders: openReminders.map((r) => ({ id: r.id, title: clip(r.title, 200), dueAt: iso(r.dueAt) })),
    relatedPeople: relatedPeople(id),
    // Written by a model from the rows above; a summary, not a source.
    aiProfileCard:
      card && card.payload
        ? {
            summary: clip(card.payload.summary, 900),
            facts: (card.payload.facts ?? []).slice(0, 10).map((f) => ({
              label: clip(f.label, 60),
              value: clip(f.value, 200),
            })),
            relationship: card.payload.relationship
              ? { strength: card.payload.relationship.strength, why: clip(card.payload.relationship.why, 240) }
              : null,
            openQuestions: (card.payload.openQuestions ?? []).slice(0, 3).map((q) => clip(q, 200)),
            writtenAt: iso(card.updatedAt),
          }
        : null,
  };
}

const getContactsTool = defineTool({
  name: "get_contacts",
  title: "Read contact profiles",
  description:
    "Everything Rolo holds on up to 10 people: fields and where each came from, emails, phones, links, tags, groups, custom fields, work history, education, keep-in-touch state, the owner's notes, recent exchanges (with message text where Rolo has it — LinkedIn messages; email rows carry the subject only), open job changes and reminders, related people, and the AI-written profile card if one exists. Text is trimmed harder the more people are requested at once — ask for one or two when the wording of past messages matters, for example before drafting.",
  scope: "read",
  input: z.strictObject({ ids: idList(10).describe("Contact ids, from search_contacts or find_contact.") }),
  run: (args, ctx) => {
    const ids = [...new Set(args.ids)];
    const budget = budgets(ids.length);
    const found: NonNullable<ReturnType<typeof fullContact>>[] = [];
    const notFound: number[] = [];
    for (const id of ids) {
      const full = fullContact(id, ctx.now, budget);
      if (full) found.push(full);
      else notFound.push(id);
    }
    return {
      summary:
        found.length === 1
          ? `Read ${found[0].name}'s profile`
          : `Read ${found.length} profile${found.length === 1 ? "" : "s"}`,
      contactId: found.length === 1 ? found[0].id : null,
      shrink: "contacts",
      data: {
        note: DATA_NOTE,
        ...(notFound.length ? { notFound } : {}),
        contacts: found,
      },
    };
  },
});

// ---------- find_contact ----------

const findContactTool = defineTool({
  name: "find_contact",
  title: "Resolve a person",
  description:
    "Is this person already in Rolo? Give an email address, a LinkedIn profile URL, and/or a name. An email or LinkedIn match is exact and reliable (`certain: true`). A name alone is matched by similarity and returns candidates to choose from (`certain: false`) — never assume a name match is the same person without checking company or title. Use this before treating a correspondent as new.",
  scope: "read",
  input: z
    .strictObject({
      email: z.string().trim().email().max(320).optional(),
      linkedinUrl: z.string().trim().url().max(400).optional(),
      name: z.string().trim().min(1).max(200).optional(),
    })
    .refine((v) => v.email || v.linkedinUrl || v.name, "Give an email, a LinkedIn URL or a name."),
  run: (args, ctx) => {
    const matches: { id: number; matchedBy: string; certain: boolean }[] = [];
    const add = (id: number, matchedBy: string, certain: boolean) => {
      if (!matches.some((m) => m.id === id)) matches.push({ id, matchedBy, certain });
    };
    if (args.email) {
      const hit = matchContact({ emails: [{ email: args.email }], phones: [], socials: [] });
      if (hit) add(hit.contactId, "email", true);
    }
    if (args.linkedinUrl) {
      const hit = matchContact({
        emails: [],
        phones: [],
        socials: [{ platform: "linkedin", url: args.linkedinUrl }],
      });
      if (hit) add(hit.contactId, "linkedin", true);
    }
    if (args.name) {
      // Names only: a person is not "found" because the name appears in
      // someone's job title.
      const byName = findContactsPrecisely(args.name, { includeArchived: true, nameOnly: true });
      for (const hitId of byName.ids.slice(0, 5)) add(hitId, byName.approximate ? "similar name" : "name", false);
    }
    const rows = new Map(compactContacts(matches.map((m) => m.id), ctx.now).map((c) => [c.id, c]));
    const out = matches
      .map((m) => {
        const c = rows.get(m.id);
        return c ? { ...c, matchedBy: m.matchedBy, certain: m.certain } : null;
      })
      .filter((m): m is NonNullable<typeof m> => m !== null);
    const certain = out.filter((m) => m.certain);
    return {
      summary: certain.length
        ? `Resolved ${certain[0].name}`
        : `Looked for ${clip(args.name ?? args.email ?? args.linkedinUrl ?? "someone", 60)} (${out.length} candidate${out.length === 1 ? "" : "s"})`,
      contactId: certain.length === 1 ? certain[0].id : null,
      data: {
        found: certain.length > 0,
        ...(certain.length === 0 && out.length > 0
          ? { note: "Name matches only — candidates, not a confirmed identity." }
          : {}),
        matches: out,
      },
    };
  },
});

// ---------- get_timeline ----------

const TIMELINE_KINDS = ["note", "interaction", "change"] as const;

const getTimelineTool = defineTool({
  name: "get_timeline",
  title: "Read a timeline",
  description:
    "With `contactId`: that person's timeline, newest first — the owner's notes, exchanges (emails by subject, meetings, messages, logged interactions) and detected job changes — pageable, for when get_contacts' recent slice is not enough. Without `contactId`: the most recent exchanges across everyone, which answers \"who has the owner been in touch with lately\". `since` keeps entries on or after a date.",
  scope: "read",
  input: z.strictObject({
    contactId: z.number().int().positive().optional(),
    kinds: z.array(z.enum(TIMELINE_KINDS)).min(1).max(3).optional().describe("Per-contact only. Default: all three."),
    since: dateArg.optional(),
    limit: z.number().int().min(1).max(50).optional().describe("Default 20."),
    offset: z.number().int().min(0).max(100_000).optional(),
  }),
  run: (args) => {
    const limit = args.limit ?? 20;
    const offset = args.offset ?? 0;
    const since = args.since ? (parseDate(args.since) ?? 0) : 0;

    if (args.contactId === undefined) {
      const rows = db
        .select({
          id: interactions.id,
          contactId: interactions.contactId,
          name: contacts.displayName,
          kind: interactions.kind,
          direction: interactions.direction,
          title: interactions.title,
          occurredAt: interactions.occurredAt,
        })
        .from(interactions)
        .innerJoin(contacts, eq(contacts.id, interactions.contactId))
        .where(and(isNull(contacts.archivedAt), gte(interactions.occurredAt, since)))
        .orderBy(desc(interactions.occurredAt), desc(interactions.id))
        .limit(limit + 1)
        .offset(offset)
        .all();
      const page = rows.slice(0, limit);
      return {
        summary: `Read recent exchanges across contacts (${page.length})`,
        shrink: "entries",
        data: {
          note: DATA_NOTE,
          scope: "all contacts, exchanges only",
          offset,
          returned: page.length,
          hasMore: rows.length > limit,
          entries: page.map((r) => ({
            type: "interaction",
            id: r.id,
            contactId: r.contactId,
            contactName: r.name,
            at: iso(r.occurredAt),
            kind: r.kind,
            direction: r.direction,
            title: clip(r.title, 200),
          })),
        },
      };
    }

    const person = db
      .select({ id: contacts.id, name: contacts.displayName })
      .from(contacts)
      .where(eq(contacts.id, args.contactId))
      .get();
    if (!person) throw new ToolRefusal(`There is no contact with id ${args.contactId}.`);
    const kinds = new Set<string>(args.kinds ?? TIMELINE_KINDS);
    const all = getContactTimeline(args.contactId)
      .filter((t) => kinds.has(t.type) && t.at >= since)
      .filter((t) => t.type !== "note" || t.note.bodyMd.trim() !== "");
    const page = all.slice(offset, offset + limit);
    return {
      summary: `Read ${person.name}'s timeline (${page.length} of ${all.length})`,
      contactId: person.id,
      shrink: "entries",
      data: {
        note: DATA_NOTE,
        contactId: person.id,
        contactName: person.name,
        total: all.length,
        offset,
        returned: page.length,
        hasMore: offset + page.length < all.length,
        entries: page.map((t) => {
          if (t.type === "note") {
            return {
              type: "note",
              id: t.note.id,
              at: iso(t.at),
              text: clipBody(t.note.bodyMd, 900),
              countsAsInteraction: t.note.countsForTouch,
            };
          }
          if (t.type === "interaction") {
            return {
              type: "interaction",
              id: t.interaction.id,
              at: iso(t.at),
              kind: t.interaction.kind,
              direction: t.interaction.direction,
              title: clip(t.interaction.title, 200),
              text: clipBody(bodyFromMeta(t.interaction.meta), 900),
              source: t.interaction.source,
            };
          }
          return {
            type: "change",
            id: t.change.id,
            at: iso(t.at),
            field: t.change.field,
            from: clip(t.change.oldValue, 160),
            to: clip(t.change.newValue, 160),
            open: t.change.dismissedAt === null && t.change.actedAt === null,
          };
        }),
      },
    };
  },
});

// ---------- search_notes ----------

const searchNotesTool = defineTool({
  name: "search_notes",
  title: "Search the owner's notes",
  description:
    "Full-text search over everything the owner has written in notes. Returns the matching passage and the contact it is about — the way to find people by what the owner knows about them rather than by their job title (\"who mentioned a fundraise\", \"who did I meet at the conference\").",
  scope: "read",
  input: z.strictObject({
    query: z.string().trim().min(1).max(200),
    limit: z.number().int().min(1).max(25).optional().describe("Default 10."),
  }),
  run: (args) => {
    const hits = searchNotes(args.query, args.limit ?? 10);
    return {
      summary: `Searched notes for "${clip(args.query, 40)}" (${hits.length})`,
      shrink: "matches",
      data: {
        note: DATA_NOTE,
        returned: hits.length,
        matches: hits.map((h) => ({
          noteId: h.noteId,
          contactId: h.contactId,
          contactName: h.contactName,
          passage: clip(h.snippet, 400),
        })),
      },
    };
  },
});

// ---------- get_today ----------

const getTodayTool = defineTool({
  name: "get_today",
  title: "What needs attention today",
  description:
    "What Rolo's Today page shows right now: reminders due, today's meetings with the contacts in them, meetings that just ended and await a debrief, people whose keep-in-touch cadence is due (most overdue first), open job changes worth a message, birthdays this week, and the day's \"worth reconnecting\" picks. Lists are capped; each carries its true total.",
  scope: "read",
  input: z.strictObject({}),
  run: (_args, ctx) => {
    const today = getTodayData(ctx.now);
    const changes = today.changes.filter((c) => !c.lowSignal);
    return {
      summary: "Read Today",
      data: {
        note: DATA_NOTE,
        now: iso(ctx.now),
        timezone: today.timezone,
        remindersDue: {
          total: today.reminders.length,
          items: today.reminders.slice(0, 30).map((r) => ({
            id: r.id,
            title: clip(r.title, 200),
            dueAt: iso(r.dueAt),
            contactId: r.contactId,
            contactName: r.contactName,
          })),
        },
        meetingsToday: {
          total: today.agenda.length,
          items: today.agenda.slice(0, 15).map((a) => ({
            title: clip(a.summary, 200),
            startsAt: iso(a.startsAt),
            endsAt: iso(a.endsAt),
            allDay: a.allDay,
            attendees: a.attendees.slice(0, 12).map((p) => ({
              name: clip(p.name, 80),
              email: p.email,
              contactId: p.contactId,
            })),
          })),
        },
        awaitingDebrief: today.followups.slice(0, 10).map((f) => ({
          title: clip(f.summary, 200),
          endedAt: iso(f.endsAt ?? f.startsAt),
          contacts: f.contacts.map((p) => ({ contactId: p.contactId, name: p.name })),
        })),
        keepInTouchDue: {
          total: today.dueContacts.length,
          items: today.dueContacts.slice(0, 40).map((d) => ({
            contactId: d.contactId,
            name: d.displayName,
            title: clip(d.title, 120),
            company: clip(d.company, 100),
            daysOverdue: d.daysOverdue,
            starred: d.starred,
            email: d.primaryEmail,
          })),
        },
        jobChanges: {
          total: changes.length,
          items: changes.slice(0, 25).map((c) => ({
            changeId: c.id,
            contactId: c.contactId,
            name: c.contactName,
            field: c.field,
            from: clip(c.oldValue, 140),
            to: clip(c.newValue, 140),
            detectedAt: iso(c.detectedAt),
            ...(c.triage?.reason ? { whyReachOut: clip(c.triage.reason, 200) } : {}),
          })),
        },
        birthdaysThisWeek: today.birthdays.slice(0, 15).map((b) => ({
          contactId: b.contactId,
          name: b.displayName,
          inDays: b.daysUntil,
          turns: b.turns,
        })),
        worthReconnecting: today.resurface.map((p) => ({
          contactId: p.contactId,
          name: p.displayName,
          title: clip(p.title, 120),
          company: clip(p.company, 100),
          lastInteractionAt: iso(p.lastInteractionAt),
          interactions: p.interactionCount,
        })),
      },
    };
  },
});

// ---------- get_voice_guide ----------

const getVoiceGuideTool = defineTool({
  name: "get_voice_guide",
  title: "The owner's writing voice",
  description:
    "How the owner writes: the style guide Rolo keeps (if one has been written) and up to 12 messages the owner actually sent on LinkedIn, newest first. Read it before drafting anything in the owner's name. It reflects LinkedIn messages; for the format of the owner's emails, read their sent mail through the mail connector.",
  scope: "read",
  input: z.strictObject({}),
  run: () => {
    const voice = readVoiceSettings();
    const sent = outboundSnippets(12);
    return {
      summary: "Read the voice guide",
      data: {
        ownerName: voice.ownerName,
        guide: clipBody(voice.guide, 4000),
        guideWrittenAt: iso(voice.generatedAt),
        examplesTheOwnerPasted: clipBody(voice.examples, 4000),
        sentMessages: sent.map((s) => clipBody(s, 700)),
        ...(voice.guide || sent.length || voice.examples
          ? {}
          : { note: "No voice guide and no sent messages yet — write in a plain, neutral register and say so." }),
      },
    };
  },
});

const READ_TOOLS: AgentTool[] = [
  overview,
  searchContactsTool,
  listCompaniesTool,
  getContactsTool,
  findContactTool,
  getTimelineTool,
  searchNotesTool,
  getTodayTool,
  getVoiceGuideTool,
];

export const AGENT_TOOLS: AgentTool[] = [...READ_TOOLS, ...WRITE_TOOLS];

// ---------- dispatch ----------

export type ToolCallResult = { isError: boolean; text: string };

/**
 * How an agent's writes land (Settings → Claude connector). `apply`: at
 * once, attributed and undoable — the owner's chosen default. `review`:
 * each one waits on the activity page until the owner approves it.
 */
export type AgentWriteMode = "apply" | "review";
export const AGENT_WRITE_MODE_KEY = "agent.write_mode";

export function agentWriteMode(): AgentWriteMode {
  return getSetting<string>(AGENT_WRITE_MODE_KEY) === "review" ? "review" : "apply";
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`)
    .join("; ");
}

function subjectOf(args: unknown): number | null {
  const id = (args as { contactId?: unknown } | null)?.contactId;
  return typeof id === "number" && Number.isInteger(id) && id > 0 ? id : null;
}

function keyOf(args: unknown): string | null {
  const key = (args as { idempotencyKey?: unknown } | null)?.idempotencyKey;
  return typeof key === "string" && key ? key : null;
}

type Outcome =
  | { ok: true; text: string }
  | { ok: false; kind: "refused" | "error"; message: string };

/**
 * Run a write tool and ledger it as one unit: if the tool throws half way
 * through (several tags, a note beside an interaction), nothing it did
 * stays, and no "success" row claims otherwise.
 */
function executeWrite(
  tool: AgentTool,
  args: unknown,
  now: number,
  ledger: (out: ToolOutput) => number
): Outcome {
  try {
    const text = db.transaction(() => {
      const out = tool.execute(args, { now });
      const actionId = ledger(out);
      return serializeCapped({ ...out.data, actionId }, out.shrink);
    });
    return { ok: true, text };
  } catch (err) {
    if (err instanceof ToolRefusal) return { ok: false, kind: "refused", message: err.message };
    return { ok: false, kind: "error", message: err instanceof Error ? err.message : "Unknown error" };
  }
}

const FAILED = JSON.stringify({ error: "The tool failed inside Rolo. Nothing was changed." });

/**
 * Run one tool call end to end: scope check, validation, execution, size
 * cap, and the `agent_calls` row that records it. Errors come back as text
 * the model can act on, never as a thrown exception.
 */
export function callAgentTool(
  name: string,
  rawArgs: unknown,
  caller: { grantId: number | null; scopes: string[]; now?: number }
): ToolCallResult {
  const started = Date.now();
  const now = caller.now ?? started;
  const tool = AGENT_TOOLS.find((t) => t.name === name);
  const log = (
    status: "success" | "error" | "refused",
    extra: { summary?: string; error?: string; contactId?: number | null; args?: unknown }
  ) =>
    recordAgentCall({
      grantId: caller.grantId,
      tool: name.slice(0, 64),
      args: extra.args ?? rawArgs,
      status,
      summary: extra.summary,
      error: extra.error,
      contactId: extra.contactId,
      durationMs: Date.now() - started,
      now: started,
    });

  if (!tool) {
    log("refused", { error: "Unknown tool.", args: {} });
    return { isError: true, text: JSON.stringify({ error: `There is no tool named ${name.slice(0, 64)}.` }) };
  }
  if (!caller.scopes.includes(tool.scope)) {
    log("refused", { error: `Needs the ${tool.scope} scope.`, args: {} });
    return {
      isError: true,
      text: JSON.stringify({
        error:
          tool.scope === "write"
            ? `This connection is read-only, so ${tool.name} is not available. The owner can reconnect Rolo and allow changes.`
            : `This connection is not allowed to use ${tool.name} (it needs "${tool.scope}" access).`,
      }),
    };
  }
  const parsed = tool.input.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const problem = describeIssues(parsed.error);
    log("refused", { error: problem });
    return { isError: true, text: JSON.stringify({ error: `Invalid arguments — ${problem}` }) };
  }

  if (!tool.mutates) {
    try {
      const out = tool.execute(parsed.data, { now });
      const text = serializeCapped(out.data, out.shrink);
      log("success", { summary: out.summary, contactId: out.contactId, args: parsed.data });
      return { isError: false, text };
    } catch (err) {
      if (err instanceof ToolRefusal) {
        log("refused", { error: err.message, args: parsed.data });
        return { isError: true, text: JSON.stringify({ error: err.message }) };
      }
      // What broke goes in the ledger for the owner; the caller only learns
      // that it did, since an internal message is no use to a model.
      const message = err instanceof Error ? err.message : "Unknown error";
      log("error", { error: message, args: parsed.data });
      return { isError: true, text: FAILED };
    }
  }

  // ----- a write -----

  // The same key again, about the same person: answered from the ledger,
  // nothing run. Also true when the owner undid the first one — a retry
  // must not put back what they took out.
  const given = keyOf(parsed.data);
  const key = given ? ledgerKey(given, subjectOf(parsed.data)) : null;
  if (key) {
    const prior = findCallByKey(tool.name, key);
    if (prior) {
      return {
        isError: false,
        text: JSON.stringify(
          prior.status === "queued"
            ? { queued: true, actionId: prior.id, note: "This is already waiting for the owner's approval in Rolo." }
            : prior.status === "rejected"
              ? {
                  rejected: true,
                  actionId: prior.id,
                  note: "The owner turned this down in Rolo. Nothing was changed; do not propose it again unless they ask.",
                }
              : prior.undoneAt !== null
                ? {
                    alreadyDone: true,
                    undone: true,
                    actionId: prior.id,
                    note: "This was done earlier and then undone. It was not repeated; use a new idempotencyKey only if the owner asks for it again.",
                  }
                : { alreadyDone: true, actionId: prior.id, summary: prior.summary }
        ),
      };
    }
  }

  if (agentWriteMode() === "review" && tool.name !== "undo_agent_action") {
    const actionId = recordAgentCall({
      grantId: caller.grantId,
      tool: tool.name,
      args: parsed.data,
      status: "queued",
      summary: `Proposed: ${tool.title.toLowerCase()}`,
      contactId: subjectOf(parsed.data),
      idempotencyKey: key,
      now: started,
    });
    return {
      isError: false,
      text: JSON.stringify({
        queued: true,
        actionId,
        note: "The owner reviews changes before they apply. Nothing has changed yet: this is waiting on Rolo's activity page. Tell the owner it is there.",
      }),
    };
  }

  const outcome = executeWrite(tool, parsed.data, now, (out) =>
    recordAgentCall({
      grantId: caller.grantId,
      tool: tool.name,
      args: parsed.data,
      status: "success",
      summary: out.summary,
      contactId: out.contactId,
      writes: out.writes ?? [],
      // A call that changed nothing — a duplicate, a question back to the
      // caller — must not use up its key: the corrected retry needs it.
      idempotencyKey: (out.writes ?? []).length > 0 ? key : null,
      durationMs: Date.now() - started,
      now: started,
    })
  );
  if (outcome.ok) return { isError: false, text: outcome.text };
  log(outcome.kind, { error: outcome.message, args: parsed.data, contactId: subjectOf(parsed.data) });
  return {
    isError: true,
    text: outcome.kind === "refused" ? JSON.stringify({ error: outcome.message }) : FAILED,
  };
}

// ---------- the review queue ----------

export type QueueDecision = { ok: true; summary: string | null } | { ok: false; error: string };

/** The owner said yes: run the proposal exactly as it was made. */
export function approveQueuedCall(callId: number, now = Date.now()): QueueDecision {
  const call = db.select().from(agentCalls).where(eq(agentCalls.id, callId)).get();
  if (!call || call.status !== "queued") return { ok: false, error: "That proposal is no longer waiting." };
  const tool = AGENT_TOOLS.find((t) => t.name === call.tool && t.mutates);
  const fail = (error: string): QueueDecision => {
    db.update(agentCalls)
      .set({ status: "refused", error: error.slice(0, 500), idempotencyKey: null })
      .where(eq(agentCalls.id, callId))
      .run();
    return { ok: false, error };
  };
  if (!tool) return fail("The tool this proposal used no longer exists.");
  let args: unknown;
  try {
    args = JSON.parse(call.argsJson);
  } catch {
    return fail("The proposal could not be read back.");
  }
  const parsed = tool.input.safeParse(args);
  if (!parsed.success) return fail(`The proposal is no longer valid — ${describeIssues(parsed.error)}`);
  let summary: string | null = null;
  const outcome = executeWrite(tool, parsed.data, now, (out) => {
    summary = out.summary;
    db.update(agentCalls)
      .set({
        status: "success",
        summary: out.summary.slice(0, 200),
        contactId: out.contactId ?? call.contactId,
        writesJson: JSON.stringify(out.writes ?? []),
        idempotencyKey: (out.writes ?? []).length > 0 ? call.idempotencyKey : null,
        error: null,
      })
      .where(eq(agentCalls.id, callId))
      .run();
    return callId;
  });
  if (!outcome.ok) return fail(outcome.kind === "refused" ? outcome.message : "It failed inside Rolo; nothing was changed.");
  return { ok: true, summary };
}

/** The owner said no. The row stays, marked, so the log shows what was proposed. */
export function rejectQueuedCall(callId: number): boolean {
  return (
    db
      .update(agentCalls)
      .set({ status: "rejected" })
      .where(and(eq(agentCalls.id, callId), eq(agentCalls.status, "queued")))
      .run().changes > 0
  );
}
