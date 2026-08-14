import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseVcards } from "@/lib/imports/vcard";

const fixture = fs.readFileSync(
  path.join(__dirname, "../../fixtures/contacts.vcf"),
  "utf8"
);

describe("parseVcards", () => {
  it("parses a multi-card file", () => {
    expect(parseVcards(fixture)).toHaveLength(2);
  });

  it("extracts names, org, title, emails, phones", () => {
    const [jane] = parseVcards(fixture);
    expect(jane.firstName).toBe("Jane");
    expect(jane.lastName).toBe("Doe");
    expect(jane.fullName).toBe("Jane Doe");
    expect(jane.company).toBe("Acme Corp"); // department dropped
    expect(jane.title).toBe("VP Engineering");
    expect(jane.emails).toEqual([
      { email: "jane.doe@acme.example", label: "work" },
      { email: "jane@personal.example", label: "home" },
    ]);
    expect(jane.phones[0].phone).toBe("+41 79 123 45 67");
  });

  it("parses full and year-less BDAY formats", () => {
    const [jane, bob] = parseVcards(fixture);
    expect(jane.birthday).toEqual({ year: 1988, month: 6, day: 15 });
    expect(bob.birthday).toEqual({ year: null, month: 12, day: 1 });
  });

  it("unescapes commas in NOTE and unfolds continued lines", () => {
    const [jane, bob] = parseVcards(fixture);
    expect(jane.bio).toContain("Met at ETH reunion,");
    expect(bob.bio).toBe(
      "This note is folded across two physical lines to test line unfolding in the parser."
    );
  });

  it("classifies URLs by platform", () => {
    const [jane, bob] = parseVcards(fixture);
    expect(jane.socials[0].platform).toBe("linkedin");
    expect(bob.socials[0].platform).toBe("github");
  });

  it("extracts city/region/country from ADR", () => {
    const [jane] = parseVcards(fixture);
    expect(jane.location).toBe("Zurich, ZH, Switzerland");
  });

  it("handles CRLF input and returns empty for junk", () => {
    expect(parseVcards(fixture.replaceAll("\n", "\r\n"))).toHaveLength(2);
    expect(parseVcards("not a vcard at all")).toEqual([]);
  });
});

describe("value escaping (RFC 6350)", () => {
  it("escaped semicolons stay inside their component", () => {
    const [row] = parseVcards(
      "BEGIN:VCARD\nVERSION:3.0\nN:Sm\\;ith;John;;;\nFN:John Sm;ith\nEND:VCARD\n"
    );
    expect(row.firstName).toBe("John");
    expect(row.lastName).toBe("Sm;ith");
  });

  it("escaped backslash before n is not a newline", () => {
    const [row] = parseVcards(
      "BEGIN:VCARD\nVERSION:3.0\nFN:X\nNOTE:path C:\\\\network\\\\notes\nEND:VCARD\n"
    );
    expect(row.bio).toBe("path C:\\network\\notes");
  });
});
