import { describe, expect, it } from "vitest";

import { buildDigest, type DigestInput } from "@/lib/digest/build";

// Fixture-clock AC (SPEC §3): the digest contains exactly the items the
// Today page would show at that moment — same names, same counts.
const FIXTURE: DigestInput = {
  dateLabel: "Thu, Aug 13",
  appUrl: "http://localhost:3000",
  reminders: [
    { title: "Send Sarah the deck", contactName: "Sarah O'Neill", overdueDays: 0 },
    { title: "Renew passport", contactName: null, overdueDays: 3 },
  ],
  dueContacts: [
    { displayName: "Ana Silva", title: "Product Lead", company: "Anthropic", daysOverdue: 2, starred: true },
    { displayName: "Diego Fernandez", title: "Angel Investor", company: null, daysOverdue: 9, starred: false },
  ],
  changes: [
    {
      displayName: "Ana Silva",
      field: "company",
      oldValue: "Stripe",
      newValue: "Anthropic",
    },
  ],
  birthdays: [{ displayName: "Lucia Moreno", daysUntil: 1, turns: 35 }],
};

describe("buildDigest", () => {
  it("contains exactly the Today items — every name, no extras", () => {
    const email = buildDigest(FIXTURE);
    expect(email.empty).toBe(false);
    for (const name of [
      "Send Sarah the deck",
      "Renew passport",
      "Ana Silva",
      "Diego Fernandez",
      "Lucia Moreno",
    ]) {
      expect(email.html).toContain(name);
      expect(email.text).toContain(name);
    }
    // Counts in the subject match the fixture exactly.
    expect(email.subject).toBe(
      "Rolo: 2 due · 2 reminders · 1 job change · 1 birthday — Thu, Aug 13"
    );
    // The job-change section carries the move itself.
    expect(email.text).toContain("Ana Silva: Stripe → Anthropic");
  });

  it("flags overdue and age details", () => {
    const email = buildDigest(FIXTURE);
    expect(email.html).toContain("3d overdue");
    expect(email.html).toContain("9d overdue");
    expect(email.html).toContain("turns 35");
    expect(email.text).toContain("turns 35");
  });

  it("escapes HTML in user content", () => {
    const email = buildDigest({
      ...FIXTURE,
      reminders: [{ title: "<script>x</script>", contactName: null, overdueDays: 0 }],
    });
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
  });

  it("reports empty when nothing is due", () => {
    const email = buildDigest({
      ...FIXTURE,
      reminders: [],
      dueContacts: [],
      changes: [],
      birthdays: [],
    });
    expect(email.empty).toBe(true);
    expect(email.subject).toContain("all clear");
  });
});
