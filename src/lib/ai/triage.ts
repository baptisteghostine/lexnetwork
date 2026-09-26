// Job-change triage (SPEC §5/§11, owner request 2026-09-26). An import
// that reads a whole network differently produces hundreds of "changes",
// most of them a headline reworded. The model reads each open change with
// the little context Rolo has and says what it is, how much it matters,
// why the owner would reach out now, and — in the owner's voice — the
// first line they could send. Pure: the job feeds rows and stores the
// validated result as an annotation; nothing here touches the change.

import { z } from "zod";

import { extractJson } from "@/lib/ai/nl-filter";

export const TRIAGE_BATCH = 10;

export type TriageChange = {
  id: number;
  displayName: string;
  field: "company" | "title";
  oldValue: string | null;
  newValue: string | null;
  /** Current title/company after the change, for context. */
  title: string | null;
  company: string | null;
  /** Whole days since the owner last spoke to them; null = never. */
  lastContactDays: number | null;
  starred: boolean;
  /** The owner's most recent note about them, trimmed, or null. */
  lastNote: string | null;
  /** How the owner knows them, when tags say so. */
  tags: string[];
};

export const TRIAGE_KINDS = [
  "new_company",
  "promotion",
  "lateral",
  "rename",
  "noise",
] as const;
export type TriageKind = (typeof TRIAGE_KINDS)[number];

export type ChangeTriage = {
  kind: TriageKind;
  /** 0–1: how much this deserves the owner's attention. */
  significance: number;
  /** One line: why reach out now. Empty for noise. */
  reason: string;
  /** The first message, in the owner's voice. Empty for noise. */
  opener: string;
};

export const TRIAGE_KIND_LABEL: Record<TriageKind, string> = {
  new_company: "New company",
  promotion: "Promotion",
  lateral: "New role",
  rename: "Rename",
  noise: "Headline tweak",
};

export function buildTriageSystem(voiceContext: string): string {
  return [
    "You triage job changes detected in the owner's personal network (LinkedIn headlines and positions compared between imports).",
    "For each change decide its kind:",
    "- new_company: they moved to a different employer.",
    "- promotion: same employer, clearly more senior title.",
    "- lateral: same employer, different role at a similar level.",
    "- rename: the same job worded differently, or a company renamed/rebranded/merged (e.g. 'Santander CIB' → 'Santander', 'Sr. PM' → 'Senior Product Manager').",
    "- noise: a headline tagline change with no real job change ('Building X | ex-Y', a slogan, capitalisation, punctuation).",
    "significance is 0–1: a move or promotion of someone the owner knows well is near 1; a rename or noise is under 0.3. Weigh how warm the relationship is (recent contact, starred, notes).",
    "reason: one specific line the owner reads on a card — why this is worth a message now. Never restate the diff. Empty string for rename/noise.",
    "opener: the first message the owner could send, 1–3 sentences, first person, no placeholders, no subject line, grounded only in the facts given. Empty string for rename/noise.",
    voiceContext,
    'Respond with JSON only: {"items": [{"id": <change id>, "kind": "...", "significance": 0.0, "reason": "...", "opener": "..."}]} — one item per change, ids exactly as given.',
  ].join("\n");
}

export function buildTriagePrompt(changes: TriageChange[]): string {
  return changes
    .map((c) => {
      const parts = [
        `#${c.id} ${c.displayName} — ${c.field}: ${c.oldValue ?? "(empty)"} → ${c.newValue ?? "(empty)"}`,
        `now: ${[c.title, c.company].filter(Boolean).join(" at ") || "unknown"}`,
        c.lastContactDays === null ? "never spoken" : `last contact ${c.lastContactDays}d ago`,
        c.starred ? "starred" : null,
        c.tags.length > 0 ? `tags: ${c.tags.join(", ")}` : null,
        c.lastNote ? `owner's note: ${c.lastNote}` : null,
      ].filter(Boolean);
      return parts.join(" · ");
    })
    .join("\n");
}

export function triageFormat(): Record<string, unknown> {
  return {
    type: "json_schema",
    schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "integer" },
              kind: { type: "string", enum: [...TRIAGE_KINDS] },
              significance: { type: "number" },
              reason: { type: "string" },
              opener: { type: "string" },
            },
            required: ["id", "kind", "significance", "reason", "opener"],
            additionalProperties: false,
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    },
  };
}

const itemSchema = z.object({
  id: z.number().int(),
  kind: z.enum(TRIAGE_KINDS),
  significance: z.number(),
  reason: z.string(),
  opener: z.string(),
});
const triageSchema = z.object({ items: z.array(itemSchema) });

/**
 * Strict parse: only ids that were sent, each at most once; significance
 * clamped; rename/noise never carry a reason or opener (a model that
 * writes one anyway is overruled, so the card stays honest).
 */
export function parseTriage(text: string, allowedIds: Set<number>): Map<number, ChangeTriage> {
  const out = new Map<number, ChangeTriage>();
  const parsed = triageSchema.safeParse(extractJson(text));
  if (!parsed.success) return out;
  for (const item of parsed.data.items) {
    if (!allowedIds.has(item.id) || out.has(item.id)) continue;
    const quiet = item.kind === "rename" || item.kind === "noise";
    const significance = Math.min(1, Math.max(0, Number.isFinite(item.significance) ? item.significance : 0));
    out.set(item.id, {
      kind: item.kind,
      significance: quiet ? Math.min(significance, 0.29) : significance,
      reason: quiet ? "" : item.reason.trim().slice(0, 300),
      opener: quiet ? "" : item.opener.trim().slice(0, 600),
    });
  }
  return out;
}

export const TRIAGE_HIDE_BELOW_DEFAULT = 0.3;

export function clampHideBelow(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : TRIAGE_HIDE_BELOW_DEFAULT;
  return Math.min(0.9, Math.max(0, n));
}

/** Folded away on Today and left out of emails, but never dismissed. */
export function isLowSignal(t: ChangeTriage | null | undefined, hideBelow: number): boolean {
  return !!t && t.significance < hideBelow;
}
