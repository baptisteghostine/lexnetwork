import { describe, expect, it } from "vitest";

import {
  buildDigestPrompt,
  DIGEST_PICKS_MAX,
  digestAllowedIds,
  parseDigestBrief,
  type DigestBriefInput,
} from "@/lib/ai/digest";

// SPEC §3/§11 digest narrative: the model sees only Today's data plus
// what moved since the last brief, and may only pick people in it.

const input: DigestBriefInput = {
  dateLabel: "Sat, Sep 26",
  since: {
    hoursAgo: 24,
    interactionsLogged: 2,
    notesWritten: 1,
    newContacts: 0,
    newChanges: [{ contactId: 7, name: "Sam Ford", diff: "Barclays → Santander", reason: "fresh move, warm" }],
  },
  reminders: [{ title: "Send deck", contactName: "Ana", overdueDays: 1 }],
  agenda: [{ summary: "Coffee", attendees: ["Ana Silva"] }],
  due: [{ contactId: 3, name: "Ana Silva", title: "VP", company: "Evercore", daysOverdue: 12, starred: true, lastNote: "promised intro" }],
  changes: [{ contactId: 7, name: "Sam Ford", diff: "Barclays → Santander", reason: "fresh move, warm", significance: 0.9 }],
  birthdays: [{ contactId: 9, name: "Tom", daysUntil: 2 }],
  resurface: [{ contactId: 11, name: "Lea", monthsSince: 8 }],
};

describe("buildDigestPrompt", () => {
  it("covers every section with ids the model can pick", () => {
    const p = buildDigestPrompt(input);
    for (const needle of [
      "Since the last brief (24h ago): 2 exchanges logged, 1 notes written, 0 people added, 1 job changes detected.",
      "- #7 Sam Ford: Barclays → Santander — fresh move, warm",
      "- Send deck (Ana) · 1d overdue",
      "- Coffee with Ana Silva",
      "- #3 Ana Silva (VP, Evercore) ★ · 12d overdue · last note: promised intro",
      "- #9 Tom · in 2d",
      "- #11 Lea · last spoke 8mo ago",
    ]) {
      expect(p).toContain(needle);
    }
  });

  it("says when nobody is due", () => {
    expect(buildDigestPrompt({ ...input, due: [] })).toContain("Nobody is due");
  });
});

describe("parseDigestBrief", () => {
  const allowed = digestAllowedIds(input);

  it("keeps only picks in the data, once each, capped", () => {
    const brief = parseDigestBrief(
      JSON.stringify({
        headline: "Sam moved, Ana is overdue",
        narrative: "Since yesterday you logged two exchanges. Sam moved to Santander. Ana has been overdue for twelve days.",
        picks: [
          { contactId: 7, why: "moved", draft: "Hi Sam" },
          { contactId: 7, why: "dupe", draft: "x" },
          { contactId: 42, why: "invented", draft: "x" },
          { contactId: 3, why: "overdue", draft: "Hi Ana" },
          { contactId: 9, why: "birthday", draft: "Happy birthday" },
          { contactId: 11, why: "drifted", draft: "Hey Lea" },
        ],
        quiet: false,
      }),
      allowed
    );
    expect(brief?.picks.map((p) => p.contactId)).toEqual([7, 3, 9]);
    expect(brief?.picks).toHaveLength(DIGEST_PICKS_MAX);
    expect(brief?.quiet).toBe(false);
  });

  it("rejects a brief with no real narrative", () => {
    expect(parseDigestBrief(JSON.stringify({ headline: "x", narrative: "short", picks: [], quiet: true }), allowed)).toBeNull();
  });
});
