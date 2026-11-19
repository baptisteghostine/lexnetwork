import { describe, expect, it } from "vitest";

import { draftAsText, isEmailAddress, MAILTO_MAX, mailtoLink, outlookWebLink, WEB_COMPOSE_MAX } from "@/lib/outreach/compose";

// SPEC §16: the links that open a draft in the owner's own mail program.

const BODY_250 = Array.from({ length: 250 }, (_, i) => (i % 25 === 24 ? `word${i}.\n\n` : `word${i} `)).join("").trim();
const EMAIL = {
  to: "ana.silva@gs.test",
  subject: "LBS student — 15 minutes on TMT? (Q&A, 50% shorter)",
  body: `Dear Ana,\n\nI'm a student at LBS & saw your move to TMT — congratulations!\nCould we speak for 15 minutes? I'd value 1+1 thoughts on: recruiting; \"fit\"; timing.\n\nBest,\nBaptiste`,
};

/** What a mail program would read back out of the link. */
function readBack(link: string): Record<string, string> {
  const query = link.slice(link.indexOf("?") + 1);
  return Object.fromEntries(query.split("&").map((pair) => pair.split("=").map(decodeURIComponent)));
}

describe("outlookWebLink", () => {
  it("carries recipient, subject and body intact — punctuation, accents and line breaks included", () => {
    const link = outlookWebLink(EMAIL)!;
    expect(link.startsWith("https://outlook.office.com/mail/deeplink/compose?to=")).toBe(true);
    const back = readBack(link);
    expect(back.to).toBe(EMAIL.to);
    expect(back.subject).toBe(EMAIL.subject);
    expect(back.body.replace(/\r\n/g, "\n")).toBe(EMAIL.body);
    // Spaces are %20, never "+": a mail program would print the pluses.
    expect(link).not.toMatch(/\+/);
    expect(link).not.toMatch(/[\s"<>]/);
  });

  it("a 250-word email survives the trip", () => {
    expect(BODY_250.split(/\s+/)).toHaveLength(250);
    const link = outlookWebLink({ ...EMAIL, body: BODY_250 })!;
    expect(link.length).toBeLessThanOrEqual(WEB_COMPOSE_MAX);
    expect(readBack(link).body.replace(/\r\n/g, "\n")).toBe(BODY_250);
  });

  it("adds the owner's BCC when there is one, and only a real address", () => {
    expect(readBack(outlookWebLink({ ...EMAIL, bcc: "capture@gmail.test" })!).bcc).toBe("capture@gmail.test");
    expect(readBack(outlookWebLink({ ...EMAIL, bcc: "not an address" })!).bcc).toBeUndefined();
    expect(readBack(outlookWebLink({ ...EMAIL, bcc: null })!).bcc).toBeUndefined();
  });

  it("is not offered when it could not work: no address, or too long for a link", () => {
    expect(outlookWebLink({ ...EMAIL, to: null })).toBeNull();
    expect(outlookWebLink({ ...EMAIL, to: "Ana Silva" })).toBeNull();
    expect(outlookWebLink({ ...EMAIL, body: "long ".repeat(2000) })).toBeNull();
  });
});

describe("mailtoLink", () => {
  it("opens the desktop mail program with the same email", () => {
    const link = mailtoLink(EMAIL)!;
    expect(link.startsWith("mailto:ana.silva@gs.test?subject=")).toBe(true);
    const back = readBack(link);
    expect(back.subject).toBe(EMAIL.subject);
    expect(back.body.replace(/\r\n/g, "\n")).toBe(EMAIL.body);
    expect(link.length).toBeLessThanOrEqual(MAILTO_MAX);
  });

  it("gives way to Copy past the length Windows will pass on", () => {
    // 250 words encode to more than the desktop limit: the web link and Copy remain.
    expect(mailtoLink({ ...EMAIL, body: BODY_250 })).toBeNull();
    expect(outlookWebLink({ ...EMAIL, body: BODY_250 })).not.toBeNull();
    expect(mailtoLink({ ...EMAIL, to: null })).toBeNull();
  });

  it("cannot be turned into a link to somewhere else by what is in the draft", () => {
    for (const to of ["a@b.test?bcc=evil@x.test", "a@b.test&cc=x", "a@b.test\nBcc: evil@x.test", "<a@b.test>", "a@b.test, evil@x.test", "javascript:alert(1)"]) {
      expect(mailtoLink({ ...EMAIL, to }), to).toBeNull();
      expect(outlookWebLink({ ...EMAIL, to }), to).toBeNull();
    }
    const tricky = mailtoLink({ ...EMAIL, subject: "x&bcc=evil@x.test", body: "y?cc=evil@x.test#frag" })!;
    const back = readBack(tricky);
    expect(Object.keys(back).sort()).toEqual(["body", "subject"]);
    expect(back.subject).toBe("x&bcc=evil@x.test");
  });
});

describe("the rest", () => {
  it("Copy puts the whole email on the clipboard as text", () => {
    expect(draftAsText({ to: "a@b.test", subject: "Hello", body: "Line one\r\nLine two" })).toBe("To: a@b.test\nSubject: Hello\n\nLine one\nLine two");
    expect(draftAsText({ to: null, subject: "Hello", body: "Body" })).toBe("Subject: Hello\n\nBody");
  });

  it("knows an address from something that merely contains one", () => {
    for (const good of ["a@b.test", "ana.silva+lbs@gs-group.co.uk"]) expect(isEmailAddress(good), good).toBe(true);
    for (const bad of ["", "ana", "a@b", "a b@c.test", "a@b.test;c@d.test", null, undefined, `${"x".repeat(320)}@b.test`]) {
      expect(isEmailAddress(bad), String(bad)).toBe(false);
    }
  });
});
