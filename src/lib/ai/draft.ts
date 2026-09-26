// Drafts in the owner's voice (SPEC §11, owner request 2026-09-26). The
// last step of the loop — reaching out — becomes one click: given what
// Rolo knows about a person and why now, the model writes a LinkedIn-
// length message, an email, and two alternative openings, all in the
// owner's voice. Pure: the server action feeds rows; nothing is sent.

import { z } from "zod";

import { extractJson } from "@/lib/ai/nl-filter";

export type DraftInput = {
  displayName: string;
  firstName: string | null;
  title: string | null;
  company: string | null;
  location: string | null;
  workHistory: { company: string; title: string | null; isCurrent: boolean }[];
  education: { school: string; degree: string | null; field: string | null }[];
  tags: string[];
  /** Whole days since the owner last spoke to them; null = never. */
  lastContactDays: number | null;
  /** Newest first: "message from them · 3d ago: Hi Baptiste…" */
  recentInteractions: string[];
  /** The owner's own notes, newest first, trimmed. */
  notes: string[];
  /** A detected job change, when the draft is launched from a card. */
  change: { field: string; oldValue: string | null; newValue: string | null; reason: string | null } | null;
  /** What the owner wants from this message, in their words (optional). */
  intent: string | null;
};

export type Draft = {
  message: string;
  email: { subject: string; body: string };
  alternatives: string[];
};

export function buildDraftSystem(voiceContext: string): string {
  return [
    "You write messages the owner of a personal CRM will send to someone they know, to keep in touch or to reach out for a reason.",
    "Ground every line in the context provided: their role, history, the owner's notes, recent exchanges, a detected change. Never invent shared history, meetings, or facts. If the context is thin, keep the message short and honest rather than padding.",
    "message: a LinkedIn/WhatsApp-length message, 2–4 sentences, first person, ready to send. No subject line, no placeholders like [name], no sign-off block unless the owner's voice uses one.",
    "email: subject (short, specific) and body (4–8 sentences, same voice, with the owner's usual greeting and close).",
    "alternatives: two different first sentences the owner could swap in — a different angle each.",
    "If the owner stated an intent, that is the point of the message; make the ask clear and easy to say yes to.",
    voiceContext,
    'Respond with JSON only: {"message": "...", "email": {"subject": "...", "body": "..."}, "alternatives": ["...", "..."]}',
  ].join("\n");
}

export function buildDraftPrompt(input: DraftInput): string {
  const parts = [
    `Person: ${input.displayName}${input.firstName ? ` (first name: ${input.firstName})` : ""}`,
    input.title || input.company
      ? `Role: ${[input.title, input.company].filter(Boolean).join(" at ")}`
      : null,
    input.location ? `Location: ${input.location}` : null,
    input.workHistory.length > 0
      ? `Work history: ${input.workHistory
          .map((w) => `${w.title ? `${w.title} at ` : ""}${w.company}${w.isCurrent ? " (current)" : ""}`)
          .join("; ")}`
      : null,
    input.education.length > 0
      ? `Education: ${input.education
          .map((e) => [e.degree, e.field, e.school].filter(Boolean).join(", "))
          .join("; ")}`
      : null,
    input.tags.length > 0 ? `How the owner files them: ${input.tags.join(", ")}` : null,
    input.lastContactDays === null
      ? "The owner has never logged contact with them."
      : `Last contact: ${input.lastContactDays} days ago.`,
    input.recentInteractions.length > 0
      ? `Recent exchanges (newest first):\n${input.recentInteractions.map((i) => `- ${i}`).join("\n")}`
      : null,
    input.notes.length > 0
      ? `Owner's notes about them (newest first):\n${input.notes.map((n) => `- ${n}`).join("\n")}`
      : "The owner has no notes about them.",
    input.change
      ? `Detected change — the reason to write: ${input.change.field} ${input.change.oldValue ?? "(unknown)"} → ${input.change.newValue ?? "(unknown)"}${input.change.reason ? `. Why now: ${input.change.reason}` : ""}`
      : null,
    input.intent ? `The owner's intent for this message: ${input.intent}` : null,
  ].filter(Boolean);
  return parts.join("\n");
}

export function draftFormat(): Record<string, unknown> {
  return {
    type: "json_schema",
    schema: {
      type: "object",
      properties: {
        message: { type: "string" },
        email: {
          type: "object",
          properties: { subject: { type: "string" }, body: { type: "string" } },
          required: ["subject", "body"],
          additionalProperties: false,
        },
        alternatives: { type: "array", items: { type: "string" } },
      },
      required: ["message", "email", "alternatives"],
      additionalProperties: false,
    },
  };
}

const draftSchema = z.object({
  message: z.string().trim().min(1).max(2000),
  email: z.object({
    subject: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(6000),
  }),
  alternatives: z.array(z.string().trim().min(1).max(600)).max(5),
});

export function parseDraft(text: string): Draft | null {
  const parsed = draftSchema.safeParse(extractJson(text));
  if (!parsed.success) return null;
  return { ...parsed.data, alternatives: parsed.data.alternatives.slice(0, 2) };
}

/** Gmail's compose URL with the draft prefilled — nothing is sent. */
export function gmailComposeUrl(to: string | null, subject: string, body: string): string {
  const params = new URLSearchParams({ view: "cm", su: subject, body });
  if (to) params.set("to", to);
  return `https://mail.google.com/mail/?${params.toString()}`;
}
