// The iterative Ask (SPEC §11, owner request 2026-09-26). Instead of one
// filter and a shortlist, the model first plans how to look — compiled
// filters, keyword searches over contacts, searches over the owner's
// notes — the database runs the plan, and the model answers over what
// came back, optionally asking once for the full timelines of a few
// people before committing. Pure: validators stand between the model and
// the database, as everywhere in lib/ai.

import { z } from "zod";

import { filterSetJsonSchema, validateAiFilter, type FilterCatalog } from "@/lib/ai/nl-filter";
import type { FilterSet } from "@/lib/filters/types";

export const PLAN_FILTERS_MAX = 2;
export const PLAN_SEARCHES_MAX = 3;
export const NEED_MORE_MAX = 6;

export type AskPlan = {
  filters: FilterSet[];
  searches: string[];
  noteSearches: string[];
  /** The model wants recent exchanges on every candidate, not just the last one. */
  needTimeline: boolean;
};

export function buildAskPlanSystem(nlFilterSystem: string): string {
  return [
    "You are planning how to look up people in the owner's personal CRM to answer their question. You never see contact data at this step.",
    "Return up to two filter sets (each is a set of clauses that AND together — use the clause shapes below exactly), up to three keyword searches over contact names/titles/companies, and up to three keyword searches over the owner's own notes. Leave a list empty when it would not help.",
    "Prefer specific filters (a company, a title word, a timeframe) over broad ones; a question about a person by name is a keyword search, not a filter. Set needTimeline true when the answer depends on what was said or when the owner last spoke to people (\"who did I promise an intro to\", \"who went quiet\").",
    "",
    "The filter vocabulary (from the search compiler):",
    nlFilterSystem,
    "",
    'Respond with JSON only: {"filters": [<filter set>, ...], "searches": ["..."], "noteSearches": ["..."], "needTimeline": true|false}',
  ].join("\n");
}

export function askPlanFormat(): Record<string, unknown> {
  return {
    type: "json_schema",
    schema: {
      type: "object",
      properties: {
        filters: { type: "array", items: filterSetJsonSchema() },
        searches: { type: "array", items: { type: "string" } },
        noteSearches: { type: "array", items: { type: "string" } },
        needTimeline: { type: "boolean" },
      },
      required: ["filters", "searches", "noteSearches", "needTimeline"],
      additionalProperties: false,
    },
  };
}

const planSchema = z.object({
  filters: z.array(z.unknown()).max(10),
  searches: z.array(z.string()).max(10),
  noteSearches: z.array(z.string()).max(10),
  needTimeline: z.boolean(),
});

/**
 * Every filter set goes through the NL-search validator (unknown ids and
 * dimensions are rejected there); an invalid set is dropped, not the
 * whole plan. Searches are trimmed, deduped and capped.
 */
export function validateAskPlan(raw: unknown, catalog: FilterCatalog): AskPlan | null {
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) return null;
  const filters: FilterSet[] = [];
  for (const f of parsed.data.filters) {
    const v = validateAiFilter(f, catalog);
    if (v.ok && v.filter.clauses.length > 0) filters.push(v.filter);
    if (filters.length >= PLAN_FILTERS_MAX) break;
  }
  const clean = (list: string[]) =>
    [...new Set(list.map((s) => s.trim().slice(0, 80)).filter((s) => s.length >= 2))].slice(0, PLAN_SEARCHES_MAX);
  return {
    filters,
    searches: clean(parsed.data.searches),
    noteSearches: clean(parsed.data.noteSearches),
    needTimeline: parsed.data.needTimeline,
  };
}

/** How the panel describes what was looked at — the transparency line. */
export type AskStep = { kind: "filter" | "search" | "notes" | "warm" | "timeline"; label: string; hits: number };

// ---------- the follow-up round ----------

const needMoreSchema = z.object({
  needMore: z.object({ contactIds: z.array(z.number().int()), why: z.string().optional() }),
});

/**
 * Before answering, the model may ask once for full timelines of a few
 * candidates. Only ids it was shown, capped; anything else is ignored and
 * the answer path proceeds.
 */
export function parseNeedMore(raw: unknown, allowedIds: Set<number>): number[] | null {
  const parsed = needMoreSchema.safeParse(raw);
  if (!parsed.success) return null;
  const ids = [...new Set(parsed.data.needMore.contactIds)].filter((id) => allowedIds.has(id)).slice(0, NEED_MORE_MAX);
  return ids.length > 0 ? ids : null;
}

export type TimelineExcerpt = {
  contactId: number;
  name: string;
  /** "You messaged — Hi Kate… · 12d ago", newest first. */
  interactions: string[];
  /** The owner's notes, newest first, trimmed. */
  notes: string[];
};

export function buildTimelineAppendix(excerpts: TimelineExcerpt[]): string {
  return excerpts
    .map((t) => {
      const lines = [
        `## #${t.contactId} ${t.name}`,
        t.interactions.length > 0 ? `Exchanges:\n${t.interactions.map((i) => `- ${i}`).join("\n")}` : "No logged exchanges.",
        t.notes.length > 0 ? `Owner's notes:\n${t.notes.map((n) => `- ${n}`).join("\n")}` : "No notes.",
      ];
      return lines.join("\n");
    })
    .join("\n\n");
}
