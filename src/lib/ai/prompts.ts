// Prompt builders + output parsers for the non-search AI features
// (SPEC §11). Pure — server actions feed them data and pass the result to
// the call core. Parsers are strict: malformed model output fails loudly
// rather than half-applying.

import { z } from "zod";

import { extractJson } from "@/lib/ai/nl-filter";

// ---------- conversation starters ----------

export type OpenersInput = {
  displayName: string;
  title: string | null;
  company: string | null;
  workHistory: { company: string; title: string | null; isCurrent: boolean }[];
  /** The owner's own recent notes about this person, newest first. */
  notes: string[];
  /** Detected job change, when launched from a network-updates card. */
  change: { field: string; oldValue: string | null; newValue: string | null } | null;
};

export const OPENERS_SYSTEM = [
  "You draft short, warm, specific conversation openers the owner of a personal CRM can send to reconnect with someone they know.",
  "Write 3 distinct openers, each 1–2 sentences, first person, ready to paste into an email or message. No subject lines, no placeholders like [name], no sign-offs.",
  "Ground each opener in the provided context (their role, history, the owner's notes, a recent change). Never invent facts not present in the context.",
  'Respond with JSON only: {"openers": ["...", "...", "..."]}',
].join("\n");

export function buildOpenersPrompt(input: OpenersInput): string {
  const parts = [
    `Person: ${input.displayName}`,
    input.title || input.company
      ? `Role: ${[input.title, input.company].filter(Boolean).join(" at ")}`
      : null,
    input.workHistory.length > 0
      ? `Work history: ${input.workHistory
          .map(
            (w) =>
              `${w.title ? `${w.title} at ` : ""}${w.company}${w.isCurrent ? " (current)" : ""}`
          )
          .join("; ")}`
      : null,
    input.change
      ? `Recent change: ${input.change.field} changed from ${input.change.oldValue ?? "unknown"} to ${input.change.newValue ?? "unknown"} — this is the reason to reach out.`
      : null,
    input.notes.length > 0
      ? `Owner's notes about them (newest first):\n${input.notes
          .map((n) => `- ${n}`)
          .join("\n")}`
      : "Owner has no notes about them.",
  ].filter(Boolean);
  return parts.join("\n");
}

export function openersFormat(): Record<string, unknown> {
  return {
    type: "json_schema",
    schema: {
      type: "object",
      properties: {
        openers: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["openers"],
      additionalProperties: false,
    },
  };
}

const openersSchema = z.object({ openers: z.array(z.string().min(1)).min(1).max(5) });

export function parseOpeners(text: string): string[] | null {
  const raw = extractJson(text);
  const parsed = openersSchema.safeParse(raw);
  return parsed.success ? parsed.data.openers.slice(0, 3) : null;
}

// ---------- note summarization ----------

export const SUMMARIZE_SYSTEM = [
  "You summarize one personal-CRM note the owner wrote about a contact.",
  "Write 2–4 sentences capturing the substance: facts about the person, commitments, dates, follow-ups. Keep names and specifics; drop filler.",
  "Respond with the summary text only — no preamble, no headers.",
].join("\n");

/** Notes shorter than this don't get a summarize affordance (SPEC §11). */
export const SUMMARIZE_MIN_CHARS = 1500;

export function buildSummarizePrompt(noteBody: string): string {
  return `Note:\n${noteBody}`;
}

// ---------- auto-tagging ----------

export type AutoTagContact = {
  id: number;
  displayName: string;
  title: string | null;
  company: string | null;
  location: string | null;
  bio: string | null;
  workHistory: string[];
  existingTags: string[];
};

export function buildAutoTagSystem(allTags: string[]): string {
  return [
    "You suggest organizational tags for contacts in the owner's personal CRM, based on each contact's profile summary.",
    `The owner's existing tags: ${JSON.stringify(allTags)}`,
    "Strongly prefer existing tags — suggest a new tag only when no existing tag fits and the profile clearly supports one. Reuse the owner's exact spelling for existing tags.",
    "Suggest at most 3 tags per contact, only where the profile gives real evidence. No suggestion is better than a weak one. Skip tags the contact already has.",
    'Respond with JSON only: {"suggestions": [{"contactId": <id>, "tagName": "...", "isNewTag": true|false, "confidence": <0..1>, "rationale": "one short sentence"}]}',
  ].join("\n");
}

export function buildAutoTagPrompt(contacts: AutoTagContact[]): string {
  return contacts
    .map((c) =>
      [
        `Contact ${c.id}: ${c.displayName}`,
        c.title || c.company
          ? `  Role: ${[c.title, c.company].filter(Boolean).join(" at ")}`
          : null,
        c.location ? `  Location: ${c.location}` : null,
        c.bio ? `  Bio: ${c.bio}` : null,
        c.workHistory.length > 0
          ? `  Past companies: ${c.workHistory.join(", ")}`
          : null,
        c.existingTags.length > 0
          ? `  Already tagged: ${c.existingTags.join(", ")}`
          : "  No tags yet.",
      ]
        .filter(Boolean)
        .join("\n")
    )
    .join("\n\n");
}

export function autoTagFormat(): Record<string, unknown> {
  return {
    type: "json_schema",
    schema: {
      type: "object",
      properties: {
        suggestions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              contactId: { type: "integer" },
              tagName: { type: "string" },
              isNewTag: { type: "boolean" },
              confidence: { type: "number" },
              rationale: { type: "string" },
            },
            required: ["contactId", "tagName", "isNewTag", "confidence", "rationale"],
            additionalProperties: false,
          },
        },
      },
      required: ["suggestions"],
      additionalProperties: false,
    },
  };
}

export type TagSuggestion = {
  contactId: number;
  tagName: string;
  isNewTag: boolean;
  confidence: number;
  rationale: string;
};

const tagSuggestionsSchema = z.object({
  suggestions: z.array(
    z.object({
      contactId: z.number().int(),
      tagName: z.string().trim().min(1).max(50),
      isNewTag: z.boolean(),
      confidence: z.number().min(0).max(1),
      rationale: z.string().trim().min(1).max(300),
    })
  ),
});

/**
 * Parse + sanitize a batch's suggestions: only known contact ids survive,
 * `isNewTag` is recomputed against the owner's real tag list (the model's
 * own claim is advisory), and tags the contact already has are dropped.
 */
export function parseTagSuggestions(
  text: string,
  contacts: AutoTagContact[],
  allTags: string[]
): TagSuggestion[] | null {
  const raw = extractJson(text);
  const parsed = tagSuggestionsSchema.safeParse(raw);
  if (!parsed.success) return null;
  const byId = new Map(contacts.map((c) => [c.id, c]));
  const known = new Set(allTags.map((t) => t.toLowerCase()));
  const out: TagSuggestion[] = [];
  for (const s of parsed.data.suggestions) {
    const contact = byId.get(s.contactId);
    if (!contact) continue;
    if (
      contact.existingTags.some(
        (t) => t.toLowerCase() === s.tagName.toLowerCase()
      )
    ) {
      continue;
    }
    out.push({ ...s, isNewTag: !known.has(s.tagName.toLowerCase()) });
  }
  return out;
}
