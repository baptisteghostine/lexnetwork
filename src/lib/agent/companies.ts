// Employers across the network (SPEC §14, `list_companies`). The question
// "who do I know at the best firms" starts by seeing which firms are in
// the network at all — and "Goldman Sachs", "Goldman Sachs International"
// and "goldman sachs ltd" are spelled by whoever typed their profile.
// Pure: rows in, grouped rows out.

import { normalizeForCompare } from "@/lib/imports/planner";

export type CompanyInput = { company: string | null; title: string | null };

export type CompanyGroup = {
  /** The spelling most contacts use. */
  company: string;
  count: number;
  /** Every spelling folded into this row, most common first (≤5). */
  spellings: string[];
  /** The titles seen most often there (≤4) — what kind of people they are. */
  sampleTitles: string[];
};

/** Code-unit order: the same on every machine, unlike a locale compare. */
function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function topByCount(counts: Map<string, number>, limit: number): string[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || byText(a[0], b[0]))
    .slice(0, limit)
    .map(([value]) => value);
}

/**
 * Group contacts by employer. Two spellings are one company when they
 * are equal after the import engine's own comparison rule (case,
 * punctuation, legal suffixes) — deliberately no cleverer than that, so
 * "Goldman Sachs" and "Goldman Sachs Asset Management" stay apart for the
 * reader to judge.
 */
export function groupCompanies(rows: CompanyInput[]): CompanyGroup[] {
  const groups = new Map<
    string,
    { count: number; spellings: Map<string, number>; titles: Map<string, number> }
  >();
  for (const row of rows) {
    const raw = row.company?.replace(/\s+/g, " ").trim();
    if (!raw) continue;
    const key = normalizeForCompare("company", raw);
    if (!key) continue;
    const group = groups.get(key) ?? { count: 0, spellings: new Map(), titles: new Map() };
    group.count += 1;
    group.spellings.set(raw, (group.spellings.get(raw) ?? 0) + 1);
    const title = row.title?.replace(/\s+/g, " ").trim();
    if (title) group.titles.set(title, (group.titles.get(title) ?? 0) + 1);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((g) => {
      const spellings = topByCount(g.spellings, 5);
      return {
        company: spellings[0],
        count: g.count,
        spellings,
        sampleTitles: topByCount(g.titles, 4),
      };
    })
    .sort((a, b) => b.count - a.count || byText(a.company, b.company));
}

/** Keep the groups one of whose spellings contains `query` (case-insensitive). */
export function filterCompanies(groups: CompanyGroup[], query: string): CompanyGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  return groups.filter((g) => g.spellings.some((s) => s.toLowerCase().includes(q)));
}
