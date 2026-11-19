import { describe, expect, it } from "vitest";

import {
  applyPattern,
  bounceKey,
  EMAIL_PATTERN_EXAMPLE,
  EMAIL_PATTERNS,
  isDomain,
  isPersonalDomain,
  learnPatterns,
  matchingPatterns,
  nameParts,
  splitAddress,
  suggestEmails,
  type DomainEvidence,
  type Observation,
} from "@/lib/outreach/email-pattern";

// SPEC §17: a guess is only as good as the evidence printed next to it.

const ana = nameParts("Ana", "Silva")!;
const obs = (firmKey: string, first: string, last: string, email: string): Observation => ({ firmKey, firstName: first, lastName: last, email });

describe("names as addresses spell them", () => {
  it("drops accents, apostrophes, suffixes and asides", () => {
    expect(nameParts("José", "Muñoz")).toMatchObject({ first: "jose", last: "munoz", compound: false });
    expect(nameParts("Seán", "O'Brien")).toMatchObject({ first: "sean", last: "obrien" });
    expect(nameParts("Björn", "Straße")).toMatchObject({ first: "bjorn", last: "strasse" });
    expect(nameParts("Ana (She/Her)", "Silva, CFA")).toMatchObject({ first: "ana", last: "silva", compound: false });
    expect(nameParts("Robert", "Downey Jr.")).toMatchObject({ last: "downey" });
  });

  it("treats a hyphenated first name as one name and a second word as a middle name", () => {
    expect(nameParts("Jean-Pierre", "Dupont")).toMatchObject({ first: "jeanpierre", compound: true });
    expect(nameParts("Jean-Pierre", "Dupont")!.firstForms).toEqual(["jeanpierre", "jean-pierre", "jean"]);
    expect(nameParts("Ana Maria", "Silva")).toMatchObject({ first: "ana", compound: true });
  });

  it("writes a family name of several words together, and remembers the other spellings", () => {
    const n = nameParts("Maria", "de la Cruz")!;
    expect(n.last).toBe("delacruz");
    expect(n.lastForms).toEqual(["delacruz", "de-la-cruz", "cruz", "de"]);
    expect(nameParts("Amy", "Smith-Jones")!.lastForms).toEqual(["smithjones", "smith-jones", "jones", "smith"]);
  });

  it("splits a whole name left in one field, and gives up without a family name", () => {
    expect(nameParts("Ana Silva", "")).toMatchObject({ first: "ana", last: "silva" });
    expect(nameParts("Ana", null)).toBeNull();
    expect(nameParts("", "Silva")).toBeNull();
    expect(nameParts("😀", "🎉")).toBeNull();
  });
});

describe("patterns", () => {
  it("every pattern has an example, and the example is what it produces", () => {
    for (const p of EMAIL_PATTERNS) expect(applyPattern(p, ana)).toBe(EMAIL_PATTERN_EXAMPLE[p]);
    expect(new Set(Object.values(EMAIL_PATTERN_EXAMPLE)).size).toBe(EMAIL_PATTERNS.length);
  });

  it("reads the pattern back off an address — tags and a trailing number aside", () => {
    for (const p of EMAIL_PATTERNS) expect(matchingPatterns(ana, EMAIL_PATTERN_EXAMPLE[p])).toEqual([p]);
    expect(matchingPatterns(ana, "Ana.Silva")).toEqual(["first.last"]);
    expect(matchingPatterns(ana, "ana.silva2")).toEqual(["first.last"]);
    expect(matchingPatterns(ana, "asilva+news")).toEqual(["flast"]);
    expect(matchingPatterns(ana, "tmt-desk")).toEqual([]);
    expect(matchingPatterns(ana, "")).toEqual([]);
  });

  it("finds the pattern whichever spelling of a long name the firm used", () => {
    expect(matchingPatterns(nameParts("Maria", "de la Cruz")!, "maria.cruz")).toEqual(["first.last"]);
    expect(matchingPatterns(nameParts("Jean-Pierre", "Dupont")!, "jean-pierre.dupont")).toEqual(["first.last"]);
    expect(matchingPatterns(nameParts("Jean-Pierre", "Dupont")!, "jdupont")).toEqual(["flast"]);
  });

  it("an address a name cannot tell apart is evidence for nothing", () => {
    // "A Li": a.li is both first.last and f.last.
    expect(matchingPatterns(nameParts("A", "Li")!, "a.li").length).toBeGreaterThan(1);
  });
});

describe("domains", () => {
  it("knows a mailbox provider and a school from an employer", () => {
    for (const d of ["gmail.com", "Hotmail.co.uk", "london.edu", "alumni.insead.edu", "ox.ac.uk", "unimelb.edu.au", "alumni.lbs.com"]) {
      expect(isPersonalDomain(d), d).toBe(true);
    }
    for (const d of ["gs.com", "lazard.com", "education-first.com", "ac.com"]) expect(isPersonalDomain(d), d).toBe(false);
  });

  it("accepts a hostname and nothing that could be more than one", () => {
    for (const d of ["gs.com", "uk.evercore.com", "morgan-stanley.com"]) expect(isDomain(d), d).toBe(true);
    for (const d of ["gs", "gs.com/x", "gs.com?x=1", "a@gs.com", "gs..com", "-gs.com", "gs.com ", "GS.com", "gs.com&cc=x"]) {
      expect(isDomain(d), d).toBe(false);
    }
    expect(splitAddress("Ana.Silva@GS.com")).toEqual({ local: "Ana.Silva", domain: "gs.com" });
    expect(splitAddress("ana@")).toBeNull();
    expect(splitAddress("gs.com")).toBeNull();
  });
});

describe("learning a firm's format", () => {
  const seen = [
    obs("goldman sachs", "Ana", "Silva", "ana.silva@gs.com"),
    obs("goldman sachs", "Ben", "Okafor", "ben.okafor@gs.com"),
    obs("goldman sachs", "Cara", "Lin", "Cara.Lin@gs.com"),
    obs("goldman sachs", "Dev", "Patel", "dpatel@gs.com"),
    obs("goldman sachs", "Eve", "Stone", "tmt-desk@gs.com"),
    obs("goldman sachs", "Finn", "Hale", "finn.hale@gmail.com"),
    obs("goldman sachs", "Gus", "Ray", "gus.ray@alumni.insead.edu"),
    obs("goldman sachs", "Hal", "Moss", "hal.moss@ny.email.gs.com"),
    obs("lazard", "Ines", "Roy", "iroy@lazard.com"),
    obs("", "Jo", "Kim", "jo.kim@nowhere.com"),
    obs("lazard", "Kit", "Lowe", "not an address"),
  ];

  it("counts addresses per firm and domain, ignoring personal ones", () => {
    const learned = learnPatterns(seen);
    expect([...learned.keys()].sort()).toEqual(["goldman sachs", "lazard"]);
    expect(learned.get("goldman sachs")).toEqual<DomainEvidence[]>([
      { domain: "gs.com", addresses: 5, patterns: [{ pattern: "first.last", count: 3 }, { pattern: "flast", count: 1 }], unclear: 1 },
      { domain: "ny.email.gs.com", addresses: 1, patterns: [{ pattern: "first.last", count: 1 }], unclear: 0 },
    ]);
    expect(learned.get("lazard")).toEqual([{ domain: "lazard.com", addresses: 1, patterns: [{ pattern: "flast", count: 1 }], unclear: 0 }]);
  });

  it("offers the commonest format first, each with the count behind it", () => {
    const res = suggestEmails({ firstName: "Zoë", lastName: "Müller", firmName: "Goldman Sachs", learned: learnPatterns(seen).get("goldman sachs")!, stated: null });
    expect(res.reason).toBeNull();
    expect(res.candidates.map((c) => [c.email, c.pattern, c.strength])).toEqual([
      ["zoe.muller@gs.com", "first.last", "fair"],
      ["zmuller@gs.com", "flast", "weak"],
    ]);
    expect(res.candidates[0].evidence).toBe("3 of the 5 addresses Rolo holds at gs.com are built this way");
    expect(res.candidates[1].evidence).toBe("1 of the 5 addresses Rolo holds at gs.com is built this way");
  });

  it("is strong only on three addresses that mostly agree", () => {
    const learned = learnPatterns([
      obs("evercore", "A", "Bell", "abell@evercore.com"),
      obs("evercore", "Cy", "Dunn", "cdunn@evercore.com"),
      obs("evercore", "Ed", "Frey", "efrey@evercore.com"),
    ]).get("evercore")!;
    // "A Bell" → abell fits flast and firstlast alike, so it counts for neither.
    expect(learned[0]).toMatchObject({ addresses: 3, patterns: [{ pattern: "flast", count: 2 }], unclear: 1 });
    expect(suggestEmails({ firstName: "Ana", lastName: "Silva", firmName: "Evercore", learned, stated: null }).candidates[0]).toMatchObject({ email: "asilva@evercore.com", strength: "fair" });
    const four = learnPatterns([1, 2, 3, 4].map((i) => obs("evercore", `Cy${"abcd"[i - 1]}`, "Dunn", `cdunn${i}@evercore.com`))).get("evercore")!;
    expect(suggestEmails({ firstName: "Ana", lastName: "Silva", firmName: "Evercore", learned: four, stated: null }).candidates[0].strength).toBe("strong");
  });
});

describe("a format somebody recorded", () => {
  const learned: DomainEvidence[] = [{ domain: "gs.com", addresses: 2, patterns: [{ pattern: "flast", count: 2 }], unclear: 0 }];

  it("the owner's wins over what was learned, and decides the domain", () => {
    const res = suggestEmails({
      firstName: "Ana", lastName: "Silva", firmName: "Goldman Sachs", learned,
      stated: { domain: "goldmansachs.com", pattern: "first.last", source: "user", basis: null, note: null },
    });
    expect(res.candidates).toEqual([
      { email: "ana.silva@goldmansachs.com", domain: "goldmansachs.com", pattern: "first.last", strength: "strong", evidence: "the format you set for Goldman Sachs" },
    ]);
  });

  it("Claude's is said to be Claude's, with where it came from, and ranks below real addresses", () => {
    const fromMail = suggestEmails({
      firstName: "Ana", lastName: "Silva", firmName: "Lazard", learned: [],
      stated: { domain: "lazard.com", pattern: "first.last", source: "agent", basis: "seen_in_mail", note: "two replies from Lazard in October" },
    });
    expect(fromMail.candidates).toEqual([
      { email: "ana.silva@lazard.com", domain: "lazard.com", pattern: "first.last", strength: "fair", evidence: "the format Claude recorded from mail it read: two replies from Lazard in October" },
    ]);
    const published = suggestEmails({
      firstName: "Ana", lastName: "Silva", firmName: "Goldman Sachs", learned,
      stated: { domain: "gs.com", pattern: "first.last", source: "agent", basis: "published", note: null },
    });
    expect(published.candidates.map((c) => [c.email, c.strength])).toEqual([["asilva@gs.com", "fair"], ["ana.silva@gs.com", "weak"]]);
    expect(published.candidates[1].evidence).toBe("the format Claude recorded from a public source");
  });

  it("agreeing evidence adds up into one candidate", () => {
    const res = suggestEmails({
      firstName: "Ana", lastName: "Silva", firmName: "Goldman Sachs", learned,
      stated: { domain: "gs.com", pattern: "flast", source: "agent", basis: "seen_in_mail", note: null },
    });
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0].evidence).toBe("2 of the 2 addresses Rolo holds at gs.com are built this way; the format Claude recorded from mail it read");
  });
});

describe("what is not offered", () => {
  const learned: DomainEvidence[] = [{ domain: "gs.com", addresses: 4, patterns: [{ pattern: "first.last", count: 3 }, { pattern: "flast", count: 1 }], unclear: 0 }];

  it("an address that bounced or was turned down for this person — the next one moves up", () => {
    const res = suggestEmails({ firstName: "Ana", lastName: "Silva", firmName: "Goldman Sachs", learned, stated: null, excluded: new Set(["ana.silva@gs.com"]) });
    expect(res.candidates.map((c) => c.email)).toEqual(["asilva@gs.com"]);
    const none = suggestEmails({ firstName: "Ana", lastName: "Silva", firmName: "Goldman Sachs", learned, stated: null, excluded: new Set(["ana.silva@gs.com", "asilva@gs.com"]) });
    expect(none).toEqual({ candidates: [], reason: "Every format Rolo knows for Goldman Sachs has already been tried for this person." });
  });

  it("a format that keeps bouncing for others sinks, says so, and goes once nothing supports it", () => {
    const once = suggestEmails({ firstName: "Ana", lastName: "Silva", firmName: "Goldman Sachs", learned, stated: null, bounces: new Map([[bounceKey("gs.com", "first.last"), 1]]) });
    expect(once.candidates.map((c) => [c.email, c.strength])).toEqual([["ana.silva@gs.com", "fair"], ["asilva@gs.com", "weak"]]);
    expect(once.candidates[0].evidence).toMatch(/but it bounced for 1 other person there$/);
    const twice = suggestEmails({ firstName: "Ana", lastName: "Silva", firmName: "Goldman Sachs", learned, stated: null, bounces: new Map([[bounceKey("gs.com", "first.last"), 2]]) });
    expect(twice.candidates.map((c) => c.email)).toEqual(["asilva@gs.com"]);
  });

  it("anything at all, without a name, a domain or a format — and says which", () => {
    expect(suggestEmails({ firstName: "Ana", lastName: null, firmName: "Lazard", learned, stated: null }).reason).toMatch(/first and a last name/);
    expect(suggestEmails({ firstName: "Ana", lastName: "Silva", firmName: "Lazard", learned: [], stated: null }).reason).toBe(
      "Rolo holds no address at Lazard to learn from, and no format has been recorded for it."
    );
    const noFormat = suggestEmails({ firstName: "Ana", lastName: "Silva", firmName: "Lazard", learned: [{ domain: "lazard.com", addresses: 1, patterns: [], unclear: 1 }], stated: null });
    expect(noFormat.reason).toBe("Rolo knows the domain lazard.com but not how Lazard builds its addresses.");
  });

  it("more than three, and it warns when the name could be spelled several ways", () => {
    const many: DomainEvidence[] = [{ domain: "gs.com", addresses: 10, patterns: EMAIL_PATTERNS.slice(0, 5).map((pattern, i) => ({ pattern, count: 5 - i })), unclear: 0 }];
    const res = suggestEmails({ firstName: "Maria", lastName: "de la Cruz", firmName: "Goldman Sachs", learned: many, stated: null, evidenceFirm: "Goldman Sachs International" });
    expect(res.candidates).toHaveLength(3);
    expect(res.candidates[0].email).toBe("maria.delacruz@gs.com");
    expect(res.candidates[0].evidence).toBe(
      "5 of the 10 addresses Rolo holds at gs.com (from Goldman Sachs International) are built this way — a name of several words, so check how it is spelled"
    );
  });
});
