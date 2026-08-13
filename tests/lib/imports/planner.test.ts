import { describe, expect, it } from "vitest";

import {
  effectiveName,
  normalizeForCompare,
  planRow,
  type StoredSnapshot,
} from "@/lib/imports/planner";
import type { ImportRow } from "@/lib/imports/types";

const noE164 = () => null;

function row(partial: Partial<ImportRow>): ImportRow {
  return { emails: [], phones: [], socials: [], ...partial };
}

function stored(partial: Partial<StoredSnapshot>): StoredSnapshot {
  return {
    id: 1,
    values: {
      first_name: "Jane",
      last_name: "Doe",
      title: null,
      company: null,
      location: null,
      bio: null,
      birthday: null,
    },
    provenance: { first_name: "csv", last_name: "csv" },
    emailsNormalized: [],
    phonesE164: [],
    phonesRaw: [],
    socialUrls: [],
    ...partial,
  };
}

describe("normalizeForCompare", () => {
  it("ignores case and whitespace", () => {
    expect(normalizeForCompare("title", "  VP   Engineering ")).toBe(
      normalizeForCompare("title", "vp engineering")
    );
  });
  it("strips legal suffixes for company only", () => {
    expect(normalizeForCompare("company", "Acme, Inc.")).toBe("acme");
    expect(normalizeForCompare("company", "Google")).toBe(
      normalizeForCompare("company", "google")
    );
    expect(normalizeForCompare("title", "Acme, Inc.")).not.toBe("acme");
  });
});

describe("effectiveName", () => {
  it("splits fullName into first + last (last token wins)", () => {
    expect(effectiveName(row({ fullName: "Ana Maria Silva" }))).toEqual({
      firstName: "Ana Maria",
      lastName: "Silva",
    });
    expect(effectiveName(row({ fullName: "Prince" }))).toEqual({
      firstName: "Prince",
      lastName: null,
    });
  });
  it("prefers explicit first/last over fullName", () => {
    expect(
      effectiveName(row({ firstName: "A", lastName: "B", fullName: "C D" }))
    ).toEqual({ firstName: "A", lastName: "B" });
  });
});

describe("planRow", () => {
  it("plans an insert for an unmatched row", () => {
    const plan = planRow(
      row({
        firstName: "Bob",
        lastName: "Smith",
        company: "Globex",
        emails: [{ email: "bob@globex.example" }],
      }),
      null,
      "csv",
      noE164
    );
    expect(plan.status).toBe("new");
    expect(plan.writes.map((w) => w.field)).toEqual([
      "first_name",
      "last_name",
      "company",
    ]);
    expect(plan.newEmails).toHaveLength(1);
  });

  it("fills empty stored fields without conflict", () => {
    const plan = planRow(
      row({ firstName: "Jane", lastName: "Doe", title: "VP Engineering" }),
      stored({}),
      "csv",
      noE164
    );
    expect(plan.status).toBe("updated");
    expect(plan.writes).toEqual([
      { field: "title", incoming: "VP Engineering", previous: null },
    ]);
  });

  it("treats case-only differences as unchanged", () => {
    const plan = planRow(
      row({ firstName: "JANE", lastName: "doe" }),
      stored({}),
      "csv",
      noE164
    );
    expect(plan.status).toBe("unchanged");
  });

  it("same-source value change overwrites", () => {
    const plan = planRow(
      row({ firstName: "Jane", lastName: "Doe", company: "NewCo" }),
      stored({
        values: {
          first_name: "Jane",
          last_name: "Doe",
          title: null,
          company: "OldCo",
          location: null,
          bio: null,
          birthday: null,
        },
        provenance: { company: "csv" },
      }),
      "csv",
      noE164
    );
    expect(plan.status).toBe("updated");
    expect(plan.writes).toEqual([
      { field: "company", incoming: "NewCo", previous: "OldCo" },
    ]);
  });

  it("user-edited field survives re-import as a conflict", () => {
    const plan = planRow(
      row({ firstName: "Jane", lastName: "Doe", title: "CTO" }),
      stored({
        values: {
          first_name: "Jane",
          last_name: "Doe",
          title: "Chief Robot Officer",
          company: null,
          location: null,
          bio: null,
          birthday: null,
        },
        provenance: { title: "user" },
      }),
      "csv",
      noE164
    );
    expect(plan.status).toBe("conflict");
    expect(plan.writes).toEqual([]);
    expect(plan.conflicts).toEqual([
      {
        field: "title",
        incoming: "CTO",
        stored: "Chief Robot Officer",
        storedSource: "user",
      },
    ]);
  });

  it("cross-source difference keeps stored and reports conflict", () => {
    const plan = planRow(
      row({ firstName: "Jane", lastName: "Doe", company: "FromCsv" }),
      stored({
        values: {
          first_name: "Jane",
          last_name: "Doe",
          title: null,
          company: "FromLinkedIn",
          location: null,
          bio: null,
          birthday: null,
        },
        provenance: { company: "linkedin" },
      }),
      "csv",
      noE164
    );
    expect(plan.status).toBe("conflict");
    expect(plan.conflicts[0].storedSource).toBe("linkedin");
  });

  it("unions multi-values by normalized identity, never deletes", () => {
    const plan = planRow(
      row({
        firstName: "Jane",
        lastName: "Doe",
        emails: [
          { email: "J.Doe+x@GMAIL.com" }, // dup of stored jdoe@gmail.com
          { email: "new@work.example" },
        ],
        phones: [{ phone: "+41 79 123 45 67" }],
        socials: [{ platform: "linkedin", url: "https://li/jane" }],
      }),
      stored({
        emailsNormalized: ["jdoe@gmail.com"],
        phonesE164: ["+41791234567"],
        socialUrls: ["https://li/jane"],
      }),
      "csv",
      (raw) => (raw.includes("79 123") ? "+41791234567" : null)
    );
    expect(plan.newEmails.map((e) => e.email)).toEqual(["new@work.example"]);
    expect(plan.newPhones).toEqual([]);
    expect(plan.newSocials).toEqual([]);
    expect(plan.status).toBe("updated");
  });

  it("identical re-import is fully unchanged", () => {
    const plan = planRow(
      row({
        firstName: "Jane",
        lastName: "Doe",
        emails: [{ email: "jdoe@gmail.com" }],
      }),
      stored({ emailsNormalized: ["jdoe@gmail.com"] }),
      "csv",
      noE164
    );
    expect(plan.status).toBe("unchanged");
    expect(plan.writes).toEqual([]);
    expect(plan.newEmails).toEqual([]);
  });

  it("compares birthdays as composite values", () => {
    const plan = planRow(
      row({ firstName: "Jane", lastName: "Doe", birthday: { month: 6, day: 15, year: 1988 } }),
      stored({
        values: {
          first_name: "Jane",
          last_name: "Doe",
          title: null,
          company: null,
          location: null,
          bio: null,
          birthday: "06-15-1988",
        },
        provenance: { birthday: "vcard" },
      }),
      "csv",
      noE164
    );
    expect(plan.status).toBe("unchanged");
  });
});
