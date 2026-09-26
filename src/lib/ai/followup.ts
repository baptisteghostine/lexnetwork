// Post-meeting follow-up (SPEC §9e/§11, owner request 2026-09-26). The
// brief before a meeting is the "surface" half of the loop; this is the
// "capture" half after it: for a meeting that just ended with people
// Rolo knows, Today asks "how did it go?", the owner answers in one line,
// and the model turns that line into a note and the follow-up reminders.
// Pure: selection and prompt/parse only; the server action writes rows.

import { z } from "zod";

import { extractJson } from "@/lib/ai/nl-filter";

export const FOLLOWUP_WINDOW_MS = 48 * 60 * 60 * 1000;
const DEFAULT_DURATION_MS = 60 * 60 * 1000;

export type FollowupCandidate = {
  id: number;
  eventKey: string;
  summary: string | null;
  startsAt: number;
  endsAt: number | null;
  status: string;
  myResponse: string | null;
  matchedContactIds: number[];
  /** Ledger: answered or skipped already. */
  handled: boolean;
  /** A note was written for one of the attendees after the meeting ended. */
  notedSince: boolean;
};

export function meetingEnd(e: { startsAt: number; endsAt: number | null }): number {
  return e.endsAt ?? e.startsAt + DEFAULT_DURATION_MS;
}

/**
 * Meetings that ended within the window, that the owner did not decline,
 * with at least one matched contact, not yet answered or skipped, and not
 * already captured by hand. Newest first.
 */
export function selectFollowups<T extends FollowupCandidate>(candidates: T[], now: number): T[] {
  return candidates
    .filter((e) => {
      const end = meetingEnd(e);
      return (
        end <= now &&
        now - end <= FOLLOWUP_WINDOW_MS &&
        e.status !== "cancelled" &&
        e.myResponse !== "declined" &&
        e.matchedContactIds.length > 0 &&
        !e.handled &&
        !e.notedSince
      );
    })
    .sort((a, b) => meetingEnd(b) - meetingEnd(a));
}

export type FollowupInput = {
  meetingSummary: string | null;
  meetingDate: string;
  contacts: { contactId: number; name: string; title: string | null; company: string | null }[];
  /** What the owner typed. */
  answer: string;
};

export type FollowupResult = {
  /** The note, in markdown, in the owner's words tidied — never embellished. */
  noteMd: string;
  reminders: { title: string; dueInDays: number; contactId: number | null }[];
};

export const FOLLOWUP_SYSTEM = [
  "The owner of a personal CRM just told you, in one or two lines, how a meeting went. Turn it into their records.",
  "noteMd: a short markdown note in the owner's own words, tidied — fix obvious typos, expand shorthand, use a bullet list when they gave several points. Keep first person. Never add facts, feelings or details they did not state. Do not repeat the meeting title or the date.",
  "reminders: every follow-up the owner committed to or asked for ('send the deck', 'intro to Priya', 'check in next month'), each with a title in imperative form, dueInDays (1 for 'tomorrow', 7 for 'next week', 30 for 'next month'; 3 when they gave no timing), and contactId of the attendee it concerns when clear, else null. No reminders when they mentioned none.",
  'Respond with JSON only: {"noteMd": "...", "reminders": [{"title": "...", "dueInDays": 3, "contactId": null}]}',
].join("\n");

export function buildFollowupPrompt(input: FollowupInput): string {
  return [
    `Meeting: ${input.meetingSummary ?? "(no title)"} · ${input.meetingDate}`,
    `With: ${input.contacts
      .map((c) => `#${c.contactId} ${c.name}${c.title || c.company ? ` (${[c.title, c.company].filter(Boolean).join(", ")})` : ""}`)
      .join("; ")}`,
    `The owner says: ${input.answer.trim()}`,
  ].join("\n");
}

export function followupFormat(): Record<string, unknown> {
  return {
    type: "json_schema",
    schema: {
      type: "object",
      properties: {
        noteMd: { type: "string" },
        reminders: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              dueInDays: { type: "integer" },
              contactId: { type: ["integer", "null"] },
            },
            required: ["title", "dueInDays", "contactId"],
            additionalProperties: false,
          },
        },
      },
      required: ["noteMd", "reminders"],
      additionalProperties: false,
    },
  };
}

const schema = z.object({
  noteMd: z.string().trim().min(1).max(5000),
  reminders: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(300),
        dueInDays: z.number().int(),
        contactId: z.number().int().nullable(),
      })
    )
    .max(10),
});

/** Reminder contact ids must be attendees; due days clamp to 1–365. */
export function parseFollowup(text: string, attendeeIds: Set<number>): FollowupResult | null {
  const parsed = schema.safeParse(extractJson(text));
  if (!parsed.success) return null;
  return {
    noteMd: parsed.data.noteMd,
    reminders: parsed.data.reminders.slice(0, 5).map((r) => ({
      title: r.title,
      dueInDays: Math.min(365, Math.max(1, r.dueInDays)),
      contactId: r.contactId !== null && attendeeIds.has(r.contactId) ? r.contactId : null,
    })),
  };
}

/** The mention line appended to the note so every attendee's timeline shows it. */
export function attendeeMentions(contacts: { contactId: number; name: string }[], primaryId: number): string {
  const others = contacts.filter((c) => c.contactId !== primaryId);
  if (others.length === 0) return "";
  return `\n\nWith ${others.map((c) => `[@${c.name}](mention://contact/${c.contactId})`).join(", ")}`;
}
