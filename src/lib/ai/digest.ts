// The digest narrative (SPEC §3/§11, owner request 2026-09-26). The
// daily email used to be Today as a list, identical every morning nothing
// changed. Now it opens with a short brief the model writes from the same
// data: what moved since the last digest, what is due, and up to three
// people worth a message today with a first line in the owner's voice.
// The list follows, unchanged. Pure; the job feeds rows and validates
// every pick against the ids it sent.

import { z } from "zod";

import { extractJson } from "@/lib/ai/nl-filter";

export type DigestBriefInput = {
  dateLabel: string;
  /** What happened since the last digest went out. */
  since: {
    hoursAgo: number;
    interactionsLogged: number;
    notesWritten: number;
    newContacts: number;
    newChanges: { contactId: number; name: string; diff: string; reason: string | null }[];
  };
  reminders: { title: string; contactName: string | null; overdueDays: number }[];
  agenda: { summary: string | null; attendees: string[] }[];
  due: {
    contactId: number;
    name: string;
    title: string | null;
    company: string | null;
    daysOverdue: number;
    starred: boolean;
    lastNote: string | null;
  }[];
  changes: { contactId: number; name: string; diff: string; reason: string | null; significance: number | null }[];
  birthdays: { contactId: number; name: string; daysUntil: number }[];
  resurface: { contactId: number; name: string; monthsSince: number | null }[];
};

export type DigestBrief = {
  /** ≤ 12 words, the subject line. */
  headline: string;
  /** 3–6 plain sentences. */
  narrative: string;
  picks: { contactId: number; why: string; draft: string }[];
  /** Nothing new and nothing pressing: the owner can skip today. */
  quiet: boolean;
};

export const DIGEST_PICKS_MAX = 3;

export function buildDigestSystem(voiceContext: string): string {
  return [
    "You write the owner's morning brief for their personal network, from their own CRM data only.",
    "headline: at most 12 words, specific, no exclamation marks — it is the email subject.",
    "narrative: 3–6 plain sentences, second person, no bullet points, no headings. Say what changed since the last brief (moves, exchanges logged, people added) only when something did; then what is due today and what deserves attention. Do not list every name — the list follows below the brief. Never invent facts; if the data is thin, say the day is quiet.",
    "picks: up to 3 people worth a message today, chosen from the ids in the data by real reasons (a fresh move with a warm relationship, someone long overdue who matters, a birthday, an open thread in a note). why: one line. draft: the first 1–2 sentences the owner could send, in their voice, grounded in the data. Fewer picks are better than padded ones; zero is fine on a quiet day.",
    "quiet: true only when nothing changed since the last brief AND nothing is due or pressing.",
    voiceContext,
    'Respond with JSON only: {"headline": "...", "narrative": "...", "picks": [{"contactId": 0, "why": "...", "draft": "..."}], "quiet": false}',
  ].join("\n");
}

export function buildDigestPrompt(input: DigestBriefInput): string {
  const s = input.since;
  const parts = [
    `Date: ${input.dateLabel}`,
    `Since the last brief (${s.hoursAgo}h ago): ${s.interactionsLogged} exchanges logged, ${s.notesWritten} notes written, ${s.newContacts} people added, ${s.newChanges.length} job changes detected.`,
    s.newChanges.length > 0
      ? `New job changes:\n${s.newChanges.map((c) => `- #${c.contactId} ${c.name}: ${c.diff}${c.reason ? ` — ${c.reason}` : ""}`).join("\n")}`
      : null,
    input.reminders.length > 0
      ? `Reminders due:\n${input.reminders.map((r) => `- ${r.title}${r.contactName ? ` (${r.contactName})` : ""}${r.overdueDays > 0 ? ` · ${r.overdueDays}d overdue` : ""}`).join("\n")}`
      : null,
    input.agenda.length > 0
      ? `Today's meetings:\n${input.agenda.map((a) => `- ${a.summary ?? "(no title)"}${a.attendees.length > 0 ? ` with ${a.attendees.join(", ")}` : ""}`).join("\n")}`
      : null,
    input.due.length > 0
      ? `Keep-in-touch due (${input.due.length}):\n${input.due
          .slice(0, 25)
          .map(
            (d) =>
              `- #${d.contactId} ${d.name}${d.title || d.company ? ` (${[d.title, d.company].filter(Boolean).join(", ")})` : ""}${d.starred ? " ★" : ""} · ${d.daysOverdue === 0 ? "due today" : `${d.daysOverdue}d overdue`}${d.lastNote ? ` · last note: ${d.lastNote}` : ""}`
          )
          .join("\n")}${input.due.length > 25 ? `\n- …and ${input.due.length - 25} more` : ""}`
      : "Nobody is due for keep-in-touch.",
    input.changes.length > 0
      ? `Open job-change cards (${input.changes.length}):\n${input.changes
          .slice(0, 15)
          .map((c) => `- #${c.contactId} ${c.name}: ${c.diff}${c.reason ? ` — ${c.reason}` : ""}${c.significance !== null ? ` (${c.significance.toFixed(1)})` : ""}`)
          .join("\n")}`
      : null,
    input.birthdays.length > 0
      ? `Birthdays this week:\n${input.birthdays.map((b) => `- #${b.contactId} ${b.name} · ${b.daysUntil === 0 ? "today" : `in ${b.daysUntil}d`}`).join("\n")}`
      : null,
    input.resurface.length > 0
      ? `Worth reconnecting:\n${input.resurface.map((r) => `- #${r.contactId} ${r.name}${r.monthsSince !== null ? ` · last spoke ${r.monthsSince}mo ago` : ""}`).join("\n")}`
      : null,
  ].filter(Boolean);
  return parts.join("\n\n");
}

export function digestBriefFormat(): Record<string, unknown> {
  return {
    type: "json_schema",
    schema: {
      type: "object",
      properties: {
        headline: { type: "string" },
        narrative: { type: "string" },
        picks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              contactId: { type: "integer" },
              why: { type: "string" },
              draft: { type: "string" },
            },
            required: ["contactId", "why", "draft"],
            additionalProperties: false,
          },
        },
        quiet: { type: "boolean" },
      },
      required: ["headline", "narrative", "picks", "quiet"],
      additionalProperties: false,
    },
  };
}

const schema = z.object({
  headline: z.string().trim().min(3).max(120),
  narrative: z.string().trim().min(20).max(2500),
  picks: z.array(z.object({ contactId: z.number().int(), why: z.string().trim().max(300), draft: z.string().trim().max(600) })).max(10),
  quiet: z.boolean(),
});

/** Picks must name ids that were in the data; anything else is dropped. */
export function parseDigestBrief(text: string, allowedIds: Set<number>): DigestBrief | null {
  const parsed = schema.safeParse(extractJson(text));
  if (!parsed.success) return null;
  const seen = new Set<number>();
  const picks: DigestBrief["picks"] = [];
  for (const p of parsed.data.picks) {
    if (!allowedIds.has(p.contactId) || seen.has(p.contactId) || !p.why) continue;
    seen.add(p.contactId);
    picks.push(p);
    if (picks.length >= DIGEST_PICKS_MAX) break;
  }
  return { headline: parsed.data.headline, narrative: parsed.data.narrative, picks, quiet: parsed.data.quiet };
}

/** Every id the model may pick from. */
export function digestAllowedIds(input: DigestBriefInput): Set<number> {
  return new Set([
    ...input.due.map((d) => d.contactId),
    ...input.changes.map((c) => c.contactId),
    ...input.since.newChanges.map((c) => c.contactId),
    ...input.birthdays.map((b) => b.contactId),
    ...input.resurface.map((r) => r.contactId),
  ]);
}
