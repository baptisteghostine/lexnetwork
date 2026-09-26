import { describe, expect, it } from "vitest";

import { buildDraftPrompt, buildDraftSystem, gmailComposeUrl, parseDraft } from "@/lib/ai/draft";

// SPEC §11 drafts: the prompt carries only what Rolo knows, the parser is
// strict, and the compose link prefills without sending.

const base = {
  displayName: "Sam Ford",
  firstName: "Sam",
  title: "Associate",
  company: "Santander",
  location: "London",
  workHistory: [{ company: "Barclays", title: "Analyst", isCurrent: false }],
  education: [{ school: "LBS", degree: "MFA", field: null }],
  tags: ["LBS"],
  lastContactDays: 40,
  recentInteractions: ["message from them · 40d ago: thanks for the intro"],
  notes: ["wants intro to Priya"],
  change: { field: "company", oldValue: "Barclays", newValue: "Santander", reason: "fresh start, warm" },
  intent: "congratulate and ask for coffee",
};

describe("buildDraftPrompt", () => {
  it("lists every context block that exists", () => {
    const p = buildDraftPrompt(base);
    for (const needle of [
      "Person: Sam Ford (first name: Sam)",
      "Role: Associate at Santander",
      "Work history: Analyst at Barclays",
      "Education: MFA, LBS",
      "Last contact: 40 days ago.",
      "- message from them · 40d ago: thanks for the intro",
      "- wants intro to Priya",
      "Detected change — the reason to write: company Barclays → Santander. Why now: fresh start, warm",
      "The owner's intent for this message: congratulate and ask for coffee",
    ]) {
      expect(p).toContain(needle);
    }
  });

  it("says when there is nothing rather than leaving gaps", () => {
    const p = buildDraftPrompt({
      ...base,
      notes: [],
      recentInteractions: [],
      lastContactDays: null,
      change: null,
      intent: null,
      workHistory: [],
      education: [],
      tags: [],
      location: null,
    });
    expect(p).toContain("never logged contact");
    expect(p).toContain("no notes about them");
    expect(p).not.toContain("Detected change");
  });

  it("embeds the voice context", () => {
    expect(buildDraftSystem("<voice>x</voice>")).toContain("<voice>x</voice>");
  });
});

describe("parseDraft", () => {
  it("accepts the shape and keeps two alternatives", () => {
    const d = parseDraft(
      JSON.stringify({
        message: "Hi Sam — congrats on Santander.",
        email: { subject: "Congrats", body: "Hi Sam,\n\nCongrats…" },
        alternatives: ["a", "b", "c"],
      })
    );
    expect(d?.message).toBe("Hi Sam — congrats on Santander.");
    expect(d?.alternatives).toEqual(["a", "b"]);
  });

  it("rejects an empty message or a missing email", () => {
    expect(parseDraft(JSON.stringify({ message: "", email: { subject: "s", body: "b" }, alternatives: [] }))).toBeNull();
    expect(parseDraft(JSON.stringify({ message: "m", alternatives: [] }))).toBeNull();
  });
});

describe("gmailComposeUrl", () => {
  it("prefills to, subject and body", () => {
    const url = gmailComposeUrl("sam@x.com", "Hi", "line one\nline two");
    expect(url.startsWith("https://mail.google.com/mail/?view=cm")).toBe(true);
    expect(url).toContain("to=sam%40x.com");
    expect(url).toContain("body=line+one%0Aline+two");
  });
});
