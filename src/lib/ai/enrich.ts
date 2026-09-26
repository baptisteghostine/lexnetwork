// Profile enrichment (SPEC §11, owner request 2026-09-26): "what I know
// about them", written by the model from everything Rolo has captured —
// headline, history, education, notes, exchanges, changes, custom fields
// — and stored as an annotation beside the profile. It never writes a
// contact field: it is the paragraph the owner would otherwise assemble
// in their head before a call. Pure; the server module feeds rows.

import { z } from "zod";

import { extractJson } from "@/lib/ai/nl-filter";

export type EnrichInput = {
  displayName: string;
  title: string | null;
  company: string | null;
  location: string | null;
  bio: string | null;
  workHistory: { company: string; title: string | null; startDate: string | null; endDate: string | null; isCurrent: boolean }[];
  education: { school: string; degree: string | null; field: string | null; endYear: number | null }[];
  tags: string[];
  groups: string[];
  customFields: { name: string; value: string }[];
  /** Newest first, trimmed. */
  notes: string[];
  /** Counts and the newest exchanges, for the relationship read. */
  exchanges: { total: number; firstAt: number | null; lastAt: number | null; recent: string[] };
  changes: { field: string; oldValue: string | null; newValue: string | null; detectedAt: number }[];
  now: number;
};

export type EnrichedProfile = {
  /** 2–5 sentences: who they are to the owner and what matters now. */
  summary: string;
  facts: { label: string; value: string }[];
  relationship: { strength: 1 | 2 | 3 | 4 | 5; why: string };
  /** Things the owner does not know yet and could ask. */
  openQuestions: string[];
};

export const ENRICH_SYSTEM = [
  "You write the private profile card the owner of a personal CRM reads before talking to someone: what they know about this person, from their own data only.",
  "summary: 2–5 sentences, third person, plain. Lead with who this person is to the owner (how they met, shared context) when the data shows it, then what they do, then what is current (a recent move, an open thread).",
  "facts: up to 10 short label/value pairs worth a glance — e.g. School, City, Previous employers, Interests, How we met, Family, Languages, Promised — only when the data supports them. Never guess or infer beyond the data.",
  "relationship: strength 1 (barely met) to 5 (close, frequent, mutual), with one line of why, judged from exchange counts, recency, notes and tags.",
  "openQuestions: up to 3 concrete things the owner could ask next time to fill a real gap. Empty if the profile is rich.",
  'Respond with JSON only: {"summary": "...", "facts": [{"label": "...", "value": "..."}], "relationship": {"strength": 1, "why": "..."}, "openQuestions": ["..."]}',
].join("\n");

function ago(at: number | null, now: number): string {
  if (at === null) return "never";
  const days = Math.max(0, Math.floor((now - at) / (24 * 60 * 60 * 1000)));
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months < 24 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`;
}

export function buildEnrichPrompt(input: EnrichInput): string {
  const parts = [
    `Person: ${input.displayName}`,
    input.title || input.company ? `Current: ${[input.title, input.company].filter(Boolean).join(" at ")}` : null,
    input.location ? `Location: ${input.location}` : null,
    input.bio ? `Headline/bio: ${input.bio}` : null,
    input.workHistory.length > 0
      ? `Work history: ${input.workHistory
          .map(
            (w) =>
              `${w.title ? `${w.title} at ` : ""}${w.company}${w.startDate ? ` (${w.startDate}–${w.isCurrent ? "now" : (w.endDate ?? "?")})` : w.isCurrent ? " (current)" : ""}`
          )
          .join("; ")}`
      : null,
    input.education.length > 0
      ? `Education: ${input.education
          .map((e) => [e.degree, e.field, e.school, e.endYear ? String(e.endYear) : null].filter(Boolean).join(", "))
          .join("; ")}`
      : null,
    input.tags.length > 0 ? `Tags: ${input.tags.join(", ")}` : null,
    input.groups.length > 0 ? `Groups: ${input.groups.join(", ")}` : null,
    input.customFields.length > 0
      ? `Fields: ${input.customFields.map((f) => `${f.name}: ${f.value}`).join("; ")}`
      : null,
    `Exchanges: ${input.exchanges.total} logged, first ${ago(input.exchanges.firstAt, input.now)}, last ${ago(input.exchanges.lastAt, input.now)}${
      input.exchanges.recent.length > 0 ? `\nRecent:\n${input.exchanges.recent.map((r) => `- ${r}`).join("\n")}` : ""
    }`,
    input.changes.length > 0
      ? `Detected changes: ${input.changes
          .map((c) => `${c.field} ${c.oldValue ?? "?"} → ${c.newValue ?? "?"} (${ago(c.detectedAt, input.now)})`)
          .join("; ")}`
      : null,
    input.notes.length > 0
      ? `Owner's notes (newest first):\n${input.notes.map((n) => `- ${n}`).join("\n")}`
      : "The owner has written no notes about them.",
  ].filter(Boolean);
  return parts.join("\n");
}

export function enrichFormat(): Record<string, unknown> {
  return {
    type: "json_schema",
    schema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        facts: {
          type: "array",
          items: {
            type: "object",
            properties: { label: { type: "string" }, value: { type: "string" } },
            required: ["label", "value"],
            additionalProperties: false,
          },
        },
        relationship: {
          type: "object",
          properties: { strength: { type: "integer" }, why: { type: "string" } },
          required: ["strength", "why"],
          additionalProperties: false,
        },
        openQuestions: { type: "array", items: { type: "string" } },
      },
      required: ["summary", "facts", "relationship", "openQuestions"],
      additionalProperties: false,
    },
  };
}

const schema = z.object({
  summary: z.string().trim().min(20).max(1500),
  facts: z.array(z.object({ label: z.string().trim().min(1).max(40), value: z.string().trim().min(1).max(200) })).max(20),
  relationship: z.object({ strength: z.number().int(), why: z.string().trim().max(300) }),
  openQuestions: z.array(z.string().trim().min(1).max(200)).max(10),
});

export function parseEnrichment(text: string): EnrichedProfile | null {
  const parsed = schema.safeParse(extractJson(text));
  if (!parsed.success) return null;
  const strength = Math.min(5, Math.max(1, parsed.data.relationship.strength)) as 1 | 2 | 3 | 4 | 5;
  return {
    summary: parsed.data.summary,
    facts: parsed.data.facts.slice(0, 10),
    relationship: { strength, why: parsed.data.relationship.why },
    openQuestions: parsed.data.openQuestions.slice(0, 3),
  };
}

/** Anything at all beyond a bare name? Otherwise the card would be padding. */
export function hasEnrichMaterial(input: EnrichInput): boolean {
  return (
    input.notes.length > 0 ||
    input.exchanges.total > 0 ||
    input.workHistory.length > 0 ||
    input.education.length > 0 ||
    !!input.bio ||
    !!(input.title && input.company)
  );
}
