import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseCsv } from "@/lib/imports/csv";

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, "../../fixtures", name), "utf8");

describe("parseCsv", () => {
  it("parses a simple table", () => {
    const t = parseCsv("a,b,c\n1,2,3\n4,5,6\n");
    expect(t.headers).toEqual(["a", "b", "c"]);
    expect(t.rows).toEqual([
      ["1", "2", "3"],
      ["4", "5", "6"],
    ]);
  });

  it("strips a UTF-8 BOM", () => {
    const t = parseCsv("﻿name,email\nJane,j@x.com\n");
    expect(t.headers[0]).toBe("name");
  });

  it("handles CRLF line endings", () => {
    const t = parseCsv("a,b\r\n1,2\r\n3,4\r\n");
    expect(t.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("handles quoted commas, escaped quotes, and embedded newlines", () => {
    const t = parseCsv(
      'name,company,note\n"Van Damme, Jr.","Widgets, Inc.","He said ""hi""\nsecond line"\n'
    );
    expect(t.rows[0]).toEqual([
      "Van Damme, Jr.",
      "Widgets, Inc.",
      'He said "hi"\nsecond line',
    ]);
  });

  it("skips blank lines and pads short rows", () => {
    const t = parseCsv("a,b,c\n\n1,2\n\n");
    expect(t.rows).toEqual([["1", "2", ""]]);
  });

  it("disambiguates duplicate headers", () => {
    const t = parseCsv("Email,Email,Email\nx,y,z\n");
    expect(t.headers).toEqual(["Email", "Email (2)", "Email (3)"]);
  });

  it("handles a file with no trailing newline", () => {
    const t = parseCsv("a,b\n1,2");
    expect(t.rows).toEqual([["1", "2"]]);
  });

  it("parses the Google Contacts fixture", () => {
    const t = parseCsv(fixture("google-contacts.csv"));
    expect(t.headers).toContain("E-mail 1 - Value");
    expect(t.rows).toHaveLength(3);
    // Quoted multiline note stayed one row.
    expect(t.rows[2][14]).toBe("Line one\nLine two");
    expect(t.rows[2][10]).toBe("Widgets, Inc.");
    expect(t.rows[2][11]).toBe('Head of "Special" Projects');
  });
});
