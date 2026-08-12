import { describe, expect, it } from "vitest";

import {
  deriveDisplayName,
  isValidBirthday,
  normalizeEmail,
} from "@/lib/contacts/normalize";

describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  Jane.Doe@Company.COM ")).toBe(
      "jane.doe@company.com"
    );
  });

  it("strips dots and +tags for gmail", () => {
    expect(normalizeEmail("j.smith+news@gmail.com")).toBe("jsmith@gmail.com");
    expect(normalizeEmail("JSmith@gmail.com")).toBe("jsmith@gmail.com");
  });

  it("folds googlemail.com into gmail.com", () => {
    expect(normalizeEmail("j.smith@googlemail.com")).toBe("jsmith@gmail.com");
  });

  it("keeps dots for non-gmail domains", () => {
    expect(normalizeEmail("j.smith@fastmail.com")).toBe("j.smith@fastmail.com");
  });

  it("leaves non-email strings intact apart from case", () => {
    expect(normalizeEmail("not-an-email")).toBe("not-an-email");
  });
});

describe("deriveDisplayName", () => {
  it("joins first and last", () => {
    expect(deriveDisplayName({ firstName: "Ana", lastName: "Silva" })).toBe(
      "Ana Silva"
    );
  });
  it("uses a single name part alone", () => {
    expect(deriveDisplayName({ firstName: "Ana" })).toBe("Ana");
    expect(deriveDisplayName({ lastName: "Silva" })).toBe("Silva");
  });
  it("falls back to primary email", () => {
    expect(deriveDisplayName({ primaryEmail: "x@y.com" })).toBe("x@y.com");
  });
  it("falls back to Unnamed", () => {
    expect(deriveDisplayName({})).toBe("Unnamed");
  });
  it("trims whitespace-only names", () => {
    expect(
      deriveDisplayName({ firstName: "  ", primaryEmail: "x@y.com" })
    ).toBe("x@y.com");
  });
});

describe("isValidBirthday", () => {
  it("accepts empty", () => {
    expect(isValidBirthday(null, null)).toBe(true);
  });
  it("rejects month without day and day without month", () => {
    expect(isValidBirthday(3, null)).toBe(false);
    expect(isValidBirthday(null, 14)).toBe(false);
  });
  it("accepts Feb 29 (leap-day birthdays exist)", () => {
    expect(isValidBirthday(2, 29)).toBe(true);
  });
  it("rejects impossible dates", () => {
    expect(isValidBirthday(2, 30)).toBe(false);
    expect(isValidBirthday(4, 31)).toBe(false);
    expect(isValidBirthday(13, 1)).toBe(false);
    expect(isValidBirthday(0, 10)).toBe(false);
  });
});
