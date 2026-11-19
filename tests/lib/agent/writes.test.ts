import { describe, expect, it } from "vitest";

import {
  AUTOMATIC_CATEGORIES,
  cleanLine,
  cleanName,
  describeArgs,
  isPersonalCategory,
  isSameExchange,
  linkedinProfileUrl,
  NEAR_DUPLICATE_WINDOW_MS,
  normalizeSubject,
  PERSONAL_CATEGORIES,
  sanitizeAgentMarkdown,
} from "@/lib/agent/writes";

// SPEC §14, Phase 15: what the write tools decide before they touch the
// database — the signal-not-volume vocabulary, the hygiene of text an
// agent writes, and when two records are the same exchange.

const ctl = (code: number) => String.fromCharCode(code);

describe("message categories", () => {
  it("a person wrote it, or a machine did — never both", () => {
    for (const c of PERSONAL_CATEGORIES) expect(isPersonalCategory(c), c).toBe(true);
    for (const c of AUTOMATIC_CATEGORIES) expect(isPersonalCategory(c), c).toBe(false);
    expect(isPersonalCategory("anything_else")).toBe(false);
    expect(new Set([...PERSONAL_CATEGORIES, ...AUTOMATIC_CATEGORIES]).size).toBe(
      PERSONAL_CATEGORIES.length + AUTOMATIC_CATEGORIES.length
    );
  });
});

describe("sanitizeAgentMarkdown", () => {
  it("turns every image into a link, so showing a note never calls out", () => {
    expect(sanitizeAgentMarkdown("See ![chart](https://evil.test/x.png?d=secret) here")).toBe(
      "See [chart](https://evil.test/x.png?d=secret) here"
    );
    expect(sanitizeAgentMarkdown("![](https://a.test/1)![](https://a.test/2)")).toBe("[](https://a.test/1)[](https://a.test/2)");
    // Reference-style and nested forms lose the bang too.
    expect(sanitizeAgentMarkdown("![a][ref]\n\n[ref]: https://a.test/x")).toBe("[a][ref]\n\n[ref]: https://a.test/x");
    // Doubling the bang must not leave one behind.
    expect(sanitizeAgentMarkdown("!![x](y)")).toBe("[x](y)");
    expect(sanitizeAgentMarkdown("!!!![x](y) and !\n[z](w)")).not.toContain("![");
  });

  it("keeps ordinary markdown, normalises line ends, drops control characters", () => {
    expect(sanitizeAgentMarkdown("  **Met** at LBS\r\n- asked about M&A\r- wants a CV  ")).toBe(
      "**Met** at LBS\n- asked about M&A\n- wants a CV"
    );
    expect(sanitizeAgentMarkdown(`a${ctl(0)}b${ctl(7)}c${ctl(27)}d${ctl(127)}e\tf`)).toBe("abcde\tf");
    expect(sanitizeAgentMarkdown("a\n\n\n\n\n\nb")).toBe("a\n\n\nb");
    expect(sanitizeAgentMarkdown(` ${ctl(1)} `)).toBe("");
    expect(sanitizeAgentMarkdown("Wait! [not an image]")).toBe("Wait! [not an image]");
  });
});

describe("cleanLine", () => {
  it("is one line, trimmed and capped", () => {
    expect(cleanLine("  Re:\tcoffee\nnext   week ", 100)).toBe("Re: coffee next week");
    expect(cleanLine(`a${ctl(0)}b`, 100)).toBe("a b");
    expect(cleanLine("x".repeat(50), 10)).toBe(`${"x".repeat(9)}…`);
    expect(cleanLine("x".repeat(10), 10)).toBe("x".repeat(10));
  });
});

describe("cleanName", () => {
  it("leaves ordinary names alone, however they are written", () => {
    for (const name of ["Ana Silva", "Jean-Luc O'Brien", "María José (MJ) García", "Dr. Li Wei, PhD", "Søren Ångström"]) {
      expect(cleanName(name, 100)).toBe(name);
    }
  });

  it("takes out what would turn a name into a link or an image inside a mention", () => {
    expect(cleanName("Priya ![.](https://evil.test/p.png)", 100)).toBe("Priya !(.)(https://evil.test/p.png)");
    expect(cleanName("x](https://evil.test/phish) [y", 100)).toBe("x)(https://evil.test/phish) (y");
    expect(cleanName("<img src=x> `code`", 100)).toBe("img src=x code");
    for (const hostile of ["a]b", "[a", "![a]", "a<b>"]) expect(cleanName(hostile, 100)).not.toMatch(/[[\]<>`]/);
    expect(cleanName("[]", 100)).toBe("()");
  });
});

describe("linkedinProfileUrl", () => {
  it("accepts a member profile on LinkedIn's host, in one stored form", () => {
    for (const ok of [
      "https://www.linkedin.com/in/priya-nair",
      "http://linkedin.com/in/priya-nair/",
      "https://uk.linkedin.com/in/priya-nair?trk=public_profile#top",
      "  https://WWW.LinkedIn.com/in/priya-nair  ",
    ]) {
      expect(linkedinProfileUrl(ok), ok).toBe("https://www.linkedin.com/in/priya-nair");
    }
    expect(linkedinProfileUrl("https://www.linkedin.com/in/jos%C3%A9-m-123")).toBe("https://www.linkedin.com/in/jos%C3%A9-m-123");
  });

  it("refuses anything that would become a link to somewhere else", () => {
    for (const bad of [
      "",
      "priya-nair",
      "linkedin.com/in/priya-nair",
      "https://evil.test/linkedin.com/in/x",
      "https://linkedin.com.evil.test/in/x",
      "https://notlinkedin.com/in/x",
      "https://www.linkedin.com/company/x",
      "https://www.linkedin.com/in/",
      "https://www.linkedin.com/in/x/details/experience",
      "https://www.linkedin.com:8443/in/x",
      "https://a:b@www.linkedin.com/in/x",
      "javascript:alert(1)//www.linkedin.com/in/x",
      "ftp://www.linkedin.com/in/x",
    ]) {
      expect(linkedinProfileUrl(bad), bad).toBeNull();
    }
  });
});

describe("normalizeSubject", () => {
  it("takes reply and forward prefixes off, in the languages Outlook writes them", () => {
    expect(normalizeSubject("Fw: Re: Introduction – LBS")).toBe("introduction – lbs");
    expect(normalizeSubject("RE: introduction –  LBS")).toBe("introduction – lbs");
    expect(normalizeSubject("FW: RE: FW: Coffee?")).toBe("coffee?");
    expect(normalizeSubject("TR: AW: Antw: Coffee?")).toBe("coffee?");
    expect(normalizeSubject("RE[2]: Coffee?")).toBe("coffee?");
    expect(normalizeSubject("Re : Coffee?")).toBe("coffee?");
  });

  it("leaves a word that merely starts like a prefix", () => {
    expect(normalizeSubject("Review: Q3 deck")).toBe("review: q3 deck");
    expect(normalizeSubject("Reference request")).toBe("reference request");
    expect(normalizeSubject("Forward planning")).toBe("forward planning");
    expect(normalizeSubject(null)).toBe("");
    expect(normalizeSubject("   ")).toBe("");
  });
});

describe("isSameExchange", () => {
  const T = Date.UTC(2026, 10, 18, 14, 0, 0);
  const base = { kind: "email", direction: "outbound", occurredAt: T, title: "Introduction – LBS" };

  it("joins a forwarded copy to the original: same subject under prefixes, minutes apart", () => {
    expect(isSameExchange(base, { ...base, title: "FW: Introduction – LBS", occurredAt: T + 3 * 60_000 })).toBe(true);
    expect(isSameExchange(base, { ...base, occurredAt: T - NEAR_DUPLICATE_WINDOW_MS })).toBe(true);
    // One side has no subject (a Gmail-metadata row with an empty one): time and direction decide.
    expect(isSameExchange(base, { ...base, title: null })).toBe(true);
    expect(isSameExchange(base, { ...base, title: "" })).toBe(true);
  });

  it("keeps apart what is a different exchange", () => {
    expect(isSameExchange(base, { ...base, occurredAt: T + NEAR_DUPLICATE_WINDOW_MS + 1 })).toBe(false);
    expect(isSameExchange(base, { ...base, direction: "inbound" })).toBe(false);
    expect(isSameExchange(base, { ...base, kind: "message" })).toBe(false);
    expect(isSameExchange(base, { ...base, title: "Thank you" })).toBe(false);
    expect(isSameExchange({ ...base, direction: null }, { ...base, direction: "outbound" })).toBe(false);
  });
});

describe("describeArgs", () => {
  it("labels what the owner is being asked to approve, and leaves the plumbing out", () => {
    expect(
      describeArgs(
        JSON.stringify({
          contactId: 4,
          kind: "email",
          direction: "inbound",
          occurredAt: "2026-11-18T14:00:00Z",
          subject: "Re: coffee",
          category: "reply",
          note: "Happy to talk Thursday.",
          idempotencyKey: "gmail:abc",
        })
      )
    ).toEqual([
      { label: "Kind", value: "email" },
      { label: "Direction", value: "inbound" },
      { label: "Category", value: "reply" },
      { label: "When", value: "2026-11-18T14:00:00Z" },
      { label: "Subject", value: "Re: coffee" },
      { label: "Note", value: "Happy to talk Thursday." },
    ]);
  });

  it("calls a person's title a job title, and joins lists", () => {
    expect(describeArgs(JSON.stringify({ firstName: "Priya", title: "Associate", emails: ["a@b.test", "c@d.test"], confirmNew: true }))).toEqual([
      { label: "Job title", value: "Associate" },
      { label: "First name", value: "Priya" },
      { label: "Email", value: "a@b.test, c@d.test" },
      { label: "New person even if the name exists", value: "yes" },
    ]);
    expect(describeArgs(JSON.stringify({ title: "Send the deck", dueAt: "2026-11-25" }))).toEqual([
      { label: "Title", value: "Send the deck" },
      { label: "Due", value: "2026-11-25" },
    ]);
  });

  it("shows a keep-in-touch change, including the instruction to stop", () => {
    expect(describeArgs(JSON.stringify({ contactIds: [1059], everyDays: 91 }))).toEqual([
      { label: "Contacts", value: "1059" },
      { label: "Keep in touch every (days)", value: "91" },
    ]);
    expect(describeArgs(JSON.stringify({ contactIds: [4, 5], everyDays: null }))).toEqual([
      { label: "Contacts", value: "4, 5" },
      { label: "Keep in touch", value: "stop" },
    ]);
  });

  it("survives anything stored in the column", () => {
    expect(describeArgs("not json")).toEqual([]);
    expect(describeArgs("[1,2]")).toEqual([]);
    expect(describeArgs("null")).toEqual([]);
    // Shown whole: the owner approves this text, tail included.
    const long = `${"x".repeat(4000)} [click here](https://evil.test/phish)`;
    expect(describeArgs(JSON.stringify({ text: long }))[0].value).toBe(long);
  });
});
