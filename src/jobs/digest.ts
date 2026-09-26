import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm";

import { db } from "@/db/client";
import { contactChanges, contacts, interactions, notes } from "@/db/schema";
import {
  buildDigestPrompt,
  buildDigestSystem,
  digestAllowedIds,
  digestBriefFormat,
  parseDigestBrief,
  type DigestBrief,
  type DigestBriefInput,
} from "@/lib/ai/digest";
import { buildDigest, type DigestEmail, type DigestLead } from "@/lib/digest/build";
import { sendEmail } from "@/lib/digest/send";
import { getSetting, setSetting } from "@/lib/settings";
import { aiEnabled, callAi } from "@/server/ai-client";
import { ownerVoiceContext } from "@/server/ai-voice";
import { getTodayData, ownerTimezone, type TodayData } from "@/server/today-data";
import { DAY_MS } from "@/lib/cadence/engine";

// Digest = the Today page, mailed. Data comes from the same getTodayData
// call the page renders, satisfying the SPEC §3 "matches Today" AC. With
// AI on (SPEC §11, 2026-09-26) it opens with a brief written from that
// data plus what moved since the last digest; the list follows unchanged.

const HOUR_MS = 60 * 60 * 1000;

/** What happened since the last digest went out — the "news" half of the brief. */
function sinceLastDigest(now: number, data: TodayData): DigestBriefInput["since"] {
  const lastSent = getSetting<number>("digest.last_sent_at") ?? now - 24 * HOUR_MS;
  const count = (n: number | undefined) => n ?? 0;
  const interactionsLogged = count(
    db
      .select({ id: interactions.id })
      .from(interactions)
      .where(and(gt(interactions.createdAt, lastSent), eq(interactions.countsForTouch, true)))
      .all().length
  );
  const notesWritten = count(db.select({ id: notes.id }).from(notes).where(gt(notes.createdAt, lastSent)).all().length);
  const newContacts = count(
    db.select({ id: contacts.id }).from(contacts).where(and(gt(contacts.createdAt, lastSent), isNull(contacts.archivedAt))).all().length
  );
  const newChangeIds = new Set(
    db
      .select({ id: contactChanges.id })
      .from(contactChanges)
      .where(gt(contactChanges.detectedAt, lastSent))
      .all()
      .map((r) => r.id)
  );
  const newChanges = data.changes
    .filter((c) => !c.lowSignal && newChangeIds.has(c.id))
    .map((c) => ({
      contactId: c.contactId,
      name: c.contactName,
      diff: `${c.oldValue ?? "—"} → ${c.newValue ?? "—"}`,
      reason: c.triage?.reason || null,
    }));
  return {
    hoursAgo: Math.max(1, Math.round((now - lastSent) / HOUR_MS)),
    interactionsLogged,
    notesWritten,
    newContacts,
    newChanges,
  };
}

function briefInput(now: number, data: TodayData, dateLabel: string): DigestBriefInput {
  const dueIds = data.dueContacts.map((c) => c.contactId);
  const lastNoteBy = new Map<number, string>();
  if (dueIds.length > 0) {
    for (const n of db
      .select({ contactId: notes.contactId, body: notes.bodyMd })
      .from(notes)
      .where(inArray(notes.contactId, dueIds))
      .orderBy(desc(notes.createdAt))
      .all()) {
      if (n.contactId === null || lastNoteBy.has(n.contactId)) continue;
      const body = n.body.replace(/\s+/g, " ").trim();
      if (body) lastNoteBy.set(n.contactId, body.slice(0, 160));
    }
  }
  return {
    dateLabel,
    since: sinceLastDigest(now, data),
    reminders: data.reminders.map((r) => ({
      title: r.title,
      contactName: r.contactName,
      overdueDays: Math.max(0, Math.floor((now - r.dueAt) / DAY_MS)),
    })),
    agenda: data.agenda.map((a) => ({
      summary: a.summary,
      attendees: a.attendees.filter((x) => x.contactId !== null).map((x) => x.name ?? x.email),
    })),
    due: data.dueContacts.map((c) => ({
      contactId: c.contactId,
      name: c.displayName,
      title: c.title,
      company: c.company,
      daysOverdue: c.daysOverdue,
      starred: c.starred,
      lastNote: lastNoteBy.get(c.contactId) ?? null,
    })),
    changes: data.changes
      .filter((c) => !c.lowSignal)
      .map((c) => ({
        contactId: c.contactId,
        name: c.contactName,
        diff: `${c.oldValue ?? "—"} → ${c.newValue ?? "—"}`,
        reason: c.triage?.reason || null,
        significance: c.triage?.significance ?? null,
      })),
    birthdays: data.birthdays.map((b) => ({ contactId: b.contactId, name: b.displayName, daysUntil: b.daysUntil })),
    resurface: data.resurface.map((r) => ({
      contactId: r.contactId,
      name: r.displayName,
      monthsSince: r.lastInteractionAt === null ? null : Math.floor((now - r.lastInteractionAt) / (30 * DAY_MS)),
    })),
  };
}

async function writeBrief(input: DigestBriefInput): Promise<DigestBrief | null> {
  if (!aiEnabled()) return null;
  try {
    const result = await callAi({
      feature: "digest",
      system: buildDigestSystem(ownerVoiceContext()),
      prompt: buildDigestPrompt(input),
      maxTokens: 1500,
      outputFormat: digestBriefFormat(),
    });
    if (!result.ok) {
      console.error("[rolo-digest] brief failed:", result.error);
      return null;
    }
    return parseDigestBrief(result.text, digestAllowedIds(input));
  } catch (err) {
    // The list-only digest is still a digest — never let the model's
    // outage take the morning email with it.
    console.error("[rolo-digest] brief threw:", err);
    return null;
  }
}

export async function buildTodayDigest(now: number): Promise<DigestEmail & { brief: DigestBrief | null }> {
  const data = getTodayData(now);
  const dateLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: data.timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(now);
  const input = briefInput(now, data, dateLabel);
  const brief = await writeBrief(input);
  const names = new Map<number, string>();
  for (const list of [input.due, input.changes, input.since.newChanges, input.birthdays, input.resurface]) {
    for (const x of list) names.set(x.contactId, x.name);
  }
  const lead: DigestLead | null = brief
    ? {
        headline: brief.headline,
        narrative: brief.narrative,
        picks: brief.picks.map((p) => ({ ...p, name: names.get(p.contactId) ?? `#${p.contactId}` })),
      }
    : null;
  const email = buildDigest({
    dateLabel,
    appUrl: getSetting<string>("app_url") ?? "http://localhost:3000",
    lead,
    reminders: input.reminders,
    dueContacts: data.dueContacts.map((c) => ({
      displayName: c.displayName,
      title: c.title,
      company: c.company,
      daysOverdue: c.daysOverdue,
      starred: c.starred,
    })),
    changes: data.changes
      .filter((c) => !c.lowSignal)
      .map((c) => ({
        displayName: c.contactName,
        field: c.field,
        oldValue: c.oldValue,
        newValue: c.newValue,
        reason: c.triage?.reason || null,
      })),
    birthdays: data.birthdays.map((b) => ({
      displayName: b.displayName,
      daysUntil: b.daysUntil,
      turns: b.turns,
    })),
    resurface: data.resurface.map((r) => ({
      displayName: r.displayName,
      title: r.title,
      company: r.company,
      monthsSince:
        r.lastInteractionAt === null
          ? null
          : Math.floor((now - r.lastInteractionAt) / (30 * DAY_MS)),
      interactionCount: r.interactionCount,
    })),
  });
  return { ...email, brief };
}

export type DigestResult = "sent" | "skipped-empty" | "skipped-quiet";

export async function runDigest(now: number): Promise<DigestResult> {
  const email = await buildTodayDigest(now);
  const sendWhenEmpty = getSetting<boolean>("digest.send_when_empty") ?? false;
  const onlyWhenChanged = getSetting<boolean>("digest.only_when_changed") ?? false;
  if (onlyWhenChanged && email.brief?.quiet) return "skipped-quiet";
  if (email.empty && !sendWhenEmpty) return "skipped-empty";
  await sendEmail(email);
  setSetting("digest.last_sent_at", now);
  return "sent";
}

export { ownerTimezone };
