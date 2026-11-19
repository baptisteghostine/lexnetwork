import { describe, expect, it } from "vitest";

import { nicknameEquivalents, nicknamesMatch } from "@/lib/dedupe/nicknames";
import { jaroWinkler } from "@/lib/search/jaro";
import {
  ftsQueryForContacts,
  ftsQueryForNotes,
  matchesEveryWord,
  nameScore,
  queryWords,
  startsAWord,
} from "@/lib/search/rank";

describe("jaroWinkler", () => {
  it("scores identity 1 and disjoint 0", () => {
    expect(jaroWinkler("kate", "kate")).toBe(1);
    expect(jaroWinkler("abc", "xyz")).toBe(0);
  });
  it("rewards shared prefixes", () => {
    expect(jaroWinkler("katee", "kate")).toBeGreaterThan(0.9);
    expect(jaroWinkler("martha", "marhta")).toBeCloseTo(0.961, 2);
  });
});

describe("nicknames", () => {
  it("links common pairs both ways", () => {
    expect(nicknamesMatch("bob", "robert")).toBe(true);
    expect(nicknamesMatch("Katherine", "katie")).toBe(true);
    expect(nicknamesMatch("bill", "william")).toBe(true);
    expect(nicknamesMatch("bob", "william")).toBe(false);
  });
  it("expands equivalents including the name itself", () => {
    const eq = nicknameEquivalents("kate");
    expect(eq).toContain("kate");
    expect(eq).toContain("katherine");
  });
});

describe("nameScore (SPEC §7 AC: katee finds Kate and Katherine)", () => {
  const contacts = [
    "Kate Brennan",
    "Katherine Woods",
    "Marc Dubois",
    "Diego Fernandez",
    "Tom Becker",
    "Ana Silva",
    "Kenji Watanabe",
  ];
  it("ranks Kate and Katherine in the top 2 for 'katee'", () => {
    const ranked = [...contacts].sort(
      (a, b) => nameScore("katee", b) - nameScore("katee", a)
    );
    expect(ranked.slice(0, 2).sort()).toEqual([
      "Kate Brennan",
      "Katherine Woods",
    ]);
  });
  it("nickname floor: 'bob' scores Robert highly", () => {
    expect(nameScore("bob", "Robert Miller")).toBeGreaterThanOrEqual(0.93);
  });
  it("is diacritic-insensitive", () => {
    expect(nameScore("lucia", "Lucía Moreno")).toBeGreaterThan(0.95);
  });
});

describe("FTS query builders (SPEC §7: special characters never 500)", () => {
  it("quotes tokens and doubles embedded quotes", () => {
    const q = ftsQueryForContacts('ka"te');
    expect(q).toContain('"ka""te"');
  });
  it("adds nickname equivalents and the leading trigram", () => {
    const q = ftsQueryForContacts("katee") ?? "";
    expect(q).toContain('"kat"'); // trigram probe reaches Katherine
    expect(q).toContain('"katee"');
  });
  it("returns null under 3 chars (caller falls back to LIKE)", () => {
    expect(ftsQueryForContacts("ka")).toBeNull();
  });
  it("note queries prefix-match the last word only", () => {
    expect(ftsQueryForNotes("pitch dec")).toBe('"pitch" "dec"*');
    // Embedded quotes are doubled, never left to break the MATCH grammar.
    expect(ftsQueryForNotes('say "hi"')).toBe('"say" """hi"""*');
  });
});

// SPEC §14: the connector's text search matches the beginnings of words.
describe("word-start matching (agent search)", () => {
  it("splits a query into normalized words", () => {
    expect(queryWords("  Chloé   DUBOIS ")).toEqual(["chloe", "dubois"]);
    expect(queryWords("")).toEqual([]);
    expect(queryWords("   ")).toEqual([]);
    expect(queryWords("M&A tech")).toEqual(["m&a", "tech"]);
  });

  it("a word matches where a word begins, not inside one", () => {
    expect(startsAWord("ana silva", "ana")).toBe(true);
    expect(startsAWord("senior analyst", "ana")).toBe(true);
    expect(startsAWord("managing director", "ana")).toBe(false);
    expect(startsAWord("svp", "vp")).toBe(false);
    expect(startsAWord("svp / vp", "vp")).toBe(true);
    expect(startsAWord("tmt m&a", "m&a")).toBe(true);
    expect(startsAWord("x(tech)", "tech")).toBe(true);
    expect(startsAWord("o'brien", "brien")).toBe(true);
    expect(startsAWord("2024 intern", "2024")).toBe(true);
    expect(startsAWord("a2024", "2024")).toBe(false);
    expect(startsAWord("", "a")).toBe(false);
    expect(startsAWord("anything", "")).toBe(true);
  });

  it("every word must be found, in any order, accents and case aside", () => {
    expect(matchesEveryWord("Chloé Dubois | Moelis & Company | Managing Director", ["dubois", "chloe"])).toBe(true);
    expect(matchesEveryWord("Chloé Dubois | Moelis & Company | Managing Director", ["chloe", "goldman"])).toBe(false);
    expect(matchesEveryWord("Technology Investment Banking", ["bank", "tech"])).toBe(true);
    expect(matchesEveryWord("anything", [])).toBe(true);
  });
});
