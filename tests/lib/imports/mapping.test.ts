import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseCsv } from "@/lib/imports/csv";
import {
  applyMapping,
  guessMapping,
  headerSignature,
  isImportableRow,
  parseBirthdayCell,
} from "@/lib/imports/mapping";

const googleCsv = parseCsv(
  fs.readFileSync(
    path.join(__dirname, "../../fixtures/google-contacts.csv"),
    "utf8"
  )
);

describe("guessMapping", () => {
  it("auto-maps a Google Contacts export without manual adjustment", () => {
    const mapping = guessMapping(googleCsv.headers);
    const byHeader = Object.fromEntries(
      googleCsv.headers.map((h, i) => [h, mapping[i]])
    );
    expect(byHeader["First Name"]).toBe("first_name");
    expect(byHeader["Last Name"]).toBe("last_name");
    expect(byHeader["Organization Name"]).toBe("company");
    expect(byHeader["Organization Title"]).toBe("title");
    expect(byHeader["Birthday"]).toBe("birthday");
    expect(byHeader["Notes"]).toBe("bio");
    expect(byHeader["E-mail 1 - Value"]).toBe("email");
    expect(byHeader["E-mail 2 - Value"]).toBe("email");
    expect(byHeader["E-mail 1 - Label"]).toBe("ignore");
    expect(byHeader["Phone 1 - Value"]).toBe("phone");
    expect(byHeader["Website 1 - Value"]).toBe("website");
  });

  it("maps generic headers and keeps scalars first-wins", () => {
    const mapping = guessMapping(["Name", "Email", "Company", "company"]);
    expect(mapping).toEqual(["full_name", "email", "company", "ignore"]);
  });
});

describe("applyMapping", () => {
  const rows = applyMapping(
    googleCsv.headers,
    googleCsv.rows,
    guessMapping(googleCsv.headers)
  );

  it("builds ImportRows from the Google fixture", () => {
    const jane = rows[0];
    expect(jane.firstName).toBe("Jane");
    expect(jane.company).toBe("Acme Corp");
    expect(jane.title).toBe("VP Engineering");
    expect(jane.birthday).toEqual({ year: 1988, month: 6, day: 15 });
    expect(jane.emails.map((e) => e.email)).toEqual([
      "jane.doe@acme.example",
      "jane@personal.example",
    ]);
    expect(jane.phones[0].phone).toBe("+41 79 123 45 67");
    expect(jane.socials[0]).toEqual({
      platform: "website",
      url: "https://www.linkedin.com/in/jane-doe-example",
    });
  });

  it("parses Google's year-less --MM-DD birthday", () => {
    expect(rows[1].birthday).toEqual({ year: null, month: 12, day: 1 });
  });

  it("flags empty rows as non-importable", () => {
    expect(isImportableRow({ emails: [], phones: [], socials: [] })).toBe(
      false
    );
    expect(isImportableRow(rows[0])).toBe(true);
  });
});

describe("headerSignature", () => {
  it("is stable and shape-sensitive", () => {
    expect(headerSignature(googleCsv.headers)).toBe(
      headerSignature([...googleCsv.headers])
    );
    expect(headerSignature(["a", "b"])).not.toBe(headerSignature(["a", "c"]));
  });
});

describe("parseBirthdayCell — date order", () => {
  it("follows day-first order for non-US owners", () => {
    expect(parseBirthdayCell("07/03/1990", true)).toEqual({
      year: 1990,
      month: 3,
      day: 7,
    });
    expect(parseBirthdayCell("07/03/1990", false)).toEqual({
      year: 1990,
      month: 7,
      day: 3,
    });
  });
  it("an unambiguous day (>12) wins regardless of locale", () => {
    expect(parseBirthdayCell("25/03/1990", false)).toEqual({
      year: 1990,
      month: 3,
      day: 25,
    });
    expect(parseBirthdayCell("03/25/1990", true)).toEqual({
      year: 1990,
      month: 3,
      day: 25,
    });
  });
});
