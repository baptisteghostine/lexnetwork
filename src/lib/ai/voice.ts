// The owner's voice (SPEC §11, owner request 2026-09-26). Every draft
// Rolo writes should read like the owner wrote it. The guide is derived
// once from what they actually sent — the first lines of their outbound
// LinkedIn messages (the ZIP import keeps a 160-char snippet per message)
// plus any examples they paste — and stored in settings, editable. Pure:
// prompt in, guide out; the server action feeds it rows.

import { z } from "zod";

import { extractJson } from "@/lib/ai/nl-filter";

export const VOICE_SNIPPETS_MAX = 150;
/** Full messages add up; the newest ones up to this many characters go in. */
export const VOICE_TOTAL_CHARS = 20000;
export const VOICE_EXAMPLES_MAX_CHARS = 8000;
export const VOICE_GUIDE_MAX_CHARS = 3000;

export type VoiceInput = {
  /** Messages the owner sent, newest first — full text or the opening line. */
  snippets: string[];
  /** Full messages the owner pasted as examples (optional). */
  examples: string;
  ownerName: string | null;
};

export const VOICE_SYSTEM = [
  "You are describing how one specific person writes short professional messages, so that drafts written for them later sound like them.",
  "You are given messages they sent (full text where available, otherwise the opening line, cut at about 160 characters) and optionally a few messages they pasted.",
  "Write a compact style guide in second person (\"You open with…\"), 150–350 words, covering: greeting habits, how they refer to themselves and where they are from (school, company), typical length, tone and formality, sentence rhythm, punctuation and emoji habits, how they ask for things, how they close, and the language(s) they write in — if they mix languages, say when they use which.",
  "Quote 3–5 short verbatim phrases they reuse. Do not invent facts about their life; only describe what the samples show.",
  'Respond with JSON only: {"guide": "..."}',
].join("\n");

export function buildVoicePrompt(input: VoiceInput): string {
  const parts: string[] = [];
  if (input.ownerName) parts.push(`The writer's name: ${input.ownerName}`);
  const examples = input.examples.trim().slice(0, VOICE_EXAMPLES_MAX_CHARS);
  if (examples) parts.push(`Full messages they pasted as examples:\n${examples}`);
  const snippets: string[] = [];
  let total = 0;
  for (const raw of input.snippets) {
    const s = raw.replace(/\s+/g, " ").trim();
    if (!s) continue;
    if (snippets.length >= VOICE_SNIPPETS_MAX) break;
    // A message too long for what is left is skipped, not the end of the
    // list: one long newest message must not leave the guide with two samples.
    if (total + s.length > VOICE_TOTAL_CHARS) continue;
    snippets.push(s);
    total += s.length;
  }
  if (snippets.length > 0) {
    parts.push(
      `${snippets.length} messages they sent (newest first; long ones are the full text, short ones may be just the opening line):\n${snippets
        .map((s) => `- ${s}`)
        .join("\n")}`
    );
  }
  return parts.join("\n\n");
}

export function voiceFormat(): Record<string, unknown> {
  return {
    type: "json_schema",
    schema: {
      type: "object",
      properties: { guide: { type: "string" } },
      required: ["guide"],
      additionalProperties: false,
    },
  };
}

const voiceSchema = z.object({ guide: z.string().min(40) });

export function parseVoiceGuide(text: string): string | null {
  const parsed = voiceSchema.safeParse(extractJson(text));
  return parsed.success ? parsed.data.guide.trim().slice(0, VOICE_GUIDE_MAX_CHARS) : null;
}

/** Enough material to build a guide from? Fewer than this and the model would be guessing. */
export const VOICE_MIN_SAMPLES = 5;

export function hasEnoughVoiceMaterial(input: VoiceInput): boolean {
  return input.snippets.length >= VOICE_MIN_SAMPLES || input.examples.trim().length >= 200;
}

/**
 * The system-prompt fragment every drafting feature prepends. With no
 * guide, drafts fall back to a neutral, warm register and say so.
 */
export function voiceContext(guide: string | null, ownerName: string | null): string {
  const who = ownerName ? `The owner's name is ${ownerName}.` : "";
  if (!guide) {
    return `${who} No style guide is available: write warm, plain, first-person messages with no filler and no corporate phrasing.`.trim();
  }
  return `${who} Write in the owner's own voice, following this style guide exactly:\n<voice>\n${guide}\n</voice>`.trim();
}
