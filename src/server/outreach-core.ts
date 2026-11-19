import "server-only";

import { and, asc, desc, eq, gt, gte, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  calendarEvents,
  contactEmails,
  contacts,
  contactTags,
  groupMembers,
  groups,
  interactions,
  outreachDrafts,
  reminders,
  tags,
  whatsappLinks,
  whatsappMessages,
} from "@/db/schema";
import { normalizeSubject } from "@/lib/agent/writes";
import {
  DRAFT_BODY_MAX,
  DRAFT_KINDS,
  DRAFT_SUBJECT_MAX,
  isEmailAddress,
  type DraftKind,
} from "@/lib/outreach/compose";
import {
  BAD_ADDRESS_TAG,
  DAY_MS,
  DEFAULT_DORMANT_AFTER_DAYS,
  DEFAULT_NUDGE_AFTER_DAYS,
  deriveStage,
  NOT_PURSUING_TAG,
  STAGES,
  type OutreachEvent,
  type Stage,
  type StageResult,
} from "@/lib/outreach/stage";
import { getSetting, ownerTimezone, setSetting } from "@/lib/settings";
import { fromFakeUtc } from "@/lib/time";
import { agentCallReminders } from "@/server/agent/ledger";
import { recordInteraction } from "@/server/interaction-core";

// Outreach (SPEC §16). No session and no page cache: the pages' actions
// and the agent connector both call this module. (Plain module, not "use
// server" — CLAUDE.md.)
//
// Three ideas hold it together:
//   1. A campaign is a group plus a brief. Who is in it is group
//      membership; nothing else is stored per person.
//   2. Where each person stands is derived from the timeline every time
//      it is asked for. There is no stage column to drift or to drag.
//   3. A draft is for the owner to send. Rolo never sends mail; a draft
//      ends when the owner says it went, or discards it.

type CoreError = { ok: false; error: string };

// ---------- settings ----------

export type OutreachSettings = { nudgeAfterDays: number; dormantAfterDays: number; bcc: string | null };

export function outreachSettings(): OutreachSettings {
  const nudge = getSetting<number>("outreach.nudge_after_days");
  const dormant = getSetting<number>("outreach.dormant_after_days");
  const bcc = getSetting<string>("outreach.bcc");
  return {
    nudgeAfterDays: Number.isInteger(nudge) && (nudge as number) >= 1 ? (nudge as number) : DEFAULT_NUDGE_AFTER_DAYS,
    dormantAfterDays: Number.isInteger(dormant) && (dormant as number) >= 2 ? (dormant as number) : DEFAULT_DORMANT_AFTER_DAYS,
    bcc: isEmailAddress(bcc) ? bcc : null,
  };
}

export function saveOutreachSettings(input: { nudgeAfterDays: number; dormantAfterDays: number; bcc: string }): { ok: true } | CoreError {
  if (!Number.isInteger(input.nudgeAfterDays) || input.nudgeAfterDays < 1 || input.nudgeAfterDays > 60) {
    return { ok: false, error: "Follow-up after: between 1 and 60 days." };
  }
  if (!Number.isInteger(input.dormantAfterDays) || input.dormantAfterDays <= input.nudgeAfterDays || input.dormantAfterDays > 365) {
    return { ok: false, error: "\"No reply\" after: more days than the follow-up, at most 365." };
  }
  const bcc = input.bcc.trim();
  if (bcc && !isEmailAddress(bcc)) return { ok: false, error: "The BCC address is not an email address." };
  setSetting("outreach.nudge_after_days", input.nudgeAfterDays);
  setSetting("outreach.dormant_after_days", input.dormantAfterDays);
  setSetting("outreach.bcc", bcc);
  return { ok: true };
}

// ---------- campaigns ----------

export const CAMPAIGN_GOAL_MAX = 200;
export const CAMPAIGN_BRIEF_MAX = 8000;
const CAMPAIGNS_KEY = "outreach.campaigns";

type CampaignRecord = {
  goal: string;
  briefMd: string;
  startedAt: number;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  /** Strictly increasing per campaign: which save an undo is undoing. */
  marker: number;
  /** The goal, brief and start before the last save, so that save can be undone. */
  prev: { goal: string; briefMd: string; startedAt?: number } | null;
  /**
   * The group's own created_at. SQLite hands a deleted group's id to the
   * next one made, so the id alone does not say this brief belongs to it.
   */
  groupCreatedAt?: number;
};

function readCampaigns(): Record<string, CampaignRecord> {
  const stored = getSetting<Record<string, CampaignRecord>>(CAMPAIGNS_KEY);
  return stored && typeof stored === "object" ? stored : {};
}

/** Whether a stored brief belongs to this group, and not to an earlier one that had its id. */
function isSameGroup(record: CampaignRecord | undefined, group: { createdAt: number } | undefined): boolean {
  if (!record || !group) return false;
  return record.groupCreatedAt === undefined || record.groupCreatedAt === group.createdAt;
}

/** "2026-11-03" as the first moment of that day where the owner is. */
export function startOfLocalDay(dateKey: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey.trim());
  if (!m) return null;
  const fake = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (new Date(fake).getUTCDate() !== Number(m[3])) return null;
  return fromFakeUtc(ownerTimezone(), fake);
}

export type Campaign = CampaignRecord & { groupId: number; name: string };

/** Every campaign whose group still exists, newest first. */
export function listCampaignRecords(): Campaign[] {
  const stored = readCampaigns();
  const ids = Object.keys(stored).map(Number).filter(Number.isInteger);
  if (ids.length === 0) return [];
  const found = new Map(
    db.select({ id: groups.id, name: groups.name, createdAt: groups.createdAt }).from(groups).where(inArray(groups.id, ids)).all().map((g) => [g.id, g])
  );
  return ids
    .filter((id) => isSameGroup(stored[String(id)], found.get(id)))
    .map((id) => ({ ...stored[String(id)], groupId: id, name: found.get(id)!.name }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function getCampaign(groupId: number): Campaign | null {
  return listCampaignRecords().find((c) => c.groupId === groupId) ?? null;
}

export type SaveCampaignResult =
  | { ok: true; groupId: number; name: string; createdGroup: boolean; createdCampaign: boolean; marker: number }
  | CoreError;

/**
 * Create a campaign, or change its goal and brief. With `groupId` it
 * turns an existing group into a campaign (or updates one); without, it
 * makes a new group called `name`.
 */
export function saveCampaign(
  input: { groupId?: number; name?: string; goal: string; briefMd?: string; startedAt?: number },
  now = Date.now()
): SaveCampaignResult {
  const goal = input.goal.replace(/\s+/g, " ").trim();
  if (!goal) return { ok: false, error: "A campaign needs a goal: one line saying what it is for." };
  if (goal.length > CAMPAIGN_GOAL_MAX) return { ok: false, error: `The goal is longer than ${CAMPAIGN_GOAL_MAX} characters.` };
  const briefMd = (input.briefMd ?? "").trim();
  if (briefMd.length > CAMPAIGN_BRIEF_MAX) return { ok: false, error: `The brief is longer than ${CAMPAIGN_BRIEF_MAX} characters.` };
  if (input.startedAt !== undefined && (!Number.isInteger(input.startedAt) || input.startedAt > now + DAY_MS)) {
    return { ok: false, error: "A campaign cannot start in the future." };
  }
  return db.transaction((): SaveCampaignResult => {
    let groupId = input.groupId;
    let name: string;
    let createdGroup = false;
    let groupCreatedAt = now;
    if (groupId !== undefined) {
      const group = db.select({ id: groups.id, name: groups.name, createdAt: groups.createdAt }).from(groups).where(eq(groups.id, groupId)).get();
      if (!group) return { ok: false, error: `There is no group with id ${groupId}.` };
      name = group.name;
      groupCreatedAt = group.createdAt;
    } else {
      name = (input.name ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
      if (!name) return { ok: false, error: "A new campaign needs a name." };
      const taken = db.select({ id: groups.id }).from(groups).where(sql`lower(${groups.name}) = ${name.toLowerCase()}`).get();
      if (taken) {
        return { ok: false, error: `A group called "${name}" already exists (id ${taken.id}). Pass its id to make it a campaign, or choose another name.` };
      }
      groupId = db.insert(groups).values({ name, createdAt: now }).returning({ id: groups.id }).get().id;
      createdGroup = true;
    }
    const all = readCampaigns();
    // A brief left behind by a deleted group that had this id is not this group's.
    const stored = all[String(groupId)];
    const existing = isSameGroup(stored, { createdAt: groupCreatedAt }) ? stored : undefined;
    const marker = Math.max(now, (stored?.marker ?? 0) + 1);
    all[String(groupId)] = {
      goal,
      briefMd,
      startedAt: input.startedAt ?? existing?.startedAt ?? now,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      archivedAt: existing?.archivedAt ?? null,
      marker,
      prev: existing ? { goal: existing.goal, briefMd: existing.briefMd, startedAt: existing.startedAt } : null,
      groupCreatedAt,
    };
    setSetting(CAMPAIGNS_KEY, all);
    return { ok: true, groupId, name, createdGroup, createdCampaign: !existing, marker };
  });
}

/** Take back one save: the previous goal and brief, or no campaign at all. */
export function undoCampaignSave(
  groupId: number,
  marker: number,
  made: { createdGroup: boolean; createdCampaign: boolean; groupName: string }
): { ok: true; what: string } | CoreError {
  const all = readCampaigns();
  const record = all[String(groupId)];
  const group = db.select({ name: groups.name, createdAt: groups.createdAt }).from(groups).where(eq(groups.id, groupId)).get();
  if (!record || !isSameGroup(record, group)) return { ok: false, error: "the campaign no longer exists" };
  if (record.marker !== marker) return { ok: false, error: "the campaign has been changed since, so it was left as it is" };
  if (!made.createdCampaign) {
    if (!record.prev) return { ok: false, error: "there is no earlier version of the campaign to return to" };
    all[String(groupId)] = {
      ...record,
      goal: record.prev.goal,
      briefMd: record.prev.briefMd,
      startedAt: record.prev.startedAt ?? record.startedAt,
      prev: null,
      marker: marker + 1,
    };
    setSetting(CAMPAIGNS_KEY, all);
    return { ok: true, what: "put the campaign's previous goal and brief back" };
  }
  delete all[String(groupId)];
  setSetting(CAMPAIGNS_KEY, all);
  if (!made.createdGroup) return { ok: true, what: "removed the campaign (its group was kept)" };
  // The group goes only while it is still the empty group this call made.
  const members = db.select({ n: sql<number>`count(*)` }).from(groupMembers).where(eq(groupMembers.groupId, groupId)).get()?.n ?? 0;
  if (group && group.name === made.groupName && members === 0) {
    db.delete(groups).where(eq(groups.id, groupId)).run();
    return { ok: true, what: "removed the campaign and its group" };
  }
  return { ok: true, what: "removed the campaign (its group has members, so it was kept)" };
}

export function setCampaignArchived(groupId: number, archived: boolean, now = Date.now()): { ok: true } | CoreError {
  const all = readCampaigns();
  const record = all[String(groupId)];
  if (!record) return { ok: false, error: "That campaign no longer exists." };
  all[String(groupId)] = { ...record, archivedAt: archived ? now : null, updatedAt: now };
  setSetting(CAMPAIGNS_KEY, all);
  return { ok: true };
}

// ---------- where each person stands ----------

export type PipelineMember = {
  contactId: number;
  name: string;
  title: string | null;
  company: string | null;
  email: string | null;
  openDraftId: number | null;
  callAt: number | null;
} & StageResult;

function tagIdsByName(names: string[]): number[] {
  return db
    .select({ id: tags.id })
    .from(tags)
    .where(inArray(sql`lower(${tags.name})`, names))
    .all()
    .map((t) => t.id);
}

/**
 * Everything the stage rule needs, for a set of contacts, in a handful of
 * queries. Read fresh every time: this is the whole of "the pipeline".
 */
export function stagesFor(contactIds: number[], campaign: { groupId: number | null; startedAt: number }, now: number): Map<number, StageResult & { openDraftId: number | null; callAt: number | null }> {
  const out = new Map<number, StageResult & { openDraftId: number | null; callAt: number | null }>();
  if (contactIds.length === 0) return out;
  const settings = outreachSettings();
  const events = new Map<number, OutreachEvent[]>();
  const push = (contactId: number, event: OutreachEvent) => {
    const list = events.get(contactId) ?? [];
    list.push(event);
    events.set(contactId, list);
  };

  // WhatsApp is read message by message for linked people: its timeline
  // rows are one per day, which cannot say who wrote last that day.
  for (const m of db
    .select({ contactId: whatsappLinks.contactId, direction: whatsappMessages.direction, sentAt: whatsappMessages.sentAt, kind: whatsappMessages.kind })
    .from(whatsappMessages)
    .innerJoin(whatsappLinks, eq(whatsappLinks.id, whatsappMessages.linkId))
    .where(and(inArray(whatsappLinks.contactId, contactIds), inArray(whatsappMessages.kind, ["text", "media"])))
    .all()) {
    push(m.contactId, { at: m.sentAt, kind: m.direction === "outbound" ? "sent" : "received" });
  }
  for (const i of db
    .select({ contactId: interactions.contactId, kind: interactions.kind, direction: interactions.direction, occurredAt: interactions.occurredAt, source: interactions.source })
    .from(interactions)
    .where(inArray(interactions.contactId, contactIds))
    .all()) {
    if (i.source === "whatsapp") continue;
    if (i.kind === "email" || i.kind === "message") {
      if (i.direction === "outbound") push(i.contactId, { at: i.occurredAt, kind: "sent" });
      else if (i.direction === "inbound") push(i.contactId, { at: i.occurredAt, kind: "received" });
    } else if (i.kind === "meeting" || i.kind === "manual") {
      push(i.contactId, { at: i.occurredAt, kind: "met" });
    }
  }

  // A call still to come: a calendar event with them in it, or a reminder
  // the agent set for a call it saw being arranged.
  const callAt = new Map<number, number>();
  const sooner = (contactId: number, at: number) => {
    const have = callAt.get(contactId);
    if (have === undefined || at < have) callAt.set(contactId, at);
  };
  const wanted = new Set(contactIds);
  for (const e of db
    .select({ startsAt: calendarEvents.startsAt, attendees: calendarEvents.attendees, status: calendarEvents.status })
    .from(calendarEvents)
    .where(gt(calendarEvents.startsAt, now))
    .all()) {
    if (e.status === "cancelled") continue;
    try {
      for (const a of JSON.parse(e.attendees ?? "[]") as { contactId?: number | null }[]) {
        if (typeof a.contactId === "number" && wanted.has(a.contactId)) sooner(a.contactId, e.startsAt);
      }
    } catch {
      // An unreadable attendee list books nobody.
    }
  }
  const callReminders = agentCallReminders();
  if (callReminders.size > 0) {
    for (const r of db
      .select({ id: reminders.id, contactId: reminders.contactId, dueAt: reminders.dueAt, createdAt: reminders.createdAt })
      .from(reminders)
      .where(and(inArray(reminders.id, [...callReminders.keys()]), isNull(reminders.completedAt), gt(reminders.dueAt, now)))
      .all()) {
      if (r.contactId !== null && wanted.has(r.contactId) && callReminders.get(r.id) === r.createdAt) sooner(r.contactId, r.dueAt);
    }
  }

  const flagged = (name: string): Set<number> => {
    const ids = tagIdsByName([name]);
    if (ids.length === 0) return new Set();
    return new Set(
      db
        .select({ contactId: contactTags.contactId })
        .from(contactTags)
        .where(and(inArray(contactTags.tagId, ids), inArray(contactTags.contactId, contactIds)))
        .all()
        .map((r) => r.contactId)
    );
  };
  const notPursuing = flagged(NOT_PURSUING_TAG);
  const badAddress = flagged(BAD_ADDRESS_TAG);

  const openDraft = new Map<number, number>();
  for (const d of db
    .select({ id: outreachDrafts.id, contactId: outreachDrafts.contactId, groupId: outreachDrafts.groupId })
    .from(outreachDrafts)
    .where(and(eq(outreachDrafts.status, "open"), inArray(outreachDrafts.contactId, contactIds)))
    .orderBy(asc(outreachDrafts.id))
    .all()) {
    // A draft belongs to its campaign; one with no campaign counts for any.
    if (d.groupId === null || campaign.groupId === null || d.groupId === campaign.groupId) openDraft.set(d.contactId, d.id);
  }

  for (const contactId of contactIds) {
    const result = deriveStage({
      now,
      startedAt: campaign.startedAt,
      events: events.get(contactId) ?? [],
      hasOpenDraft: openDraft.has(contactId),
      callAt: callAt.get(contactId) ?? null,
      notPursuing: notPursuing.has(contactId),
      badAddress: badAddress.has(contactId),
      nudgeAfterDays: settings.nudgeAfterDays,
      dormantAfterDays: settings.dormantAfterDays,
    });
    out.set(contactId, { ...result, openDraftId: openDraft.get(contactId) ?? null, callAt: callAt.get(contactId) ?? null });
  }
  return out;
}

function memberIds(groupId: number): number[] {
  return db
    .select({ contactId: groupMembers.contactId })
    .from(groupMembers)
    .innerJoin(contacts, eq(contacts.id, groupMembers.contactId))
    .where(and(eq(groupMembers.groupId, groupId), isNull(contacts.archivedAt)))
    .all()
    .map((r) => r.contactId);
}

function primaryEmails(contactIds: number[]): Map<number, string> {
  const out = new Map<number, string>();
  if (contactIds.length === 0) return out;
  for (const e of db
    .select({ contactId: contactEmails.contactId, email: contactEmails.email })
    .from(contactEmails)
    .where(inArray(contactEmails.contactId, contactIds))
    .orderBy(desc(contactEmails.priority), asc(contactEmails.id))
    .all()) {
    if (!out.has(e.contactId)) out.set(e.contactId, e.email);
  }
  return out;
}

/** A campaign's members, each with where they stand right now. */
export function campaignPipeline(groupId: number, now = Date.now()): { campaign: Campaign; members: PipelineMember[] } | null {
  const campaign = getCampaign(groupId);
  if (!campaign) return null;
  reconcileDrafts();
  const ids = memberIds(groupId);
  const stages = stagesFor(ids, campaign, now);
  const emails = primaryEmails(ids);
  const people = ids.length
    ? db
        .select({ id: contacts.id, name: contacts.displayName, title: contacts.title, company: contacts.company })
        .from(contacts)
        .where(inArray(contacts.id, ids))
        .all()
    : [];
  const members = people
    .map((p) => ({ contactId: p.id, name: p.name, title: p.title, company: p.company, email: emails.get(p.id) ?? null, ...stages.get(p.id)! }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { campaign, members };
}

export type CampaignSummary = Campaign & { members: number; byStage: Record<Stage, number> };

export function listCampaigns(now = Date.now()): CampaignSummary[] {
  reconcileDrafts();
  return listCampaignRecords().map((campaign) => {
    const ids = memberIds(campaign.groupId);
    const byStage = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
    for (const result of stagesFor(ids, campaign, now).values()) byStage[result.stage] += 1;
    return { ...campaign, members: ids.length, byStage };
  });
}

export type AwaitingReply = {
  contactId: number;
  name: string;
  company: string | null;
  campaignId: number;
  campaignName: string;
  daysWaiting: number;
  lastSentAt: number;
  sentSinceReply: number;
};

/**
 * People in a live campaign the owner wrote to and has not heard from
 * for long enough that a follow-up is due — Today's "Awaiting reply".
 */
export function awaitingReply(now = Date.now()): AwaitingReply[] {
  const byContact = new Map<number, AwaitingReply>();
  for (const campaign of listCampaignRecords()) {
    if (campaign.archivedAt !== null) continue;
    const ids = memberIds(campaign.groupId);
    const stages = stagesFor(ids, campaign, now);
    const due = ids.filter((id) => stages.get(id)?.nudgeDue);
    if (due.length === 0) continue;
    const people = db.select({ id: contacts.id, name: contacts.displayName, company: contacts.company }).from(contacts).where(inArray(contacts.id, due)).all();
    for (const p of people) {
      const s = stages.get(p.id)!;
      const entry: AwaitingReply = {
        contactId: p.id,
        name: p.name,
        company: p.company,
        campaignId: campaign.groupId,
        campaignName: campaign.name,
        daysWaiting: s.daysWaiting ?? 0,
        lastSentAt: s.lastSentAt ?? now,
        sentSinceReply: s.sentSinceReply,
      };
      const have = byContact.get(p.id);
      if (!have || entry.daysWaiting > have.daysWaiting) byContact.set(p.id, entry);
    }
  }
  return [...byContact.values()].sort((a, b) => b.daysWaiting - a.daysWaiting);
}

// ---------- drafts to send ----------

export type Draft = typeof outreachDrafts.$inferSelect;

function cleanText(text: string, max: number): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);
}

export type SaveDraftInput = {
  contactId: number;
  groupId?: number | null;
  kind: DraftKind;
  subject: string;
  body: string;
  /** Must be an address already on the contact; defaults to their first one. */
  toEmail?: string | null;
  source: "agent" | "user";
  /** The open draft this one replaces, if the contact already has one. */
  replaceDraftId?: number | null;
};

export type SaveDraftResult = { ok: true; draft: Draft; replacedId: number | null } | (CoreError & { existingDraftId?: number });

export function saveDraft(input: SaveDraftInput, now = Date.now()): SaveDraftResult {
  const who = db.select({ id: contacts.id, name: contacts.displayName }).from(contacts).where(eq(contacts.id, input.contactId)).get();
  if (!who) return { ok: false, error: `There is no contact with id ${input.contactId}.` };
  if (!(DRAFT_KINDS as readonly string[]).includes(input.kind)) return { ok: false, error: "Unknown kind of draft." };
  const subject = cleanText(input.subject, DRAFT_SUBJECT_MAX + 1).replace(/\s+/g, " ");
  if (!subject) return { ok: false, error: "A draft needs a subject." };
  if (subject.length > DRAFT_SUBJECT_MAX) return { ok: false, error: `The subject is longer than ${DRAFT_SUBJECT_MAX} characters.` };
  const body = cleanText(input.body, DRAFT_BODY_MAX + 1);
  if (!body) return { ok: false, error: "A draft needs a body." };
  if (body.length > DRAFT_BODY_MAX) return { ok: false, error: `The body is longer than ${DRAFT_BODY_MAX} characters.` };
  const groupId = input.groupId ?? null;
  if (groupId !== null && !getCampaign(groupId)) return { ok: false, error: `There is no campaign with id ${groupId}.` };

  // A draft can only be addressed to an address Rolo already holds for
  // this person. An address read out of a message is added to the
  // contact first, where it is visible and attributed.
  const known = db
    .select({ email: contactEmails.email })
    .from(contactEmails)
    .where(eq(contactEmails.contactId, who.id))
    .orderBy(desc(contactEmails.priority), asc(contactEmails.id))
    .all()
    .map((e) => e.email);
  let toEmail: string | null = known[0] ?? null;
  if (input.toEmail) {
    const match = known.find((e) => e.toLowerCase() === input.toEmail!.trim().toLowerCase());
    if (!match) {
      return { ok: false, error: `${input.toEmail} is not an address Rolo holds for ${who.name}. Add it to the contact first, then draft.` };
    }
    toEmail = match;
  }

  return db.transaction((): SaveDraftResult => {
    const open = db
      .select()
      .from(outreachDrafts)
      .where(
        and(
          eq(outreachDrafts.contactId, who.id),
          eq(outreachDrafts.status, "open"),
          groupId === null ? isNull(outreachDrafts.groupId) : eq(outreachDrafts.groupId, groupId)
        )
      )
      .get();
    let replacedId: number | null = null;
    if (open) {
      if (input.replaceDraftId !== open.id) {
        return {
          ok: false,
          error: `${who.name} already has a draft waiting to be sent (id ${open.id}). Pass replaceDraftId: ${open.id} to replace it.`,
          existingDraftId: open.id,
        };
      }
      db.update(outreachDrafts).set({ status: "discarded", discardedAt: now, updatedAt: now }).where(eq(outreachDrafts.id, open.id)).run();
      replacedId = open.id;
    } else if (input.replaceDraftId) {
      return { ok: false, error: `Draft ${input.replaceDraftId} is not this contact's open draft, so there is nothing to replace.` };
    }
    const draft = db
      .insert(outreachDrafts)
      .values({ contactId: who.id, groupId, kind: input.kind, toEmail, subject, body, status: "open", source: input.source, createdAt: now, updatedAt: now })
      .returning()
      .get();
    return { ok: true, draft, replacedId };
  });
}

/** The owner's own edit before sending. */
export function editDraft(id: number, change: { subject: string; body: string }, now = Date.now()): { ok: true } | CoreError {
  const draft = db.select().from(outreachDrafts).where(eq(outreachDrafts.id, id)).get();
  if (!draft || draft.status !== "open") return { ok: false, error: "That draft is no longer waiting to be sent." };
  const subject = cleanText(change.subject, DRAFT_SUBJECT_MAX).replace(/\s+/g, " ");
  const body = cleanText(change.body, DRAFT_BODY_MAX);
  if (!subject || !body) return { ok: false, error: "A draft needs a subject and a body." };
  db.update(outreachDrafts).set({ subject, body, updatedAt: now }).where(eq(outreachDrafts.id, id)).run();
  return { ok: true };
}

/**
 * "Sent": the owner says this went out. That click is the record — an
 * outbound email on the person's timeline, dated now — and the draft is
 * done. When the forwarded copy reaches the agent later, it finds this
 * row and does not log the send twice.
 */
export function markDraftSent(id: number, now = Date.now()): { ok: true; interactionId: number; contactId: number } | CoreError {
  const draft = db.select().from(outreachDrafts).where(eq(outreachDrafts.id, id)).get();
  if (!draft || draft.status !== "open") return { ok: false, error: "That draft is no longer waiting to be sent." };
  return db.transaction(() => {
    const logged = recordInteraction({
      contactId: draft.contactId,
      kind: "email",
      direction: "outbound",
      occurredAt: now,
      title: draft.subject,
      source: "user",
      sourceKey: `draft:${draft.id}`,
      meta: { draftId: draft.id, category: draft.kind === "nudge" ? "follow_up" : draft.kind === "reply" ? "reply" : "outreach" },
    });
    if (!logged.ok) return logged;
    db.update(outreachDrafts)
      .set({ status: "sent", sentAt: now, updatedAt: now, interactionId: logged.interactionId })
      .where(eq(outreachDrafts.id, draft.id))
      .run();
    return { ok: true as const, interactionId: logged.interactionId, contactId: draft.contactId };
  });
}

export function discardDraft(id: number, now = Date.now()): { ok: true; contactId: number } | CoreError {
  const draft = db.select().from(outreachDrafts).where(eq(outreachDrafts.id, id)).get();
  if (!draft || draft.status !== "open") return { ok: false, error: "That draft is no longer waiting to be sent." };
  db.update(outreachDrafts).set({ status: "discarded", discardedAt: now, updatedAt: now }).where(eq(outreachDrafts.id, id)).run();
  return { ok: true, contactId: draft.contactId };
}

/** How long before a draft was written a send may be dated and still be that draft's. */
const RETIRE_SLACK_MS = 5 * 60 * 1000;

/**
 * Retire open drafts whose email has been logged as sent some other way —
 * the agent reading the forwarded copy, Rolo's Gmail sync — so that a
 * draft the owner sent without clicking "Sent" does not sit there asking
 * to be sent again. Matched on the person and the subject.
 */
export function reconcileDrafts(now = Date.now()): number {
  const open = db.select().from(outreachDrafts).where(eq(outreachDrafts.status, "open")).all();
  let retired = 0;
  for (const draft of open) {
    const want = normalizeSubject(draft.subject);
    if (!want) continue;
    const sends = db
      .select({ id: interactions.id, title: interactions.title, occurredAt: interactions.occurredAt })
      .from(interactions)
      .where(
        and(
          eq(interactions.contactId, draft.contactId),
          eq(interactions.kind, "email"),
          eq(interactions.direction, "outbound"),
          gte(interactions.occurredAt, draft.createdAt - RETIRE_SLACK_MS)
        )
      )
      .orderBy(asc(interactions.occurredAt))
      .all();
    const match = sends.find((s) => normalizeSubject(s.title) === want);
    if (!match) continue;
    db.update(outreachDrafts)
      .set({ status: "sent", sentAt: match.occurredAt, updatedAt: now, interactionId: match.id })
      .where(eq(outreachDrafts.id, draft.id))
      .run();
    retired += 1;
  }
  return retired;
}

export type DraftRow = Draft & { contactName: string; campaignName: string | null };

export function listDrafts(opts: { status?: "open" | "sent" | "discarded"; groupId?: number | null; limit?: number } = {}): DraftRow[] {
  reconcileDrafts();
  const status = opts.status ?? "open";
  return db
    .select({ draft: outreachDrafts, contactName: contacts.displayName, campaignName: groups.name })
    .from(outreachDrafts)
    .innerJoin(contacts, eq(contacts.id, outreachDrafts.contactId))
    .leftJoin(groups, eq(groups.id, outreachDrafts.groupId))
    .where(and(eq(outreachDrafts.status, status), opts.groupId ? eq(outreachDrafts.groupId, opts.groupId) : undefined))
    .orderBy(status === "open" ? asc(outreachDrafts.createdAt) : desc(outreachDrafts.updatedAt), asc(outreachDrafts.id))
    .limit(Math.min(Math.max(opts.limit ?? 100, 1), 200))
    .all()
    .map((r) => ({ ...r.draft, contactName: r.contactName, campaignName: r.campaignName }));
}

export function countOpenDrafts(): number {
  return db.select({ n: sql<number>`count(*)` }).from(outreachDrafts).where(eq(outreachDrafts.status, "open")).get()?.n ?? 0;
}

/**
 * Take back a draft an agent saved: only while it is still exactly that
 * draft — open and unedited. The draft it replaced comes back with it.
 */
export function undoDraftSave(write: { id: number; contactId: number; createdAt: number; replacedId: number | null }): { ok: true; what: string } | CoreError {
  const draft = db.select().from(outreachDrafts).where(eq(outreachDrafts.id, write.id)).get();
  if (!draft || draft.contactId !== write.contactId || draft.createdAt !== write.createdAt) return { ok: false, error: "the draft was already gone" };
  if (draft.status === "sent") return { ok: false, error: "the draft has been sent, so it was kept" };
  if (draft.status === "discarded") return { ok: false, error: "the draft was already discarded" };
  if (draft.updatedAt !== draft.createdAt) return { ok: false, error: "the draft was edited after it was written, so it was kept" };
  db.delete(outreachDrafts).where(eq(outreachDrafts.id, draft.id)).run();
  if (write.replacedId !== null) {
    // The one it pushed aside: back to waiting, if that is still what it is.
    db.update(outreachDrafts)
      .set({ status: "open", discardedAt: null })
      .where(and(eq(outreachDrafts.id, write.replacedId), eq(outreachDrafts.status, "discarded"), eq(outreachDrafts.discardedAt, write.createdAt)))
      .run();
  }
  return { ok: true, what: write.replacedId !== null ? "removed the draft and put the earlier one back" : "removed the draft" };
}

// ---------- the voice guide ----------

export const VOICE_GUIDE_MAX = 6000;
export const VOICE_GUIDE_MIN = 80;

/** Replace the owner's voice guide, keeping the one before for a single undo. */
export function saveVoiceGuide(text: string, now = Date.now()): { ok: true; marker: number } | CoreError {
  const guide = text.trim();
  if (guide.length < VOICE_GUIDE_MIN) return { ok: false, error: `A voice guide shorter than ${VOICE_GUIDE_MIN} characters says too little to write from.` };
  if (guide.length > VOICE_GUIDE_MAX) return { ok: false, error: `The voice guide is longer than ${VOICE_GUIDE_MAX} characters.` };
  const previous = getSetting<string>("ai.voice_guide") ?? null;
  const previousAt = getSetting<number>("ai.voice_generated_at") ?? null;
  const marker = Math.max(now, (previousAt ?? 0) + 1);
  setSetting("ai.voice_guide_prev", { guide: previous, generatedAt: previousAt });
  setSetting("ai.voice_guide", guide);
  setSetting("ai.voice_generated_at", marker);
  return { ok: true, marker };
}

export function undoVoiceGuide(marker: number, now = Date.now()): { ok: true } | CoreError {
  if ((getSetting<number>("ai.voice_generated_at") ?? null) !== marker) {
    return { ok: false, error: "the voice guide has been changed since, so it was left as it is" };
  }
  const prev = getSetting<{ guide: string | null; generatedAt: number | null } | null>("ai.voice_guide_prev");
  if (!prev) return { ok: false, error: "there is no earlier voice guide to return to" };
  setSetting("ai.voice_guide", prev.guide ?? "");
  setSetting("ai.voice_generated_at", Math.max(now, marker + 1));
  setSetting("ai.voice_guide_prev", null);
  return { ok: true };
}
