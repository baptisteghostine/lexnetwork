import { describe, expect, it } from "vitest";

import { filterCompanies, groupCompanies } from "@/lib/agent/companies";
import {
  clip,
  clipBody,
  daysAgo,
  iso,
  parseDate,
  RESULT_CHAR_CAP,
  serializeCapped,
} from "@/lib/agent/shape";

// SPEC §14: how the connector's answers are shaped and bounded.

describe("shape helpers", () => {
  it("dates read as ISO, and nothing reads as nothing", () => {
    expect(iso(Date.UTC(2026, 10, 19, 9, 30))).toBe("2026-11-19T09:30:00.000Z");
    expect(iso(null)).toBeNull();
    expect(iso(undefined)).toBeNull();
    expect(iso(0)).toBe("1970-01-01T00:00:00.000Z");
  });

  it("days since are whole, never negative, and null without a date", () => {
    const now = Date.UTC(2026, 10, 19, 12);
    expect(daysAgo(now - 3 * 86_400_000 - 1000, now)).toBe(3);
    expect(daysAgo(now, now)).toBe(0);
    expect(daysAgo(now + 86_400_000, now)).toBe(0);
    expect(daysAgo(null, now)).toBeNull();
  });

  it("clip collapses whitespace and cuts with an ellipsis; empty is null", () => {
    expect(clip("  a\n\n b\t c ", 100)).toBe("a b c");
    expect(clip("abcdefghij", 5)).toBe("abcd…");
    expect(clip("abcdefghij", 5)).toHaveLength(5);
    expect(clip("   ", 5)).toBeNull();
    expect(clip(null, 5)).toBeNull();
    expect(clip("ab", 2)).toBe("ab");
  });

  it("clipBody keeps paragraphs", () => {
    expect(clipBody("Hi Ana,\r\n\r\n\r\n\r\nThanks.\n", 100)).toBe("Hi Ana,\n\nThanks.");
    expect(clipBody("x".repeat(50), 10)).toHaveLength(10);
    expect(clipBody("", 10)).toBeNull();
  });

  it("parseDate takes a day or a timestamp, and nothing looser", () => {
    expect(parseDate("2026-11-19")).toBe(Date.UTC(2026, 10, 19));
    expect(parseDate("2026-11-19T09:30:00Z")).toBe(Date.UTC(2026, 10, 19, 9, 30));
    expect(parseDate("2026-11-19T09:30:00+01:00")).toBe(Date.UTC(2026, 10, 19, 8, 30));
    for (const bad of ["", "yesterday", "19/11/2026", "2026-13-45", "2026-11-19; DROP TABLE", "1731000000000"]) {
      expect(parseDate(bad), bad).toBeNull();
    }
  });
});

describe("serializeCapped", () => {
  it("leaves an answer under the cap untouched", () => {
    const data = { total: 2, contacts: [{ id: 1 }, { id: 2 }] };
    expect(serializeCapped(data, "contacts")).toBe(JSON.stringify(data));
  });

  it("sheds from the tail of the named list and says so", () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: i, text: "x".repeat(200) }));
    const text = serializeCapped({ total: 50, contacts: rows }, "contacts", 3000);
    expect(text.length).toBeLessThanOrEqual(3000);
    const parsed = JSON.parse(text) as { contacts: { id: number }[]; truncated: boolean; truncatedNote: string; total: number };
    expect(parsed.truncated).toBe(true);
    expect(parsed.total).toBe(50);
    expect(parsed.contacts.length).toBeGreaterThan(0);
    expect(parsed.contacts.length).toBeLessThan(50);
    // The head survives, in order.
    expect(parsed.contacts.map((c) => c.id)).toEqual(parsed.contacts.map((_, i) => i));
    expect(parsed.truncatedNote).toContain(`first ${parsed.contacts.length} of 50`);
  });

  it("an answer that cannot be shrunk becomes an honest error, never an oversized one", () => {
    const blob = { text: "x".repeat(5000) };
    for (const text of [
      serializeCapped(blob, undefined, 1000),
      serializeCapped(blob, "missing", 1000),
      serializeCapped({ contacts: [{ text: "x".repeat(5000) }] }, "contacts", 1000),
    ]) {
      expect(text.length).toBeLessThanOrEqual(1000);
      expect(JSON.parse(text)).toMatchObject({ truncated: true, error: expect.any(String) });
    }
  });

  it("the default cap is the one the plan promises", () => {
    expect(RESULT_CHAR_CAP).toBe(60_000);
  });
});

describe("groupCompanies", () => {
  const rows = [
    { company: "Goldman Sachs", title: "Analyst" },
    { company: "goldman sachs", title: "Analyst" },
    { company: "Goldman Sachs Ltd.", title: "Vice President" },
    { company: "Goldman  Sachs", title: null },
    { company: "Goldman Sachs Asset Management", title: "Associate" },
    { company: "Moelis & Company", title: "Managing Director" },
    { company: "  ", title: "Nobody" },
    { company: null, title: "Nobody" },
  ];

  it("folds spellings that differ only by case, spacing, punctuation or legal suffix", () => {
    const groups = groupCompanies(rows);
    expect(groups.map((g) => [g.company, g.count])).toEqual([
      ["Goldman Sachs", 4],
      ["Goldman Sachs Asset Management", 1],
      ["Moelis & Company", 1],
    ]);
    expect(groups[0].spellings).toEqual(["Goldman Sachs", "Goldman Sachs Ltd.", "goldman sachs"]);
    expect(groups[0].sampleTitles).toEqual(["Analyst", "Vice President"]);
  });

  it("does not merge a firm with its differently named arm", () => {
    expect(groupCompanies(rows).filter((g) => g.company.startsWith("Goldman"))).toHaveLength(2);
  });

  it("orders by size then name, and is stable for equal input", () => {
    const again = groupCompanies([...rows].reverse());
    expect(again.map((g) => g.count)).toEqual([4, 1, 1]);
    expect(again.slice(1).map((g) => g.company)).toEqual(["Goldman Sachs Asset Management", "Moelis & Company"]);
  });

  it("filters by any spelling, case-insensitively", () => {
    const groups = groupCompanies(rows);
    expect(filterCompanies(groups, "MOELIS").map((g) => g.company)).toEqual(["Moelis & Company"]);
    expect(filterCompanies(groups, "ltd").map((g) => g.company)).toEqual(["Goldman Sachs"]);
    expect(filterCompanies(groups, "  ")).toHaveLength(3);
    expect(filterCompanies(groups, "nobody")).toEqual([]);
  });

  it("handles nothing", () => {
    expect(groupCompanies([])).toEqual([]);
  });
});
