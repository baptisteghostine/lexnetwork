// Pre-meeting brief (SPEC §9e). Pure: the job in jobs/meeting-prep.ts
// feeds it rows and a clock, so both "which meetings need a brief now"
// and "what the email says" are unit-testable without a DB or SMTP.
//
// The brief is the "capture → surface" half of the loop at the moment
// it matters most: the owner is about to sit down with someone, and
// everything Rolo already knows about that person — last touch, open
// reminders, a job change, their own notes — is on one screen without
// anyone going looking for it.

import { DAY_MS } from "@/lib/cadence/engine";

export type PrepInteraction = {
  kind: string;
  direction: string | null;
  title: string | null;
  occurredAt: number;
};

export type PrepContact = {
  contactId: number;
  displayName: string;
  title: string | null;
  company: string | null;
  lastInteractionAt: number | null;
  /** Newest first, capped. */
  interactions: PrepInteraction[];
  reminders: { title: string; dueAt: number }[];
  changes: {
    field: string;
    oldValue: string | null;
    newValue: string | null;
    detectedAt: number;
  }[];
  /** The owner's own notes, newest first, trimmed. */
  notes: string[];
  /** AI talking points (SPEC §11) — empty when AI is off or failed. */
  talkingPoints: string[];
};

export type MeetingPrep = {
  eventKey: string;
  summary: string | null;
  startsAt: number;
  endsAt: number | null;
  htmlLink: string | null;
  contacts: PrepContact[];
  generatedAt: number;
};

/** Stored brief → typed, or null when absent or unreadable. */
export function parsePrep(json: string | null): MeetingPrep | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as MeetingPrep;
    return parsed && Array.isArray(parsed.contacts) ? parsed : null;
  } catch {
    return null;
  }
}

export const PREP_INTERACTIONS_MAX = 3;
export const PREP_NOTES_MAX = 2;
export const PREP_NOTE_CHARS = 300;
export const PREP_CONTACTS_MAX = 5;
/** How far past its start a meeting can still get a brief — a late brief
 * beats none for the first minutes, then it's noise. */
export const PREP_GRACE_MS = 15 * 60 * 1000;
export const DEFAULT_LEAD_MINUTES = 120;

export function clampLeadMinutes(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_LEAD_MINUTES;
  return Math.min(24 * 60, Math.max(15, Math.floor(value)));
}

export type PrepCandidate = {
  eventKey: string;
  startsAt: number;
  status: string;
  myResponse: string | null;
  preppedAt: number | null;
  /** Contact ids matched at sync time. */
  matchedContactIds: number[];
};

/**
 * Which events get a brief on this tick: inside the lead window (or just
 * started), not yet told about, not declined or cancelled, and with at
 * least one attendee who is a contact — a meeting with nobody Rolo knows
 * has nothing to say.
 */
export function selectEventsToPrep(
  events: PrepCandidate[],
  now: number,
  leadMs: number
): PrepCandidate[] {
  return events
    .filter(
      (e) =>
        e.preppedAt === null &&
        e.status !== "cancelled" &&
        e.myResponse !== "declined" &&
        e.startsAt > now - PREP_GRACE_MS &&
        e.startsAt <= now + leadMs &&
        e.matchedContactIds.length > 0
    )
    .sort((a, b) => a.startsAt - b.startsAt);
}

/** "today" / "yesterday" / "12d ago" / "3mo ago" / "2y ago". */
export function ago(ts: number, now: number): string {
  const days = Math.floor((now - ts) / DAY_MS);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export function interactionLabel(i: PrepInteraction): string {
  const what =
    i.kind === "email"
      ? i.direction === "outbound"
        ? "You emailed"
        : "They emailed"
      : i.kind === "meeting"
        ? "Met"
        : i.kind === "message"
          ? i.direction === "outbound"
            ? "You messaged"
            : "They messaged"
          : "Logged";
  return i.title ? `${what} — ${i.title}` : what;
}

function esc(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const INDIGO = "#4f46e5";
const MUTED = "#6b7280";
const GREEN = "#15803d";

export type MeetingPrepEmail = { subject: string; html: string; text: string };

export function formatMeetingTime(
  startsAt: number,
  endsAt: number | null,
  timezone: string
): string {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
  });
  const start = fmt.format(startsAt);
  return endsAt ? `${start}–${fmt.format(endsAt)}` : start;
}

export function buildMeetingPrepEmail(
  prep: MeetingPrep,
  opts: { appUrl: string; timezone: string; now: number }
): MeetingPrepEmail {
  const names = prep.contacts.map((c) => c.displayName);
  const who =
    names.length === 1
      ? names[0]
      : names.length === 2
        ? `${names[0]} and ${names[1]}`
        : `${names[0]} and ${names.length - 1} others`;
  const when = formatMeetingTime(prep.startsAt, prep.endsAt, opts.timezone);
  const subject = `Before ${when.split("–")[0]} with ${who}${prep.summary ? ` — ${prep.summary}` : ""}`;

  const contactHtml = prep.contacts
    .map((c) => {
      const role = [c.title, c.company].filter(Boolean).join(", ");
      const last = c.lastInteractionAt
        ? `last spoke ${ago(c.lastInteractionAt, opts.now)}`
        : "no recorded contact yet";
      const bullets: string[] = [];
      for (const i of c.interactions) {
        bullets.push(`${esc(interactionLabel(i))} <span style="color:${MUTED}">· ${esc(ago(i.occurredAt, opts.now))}</span>`);
      }
      for (const r of c.reminders) {
        bullets.push(`<span style="color:${INDIGO}">Reminder:</span> ${esc(r.title)}`);
      }
      for (const ch of c.changes) {
        bullets.push(
          `<span style="color:${GREEN};font-weight:600">${esc(ch.field === "company" ? "New company" : "New title")}:</span> ${
            ch.oldValue ? `<span style="color:${MUTED};text-decoration:line-through">${esc(ch.oldValue)}</span> ` : ""
          }${esc(ch.newValue ?? "—")} <span style="color:${MUTED}">· ${esc(ago(ch.detectedAt, opts.now))}</span>`
        );
      }
      const notes = c.notes.length
        ? `<p style="margin:6px 0 0;font-size:12px;color:${MUTED}">Your notes</p><ul style="margin:2px 0 0;padding-left:18px;font-size:13px">${c.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`
        : "";
      const points = c.talkingPoints.length
        ? `<p style="margin:6px 0 0;font-size:12px;color:${MUTED}">Talking points <span style="font-style:italic">(AI-drafted — check before you use them)</span></p><ol style="margin:2px 0 0;padding-left:18px;font-size:13px">${c.talkingPoints.map((p) => `<li>${esc(p)}</li>`).join("")}</ol>`
        : "";
      return `<div style="padding:12px 0;border-bottom:1px solid #e5e7eb">
<p style="margin:0;font-size:15px;font-weight:600"><a href="${esc(opts.appUrl)}/contacts/${c.contactId}" style="color:#111827;text-decoration:none">${esc(c.displayName)}</a>${role ? ` <span style="font-weight:400;color:${MUTED}">· ${esc(role)}</span>` : ""}</p>
<p style="margin:2px 0 0;font-size:12px;color:${MUTED}">${esc(last)}</p>
${bullets.length ? `<ul style="margin:6px 0 0;padding-left:18px;font-size:13px">${bullets.map((b) => `<li>${b}</li>`).join("")}</ul>` : ""}
${notes}${points}
</div>`;
    })
    .join("");

  const html = `<div style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111827">
<p style="margin:0;font-size:16px;font-weight:600;color:${INDIGO}">Rolo</p>
<p style="margin:4px 0 0;font-size:13px;color:${MUTED}">Before your meeting · ${esc(when)}</p>
<p style="margin:12px 0 0;font-size:17px;font-weight:600">${prep.htmlLink ? `<a href="${esc(prep.htmlLink)}" style="color:#111827;text-decoration:none">${esc(prep.summary ?? "(no title)")}</a>` : esc(prep.summary ?? "(no title)")}</p>
${contactHtml}
<p style="margin:24px 0 0;font-size:12px"><a href="${esc(opts.appUrl)}/today" style="color:${INDIGO}">Open Today →</a></p>
</div>`;

  const text = [
    `Rolo — before your meeting · ${when}`,
    prep.summary ?? "(no title)",
    "",
    ...prep.contacts.flatMap((c) => {
      const role = [c.title, c.company].filter(Boolean).join(", ");
      const lines = [
        `${c.displayName}${role ? ` · ${role}` : ""}`,
        `  ${c.lastInteractionAt ? `last spoke ${ago(c.lastInteractionAt, opts.now)}` : "no recorded contact yet"}`,
        ...c.interactions.map((i) => `  - ${interactionLabel(i)} · ${ago(i.occurredAt, opts.now)}`),
        ...c.reminders.map((r) => `  - Reminder: ${r.title}`),
        ...c.changes.map(
          (ch) => `  - ${ch.field === "company" ? "New company" : "New title"}: ${ch.oldValue ? `${ch.oldValue} → ` : ""}${ch.newValue ?? "—"} · ${ago(ch.detectedAt, opts.now)}`
        ),
      ];
      if (c.notes.length) lines.push("  Your notes:", ...c.notes.map((n) => `  - ${n}`));
      if (c.talkingPoints.length)
        lines.push("  Talking points (AI-drafted):", ...c.talkingPoints.map((p, i) => `  ${i + 1}. ${p}`));
      lines.push("");
      return lines;
    }),
    `${opts.appUrl}/today`,
  ].join("\n");

  return { subject, html, text };
}
