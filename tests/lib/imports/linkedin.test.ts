import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  normalizeLinkedInUrl,
  parseConnections,
  parseLinkedInDate,
  parseMessages,
  parseProfileOwnerName,
  stripConnectionsPreamble,
} from "@/lib/imports/linkedin";
import {
  normalizeForChange,
  planConnection,
  type LinkedInSnapshot,
} from "@/lib/imports/linkedin-plan";

const FIXTURES = path.join(__dirname, "../../fixtures/linkedin");
const read = (f: string) => fs.readFileSync(path.join(FIXTURES, f), "utf8");

describe("Connections.csv parsing (SPEC §8: preamble-tolerant)", () => {
  it("skips LinkedIn's Notes preamble and finds the real header", () => {
    const stripped = stripConnectionsPreamble(read("Connections.csv"));
    expect(stripped.startsWith("First Name,")).toBe(true);
  });

  it("parses connections with normalized profile URLs", () => {
    const rows = parseConnections(read("Connections.csv"));
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      firstName: "Ana",
      lastName: "Silva",
      profileUrl: "linkedin.com/in/ana-silva-example",
      email: "ana.silva@example.com",
      company: "Anthropic",
      position: "Product Lead",
    });
    expect(rows[3].firstName).toBe("Kenji"); // quoted field
  });
});

describe("normalizeLinkedInUrl", () => {
  it("canonicalizes protocol/www/case/trailing-slash/query", () => {
    for (const url of [
      "https://www.linkedin.com/in/Ana-Silva-Example/",
      "http://linkedin.com/in/ana-silva-example?trk=share",
      "WWW.LINKEDIN.COM/in/ana-silva-example#about",
    ]) {
      expect(normalizeLinkedInUrl(url)).toBe("linkedin.com/in/ana-silva-example");
    }
  });
  it("rejects non-linkedin urls and empties", () => {
    expect(normalizeLinkedInUrl("https://twitter.com/x")).toBeNull();
    expect(normalizeLinkedInUrl("  ")).toBeNull();
  });
});

describe("messages.csv parsing", () => {
  const owner = parseProfileOwnerName(read("Profile.csv"));

  it("reads the owner from Profile.csv", () => {
    expect(owner).toBe("Baptiste Ghostine");
  });

  it("derives direction and counterpart per message", () => {
    const msgs = parseMessages(read("messages.csv"), owner);
    expect(msgs).toHaveLength(4);
    expect(msgs[0]).toMatchObject({
      conversationId: "conv-001",
      direction: "inbound",
      counterpartName: "Ana Silva",
      counterpartProfileUrl: "linkedin.com/in/ana-silva-example",
    });
    expect(msgs[1].direction).toBe("outbound");
    expect(msgs[1].counterpartProfileUrl).toBe(
      "linkedin.com/in/ana-silva-example"
    );
    expect(msgs[3].counterpartName).toBe("Zara Ahmed");
  });

  it("parses LinkedIn's UTC timestamp format", () => {
    expect(parseLinkedInDate("2026-07-30 09:15:22 UTC")).toBe(
      Date.UTC(2026, 6, 30, 9, 15, 22)
    );
  });
});

describe("planConnection (SPEC §5 + §8 rules)", () => {
  const snapshot = (
    over: Partial<LinkedInSnapshot["values"]>,
    provenance: LinkedInSnapshot["provenance"] = {}
  ): LinkedInSnapshot => ({
    contactId: 1,
    values: {
      first_name: "Ana",
      last_name: "Silva",
      company: "Stripe",
      title: "Product Manager",
      ...over,
    },
    provenance,
  });
  const row = (company: string, position: string) => ({
    firstName: "Ana",
    lastName: "Silva",
    profileUrl: "linkedin.com/in/ana",
    profileUrlRaw: "https://linkedin.com/in/ana",
    email: null,
    company,
    position,
    connectedOn: null,
  });

  it("first sighting: all new, zero changes (no baseline)", () => {
    const plan = planConnection(row("Anthropic", "Product Lead"), null);
    expect(plan.status).toBe("new");
    expect(plan.changes).toHaveLength(0);
  });

  it("identical re-import is unchanged with zero changes (AC)", () => {
    const plan = planConnection(
      row("Stripe", "Product Manager"),
      snapshot({}, { company: "linkedin", title: "linkedin" })
    );
    expect(plan.status).toBe("unchanged");
    expect(plan.changes).toHaveLength(0);
    expect(plan.writes).toHaveLength(0);
  });

  it("case/suffix-only differences are not changes (SPEC §5)", () => {
    const plan = planConnection(
      row("STRIPE, Inc.", "product manager"),
      snapshot({}, { company: "linkedin", title: "linkedin" })
    );
    expect(plan.status).toBe("unchanged");
    expect(plan.changes).toHaveLength(0);
  });

  it("one changed Position → exactly one change row (AC)", () => {
    const plan = planConnection(
      row("Stripe", "Head of Product"),
      snapshot({}, { company: "linkedin", title: "linkedin" })
    );
    expect(plan.changes).toEqual([
      { field: "title", old: "Product Manager", new: "Head of Product" },
    ]);
    expect(plan.writes).toContainEqual({
      field: "title",
      value: "Head of Product",
    });
  });

  it("company change writes + emits a company change", () => {
    const plan = planConnection(
      row("Anthropic", "Product Manager"),
      snapshot({}, { company: "linkedin", title: "linkedin" })
    );
    expect(plan.changes).toEqual([
      { field: "company", old: "Stripe", new: "Anthropic" },
    ]);
  });

  it("user-edited field → conflict, no write, no change (SPEC §8)", () => {
    const plan = planConnection(
      row("Anthropic", "Product Manager"),
      snapshot({}, { company: "user", title: "linkedin" })
    );
    expect(plan.writes).toHaveLength(0);
    expect(plan.changes).toHaveLength(0);
    expect(plan.conflicts).toEqual([
      { field: "company", stored: "Stripe", incoming: "Anthropic" },
    ]);
  });

  it("filling an empty field is a write but not a change", () => {
    const plan = planConnection(
      row("Anthropic", "Product Manager"),
      snapshot({ company: null }, { title: "linkedin" })
    );
    expect(plan.writes).toContainEqual({ field: "company", value: "Anthropic" });
    expect(plan.changes).toHaveLength(0);
  });
});

describe("normalizeForChange", () => {
  it("strips legal suffixes for companies only", () => {
    expect(normalizeForChange("company", "Google LLC")).toBe("google");
    expect(normalizeForChange("company", "Veltra, Inc.")).toBe("veltra");
    // "Inc" survives in titles (no legal-suffix stripping) — only the
    // punctuation goes.
    expect(normalizeForChange("title", "VP, Inc Programs")).toBe(
      "vp inc programs"
    );
  });
  it("punctuation-only differences are not changes (SPEC §5)", () => {
    expect(normalizeForChange("title", "Sr. Engineer")).toBe(
      normalizeForChange("title", "Sr Engineer")
    );
    expect(normalizeForChange("company", "O'Reilly Media")).toBe(
      normalizeForChange("company", "OReilly Media")
    );
  });
});

describe("normalizeLinkedInUrl — one key per person across sources", () => {
  it("folds country subdomains into linkedin.com", () => {
    expect(normalizeLinkedInUrl("https://uk.linkedin.com/in/ana-silva")).toBe(
      "linkedin.com/in/ana-silva"
    );
    expect(normalizeLinkedInUrl("https://www.linkedin.com/in/ana-silva")).toBe(
      "linkedin.com/in/ana-silva"
    );
  });
  it("percent-encoded and raw UTF-8 identifiers converge", () => {
    expect(
      normalizeLinkedInUrl("https://www.linkedin.com/in/jos%C3%A9-garc%C3%ADa")
    ).toBe(normalizeLinkedInUrl("https://www.linkedin.com/in/josé-garcía"));
  });
});
