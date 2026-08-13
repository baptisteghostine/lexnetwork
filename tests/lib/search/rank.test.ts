import { describe, expect, it } from "vitest";

import { nicknameEquivalents, nicknamesMatch } from "@/lib/dedupe/nicknames";
import { jaroWinkler } from "@/lib/search/jaro";
import {
  ftsQueryForContacts,
  ftsQueryForNotes,
  nameScore,
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
