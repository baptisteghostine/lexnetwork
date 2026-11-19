import { describe, expect, it } from "vitest";

import {
  capturedSectionsSchema,
  cleanLines,
  parseAbout,
  parseDateRange,
  parseEducation,
  parseExperience,
  parsePartialDate,
  planEducation,
  planWorkHistory,
  PROFILE_SOURCE,
  ROLE_DESCRIPTION_MAX,
  type CapturedRole,
  type StoredRole,
} from "@/lib/linkedin/profile-sections";

// SPEC §9c, career history: the extension sends lines of text; this
// decides what they mean. The shapes below are LinkedIn's profile page as
// it prints an entry — every text twice, once for screen readers.

const twice = (...lines: string[]) => lines.flatMap((l) => [l, l]);

describe("dates", () => {
  it("reads a month and year, or a year, in English and French", () => {
    expect(parsePartialDate("Jan 2022")).toBe("2022-01");
    expect(parsePartialDate("September 2019")).toBe("2019-09");
    expect(parsePartialDate("2019")).toBe("2019");
    expect(parsePartialDate("févr. 2021")).toBe("2021-02");
    expect(parsePartialDate("août 2020")).toBe("2020-08");
    expect(parsePartialDate("déc. 2018")).toBe("2018-12");
    for (const no of ["", "Present", "London", "13 2022", "Jan 22", "2 yrs", "1850", "Smarch 2020"]) expect(parsePartialDate(no), no).toBeNull();
  });

  it("reads a range and ignores LinkedIn's arithmetic after the dot", () => {
    expect(parseDateRange("Jan 2022 - Present · 2 yrs 11 mos")).toEqual({ start: "2022-01", end: null, current: true });
    expect(parseDateRange("Jul 2019 - Dec 2021 · 2 yrs 6 mos")).toEqual({ start: "2019-07", end: "2021-12", current: false });
    expect(parseDateRange("2015 – 2019")).toEqual({ start: "2015", end: "2019", current: false });
    expect(parseDateRange("sept. 2020 - aujourd’hui · 4 ans 3 mois")).toEqual({ start: "2020-09", end: null, current: true });
    expect(parseDateRange("janv. 2018 - juin 2020 · 2 ans 6 mois")).toEqual({ start: "2018-01", end: "2020-06", current: false });
    expect(parseDateRange("Jun 2020 · 1 mo")).toEqual({ start: "2020-06", end: "2020-06", current: false });
  });

  it("is not fooled by a line that only looks like one", () => {
    for (const no of ["Vice President", "Goldman Sachs · Full-time", "London, England, United Kingdom", "Full-time · 5 yrs 3 mos", "2019", "M&A - Technology", "Present", "Jan 2022 - soon", "Grew revenue from 2019 to 2021 by 40%."]) {
      expect(parseDateRange(no), no).toBeNull();
    }
  });
});

describe("experience", () => {
  it("reads one role: title, employer, dates, place, and what they wrote", () => {
    const roles = parseExperience([
      {
        lines: twice(
          "Vice President",
          "Goldman Sachs · Full-time",
          "Jan 2022 - Present · 2 yrs 11 mos",
          "London, England, United Kingdom · Hybrid",
          "Technology, Media & Telecom investment banking. Covering software and internet clients across EMEA.",
          "Skills: Mergers & Acquisitions · Financial Modeling"
        ),
      },
    ]);
    expect(roles).toEqual<CapturedRole[]>([
      {
        company: "Goldman Sachs",
        title: "Vice President",
        startDate: "2022-01",
        endDate: null,
        isCurrent: true,
        description: "Technology, Media & Telecom investment banking. Covering software and internet clients across EMEA.",
      },
    ]);
  });

  it("finds what they wrote about a role in the entries nested under it", () => {
    const roles = parseExperience([
      {
        lines: twice("Vice President", "Goldman Sachs · Full-time", "Jan 2022 - Present · 2 yrs 11 mos", "London, England, United Kingdom"),
        children: [{ lines: twice("Technology, Media & Telecom. Software and internet coverage.") }, { lines: twice("Skills: M&A · Valuation") }],
      },
    ]);
    expect(roles).toHaveLength(1);
    expect(roles[0]).toMatchObject({ company: "Goldman Sachs", title: "Vice President", description: "Technology, Media & Telecom. Software and internet coverage." });
  });

  it("reads an employer with several roles under it", () => {
    const roles = parseExperience([
      {
        lines: twice("Morgan Stanley", "Full-time · 6 yrs 2 mos", "London Area, United Kingdom"),
        children: [
          { lines: twice("Executive Director", "Jan 2023 - Present · 1 yr 11 mos", "TMT coverage; software sub-sector lead.") },
          { lines: twice("Vice President", "Full-time", "Jan 2020 - Dec 2022 · 3 yrs") },
          { lines: twice("Associate", "Oct 2018 - Dec 2019 · 1 yr 3 mos", "London, England, United Kingdom") },
          { lines: twice("Financial Modeling", "Valuation") },
        ],
      },
    ]);
    expect(roles.map((r) => [r.company, r.title, r.startDate, r.endDate, r.isCurrent, r.description])).toEqual([
      ["Morgan Stanley", "Executive Director", "2023-01", null, true, "TMT coverage; software sub-sector lead."],
      ["Morgan Stanley", "Vice President", "2020-01", "2022-12", false, null],
      ["Morgan Stanley", "Associate", "2018-10", "2019-12", false, null],
    ]);
  });

  it("reads a French profile", () => {
    const roles = parseExperience([
      { lines: ["Analyste M&A", "Lazard · CDI", "sept. 2020 - aujourd’hui · 4 ans 3 mois", "Paris, Île-de-France, France · Sur site", "Secteur technologie et logiciels.", "Compétences : Fusions-acquisitions"] },
    ]);
    expect(roles).toEqual([
      { company: "Lazard", title: "Analyste M&A", startDate: "2020-09", endDate: null, isCurrent: true, description: "Secteur technologie et logiciels." },
    ]);
  });

  it("keeps a description that starts where a place would be, and one of several lines", () => {
    const roles = parseExperience([
      { lines: ["Associate", "Evercore", "2019 - 2021 · 2 yrs", "Advised on 12 software transactions. Led diligence.", "Mentored two analysts.", "…see more"] },
    ]);
    expect(roles[0].description).toBe("Advised on 12 software transactions. Led diligence.\nMentored two analysts.");
  });

  it("leaves out what is not a role, and a role read twice", () => {
    const role = { lines: ["Analyst", "Lazard · Internship", "Jun 2017 - Aug 2017 · 3 mos"] };
    const roles = parseExperience([
      role,
      role,
      { lines: ["Show all 12 experiences"] },
      { lines: ["Jan 2020 - Present"] },
      { lines: ["Founder", "Jan 2020 - Present · 4 yrs"] },
      { lines: [] },
      { lines: ["Somewhere", "Something"], children: [{ lines: ["no dates here"] }] },
    ]);
    expect(roles).toEqual([{ company: "Lazard", title: "Analyst", startDate: "2017-06", endDate: "2017-08", isCurrent: false, description: null }]);
  });

  it("bounds a very long description", () => {
    const roles = parseExperience([{ lines: ["Analyst", "Lazard", "2017 - 2018 · 1 yr", "x".repeat(5000)] }]);
    expect(roles[0].description).toHaveLength(ROLE_DESCRIPTION_MAX);
    expect(roles[0].description!.endsWith("…")).toBe(true);
  });
});

describe("found by the review", () => {
  it("a short line about the role is kept — only a real place line is dropped", () => {
    const role = (fourth: string) => parseExperience([{ lines: ["Vice President", "Goldman Sachs · Full-time", "Jan 2022 - Present · 2 yrs", fourth] }])[0].description;
    expect(role("TMT, covering software and internet")).toBe("TMT, covering software and internet");
    expect(role("M&A · Software · Internet")).toBe("M&A · Software · Internet");
    expect(role("Technology coverage")).toBe("Technology coverage");
    for (const place of ["London Area, United Kingdom", "London, England, United Kingdom · Hybrid", "Paris, Île-de-France, France · Sur site", "Remote", "New York, New York, United States"]) {
      expect(role(place), place).toBeNull();
    }
  });

  it("reads German, Spanish, Italian, Dutch and Portuguese dates, so a current role is not lost in silence", () => {
    expect(parseDateRange("Okt. 2020 – Heute · 4 Jahre")).toEqual({ start: "2020-10", end: null, current: true });
    expect(parseDateRange("März 2019 – Dez. 2021")).toEqual({ start: "2019-03", end: "2021-12", current: false });
    expect(parseDateRange("Jan. 2018 bis Sep. 2020")).toEqual({ start: "2018-01", end: "2020-09", current: false });
    expect(parseDateRange("ene. 2020 - actualidad · 4 años")).toEqual({ start: "2020-01", end: null, current: true });
    expect(parseDateRange("gen 2019 - mag 2021")).toEqual({ start: "2019-01", end: "2021-05", current: false });
    expect(parseDateRange("mrt. 2019 - heden")).toEqual({ start: "2019-03", end: null, current: true });
    expect(parseDateRange("fev de 2020 - o momento")).toBeNull(); // "de" between month and year is not handled: reported as unread, not misread
    const roles = parseExperience([
      { lines: ["Direktor", "Deutsche Bank · Vollzeit", "Okt. 2020 – Heute · 4 Jahre"] },
      { lines: ["Analyst", "Deutsche Bank", "Jan. 2018 – Sep. 2020 · 2 Jahre 9 Monate"] },
    ]);
    expect(roles.map((r) => [r.title, r.isCurrent])).toEqual([["Direktor", true], ["Analyst", false]]);
  });

  const norm = (c: string) => c.toLowerCase();
  const vp: CapturedRole = { company: "Goldman Sachs", title: "Vice President", startDate: "2022-01", endDate: null, isCurrent: true, description: "TMT." };
  const row = (over: Partial<StoredRole>): StoredRole => ({ id: 1, companyNormalized: "goldman sachs", title: "Vice President", startDate: null, endDate: null, isCurrent: true, description: null, source: "user", ...over });

  it("a typed row dated to the year is the same role as one dated to the month", () => {
    expect(planWorkHistory([row({ startDate: "2022" })], [vp], norm)).toEqual({ inserts: [], updates: [{ id: 1, description: "TMT." }] });
  });

  it("the headline's row is the same job when it has ended, and when the profile spells the firm in full", () => {
    const ended = row({ id: 5, source: "linkedin", title: "Tech M&A", startDate: "2023-06", endDate: "2025-02", isCurrent: false });
    const past: CapturedRole = { ...vp, endDate: "2025-01", isCurrent: false };
    expect(planWorkHistory([ended], [past], norm)).toEqual({
      inserts: [],
      updates: [{ id: 5, title: "Vice President", startDate: "2022-01", endDate: "2025-01", description: "TMT.", source: PROFILE_SOURCE }],
    });
    const headline = row({ id: 6, source: "linkedin", title: "Tech M&A" });
    const plan = planWorkHistory([headline], [{ ...vp, company: "Goldman Sachs International" }], norm);
    expect(plan.inserts).toEqual([]);
    expect(plan.updates[0]).toMatchObject({ id: 6, source: PROFILE_SOURCE });
    // Not a different firm that merely starts the same.
    expect(planWorkHistory([row({ id: 7, source: "linkedin", companyNormalized: "citi" })], [{ ...vp, company: "Citizens Bank" }], norm).inserts).toHaveLength(1);
  });

  it("a row the owner calls current is never told it ended, and another role's text never lands on it", () => {
    expect(planWorkHistory([row({ startDate: "2022-01" })], [{ ...vp, endDate: "2024-12", isCurrent: false, description: null }], norm)).toEqual({ inserts: [], updates: [] });
    const observer = row({ id: 8, source: "csv", title: "Board Observer", startDate: "2022-01" });
    const plan = planWorkHistory([observer], [vp], norm);
    expect(plan.updates).toEqual([]);
    expect(plan.inserts).toEqual([vp]);
  });
});

describe("education", () => {
  it("reads the school, the degree and field, and the years", () => {
    const schools = parseEducation([
      { lines: twice("London Business School", "Master of Business Administration - MBA, Finance", "2023 - 2025", "Activities and societies: Tech & Media Club") },
      { lines: twice("HEC Paris", "Master in Management", "sept. 2015 - juin 2019") },
      { lines: ["University of Oxford", "2011 - 2014"] },
      { lines: ["Lycée Louis-le-Grand", "Classe préparatoire"] },
      { lines: ["Show all 5 educations"] },
      { lines: ["A heading with nothing under it"] },
      { lines: ["London Business School", "Master of Business Administration - MBA, Finance", "2023 - 2025"] },
    ]);
    expect(schools).toEqual([
      { school: "London Business School", degree: "Master of Business Administration - MBA", field: "Finance", startYear: 2023, endYear: 2025 },
      { school: "HEC Paris", degree: "Master in Management", field: null, startYear: 2015, endYear: 2019 },
      { school: "University of Oxford", degree: null, field: null, startYear: 2011, endYear: 2014 },
      { school: "Lycée Louis-le-Grand", degree: "Classe préparatoire", field: null, startYear: null, endYear: null },
    ]);
  });
});

describe("about and the wire format", () => {
  it("cleans the About text and bounds it", () => {
    expect(parseAbout("I cover software.\nI cover software.\n\n  Based in London.  \n…see more")).toBe("I cover software.\nBased in London.");
    expect(parseAbout("About\nAbout\nI cover software.")).toBe("I cover software.");
    expect(parseAbout("À propos\nJe couvre le logiciel.")).toBe("Je couvre le logiciel.");
    expect(parseAbout("   ")).toBeNull();
    expect(parseAbout(null)).toBeNull();
    expect(parseAbout("y".repeat(9000))!.length).toBe(2000);
  });

  it("collapses repeats and blank lines", () => {
    expect(cleanLines(["A", "A", "", "  B  C ", "A"])).toEqual(["A", "B C", "A"]);
  });

  it("accepts what the extension sends and refuses what it could not have", () => {
    expect(capturedSectionsSchema.safeParse({}).success).toBe(true);
    expect(capturedSectionsSchema.parse({ about: "  " }).about).toBeNull();
    expect(capturedSectionsSchema.safeParse({ experience: [{ lines: ["a"], children: [{ lines: ["b"] }] }] }).success).toBe(true);
    expect(capturedSectionsSchema.safeParse({ experience: [{ lines: "a" }] }).success).toBe(false);
    expect(capturedSectionsSchema.safeParse({ experience: Array.from({ length: 81 }, () => ({ lines: [] })) }).success).toBe(false);
    expect(capturedSectionsSchema.safeParse({ experience: [{ lines: ["x".repeat(4001)] }] }).success).toBe(false);
  });
});

describe("fitting a capture to the history Rolo holds", () => {
  const norm = (c: string) => c.toLowerCase();
  const role = (over: Partial<CapturedRole>): CapturedRole => ({ company: "Goldman Sachs", title: "Vice President", startDate: "2022-01", endDate: null, isCurrent: true, description: "TMT.", ...over });
  const stored = (over: Partial<StoredRole>): StoredRole => ({ id: 1, companyNormalized: "goldman sachs", title: "Tech M&A", startDate: null, endDate: null, isCurrent: true, description: null, source: "linkedin", ...over });

  it("an empty history takes every role", () => {
    const captured = [role({}), role({ company: "Lazard", title: "Analyst", startDate: "2017-06", endDate: "2019-07", isCurrent: false, description: null })];
    expect(planWorkHistory([], captured, norm)).toEqual({ inserts: captured, updates: [] });
  });

  it("the row kept from the headline becomes the real role, not a second one", () => {
    const plan = planWorkHistory([stored({})], [role({})], norm);
    expect(plan.inserts).toEqual([]);
    expect(plan.updates).toEqual([{ id: 1, title: "Vice President", startDate: "2022-01", description: "TMT.", source: PROFILE_SOURCE }]);
  });

  it("capturing the same profile again changes nothing", () => {
    const after = stored({ title: "Vice President", startDate: "2022-01", description: "TMT.", source: PROFILE_SOURCE });
    expect(planWorkHistory([after], [role({})], norm)).toEqual({ inserts: [], updates: [] });
  });

  it("a promotion at the same firm is a new row; the old one gets its end date", () => {
    const vp = stored({ id: 7, title: "Vice President", startDate: "2022-01", description: "TMT.", source: PROFILE_SOURCE });
    const plan = planWorkHistory([vp], [role({ title: "Executive Director", startDate: "2025-01", description: null }), role({ endDate: "2024-12", isCurrent: false })], norm);
    expect(plan.inserts.map((r) => r.title)).toEqual(["Executive Director"]);
    expect(plan.updates).toEqual([{ id: 7, endDate: "2024-12", isCurrent: false }]);
  });

  it("a row the owner typed or imported is only filled in where it is empty", () => {
    const typed = stored({ id: 3, source: "user", title: "VP, TMT", startDate: null, isCurrent: true });
    // Not the headline row and no date to match on, and the title differs: a separate role.
    expect(planWorkHistory([typed], [role({})], norm).inserts).toHaveLength(1);
    const sameTitle = stored({ id: 4, source: "csv", title: "Vice President", startDate: null, isCurrent: false, description: "Mine." });
    expect(planWorkHistory([sameTitle], [role({})], norm)).toEqual({ inserts: [], updates: [{ id: 4, startDate: "2022-01" }] });
  });

  it("nothing is removed for being absent, and a nameless employer is skipped", () => {
    const old = stored({ id: 9, companyNormalized: "lazard", title: "Analyst", startDate: "2017-06", endDate: "2019-07", isCurrent: false, source: PROFILE_SOURCE });
    expect(planWorkHistory([old], [], norm)).toEqual({ inserts: [], updates: [] });
    expect(planWorkHistory([], [role({ company: "…" })], () => "")).toEqual({ inserts: [], updates: [] });
  });

  it("schools: once each, filled in where empty, never rewritten", () => {
    const lbs = { id: 1, school: "London Business School", degree: null, field: null, startYear: null, endYear: 2025 };
    const plan = planEducation(
      [lbs, { id: 2, school: "HEC Paris", degree: "MiM", field: "Management", startYear: 2015, endYear: 2019 }],
      [
        { school: "london business school", degree: "MBA", field: "Finance", startYear: 2023, endYear: 2025 },
        { school: "HEC Paris", degree: "Master in Management", field: null, startYear: 2015, endYear: 2019 },
        { school: "London Business School", degree: "Executive Education", field: null, startYear: 2019, endYear: 2019 },
      ]
    );
    expect(plan.updates).toEqual([{ id: 1, degree: "MBA", field: "Finance", startYear: 2023 }]);
    expect(plan.inserts.map((s) => [s.school, s.degree])).toEqual([["HEC Paris", "Master in Management"], ["London Business School", "Executive Education"]]);
  });
});
