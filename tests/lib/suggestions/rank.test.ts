import { describe, expect, it } from "vitest";

import {
  describeCounts,
  isLikelyPerson,
  mergeRecent,
  qualifies,
  rankSuggestions,
  splitName,
  SUGGESTION_RECENT_MAX,
  type Sighting,
} from "@/lib/suggestions/rank";

// SPEC §9f: the queue ranks people, and keeps the machinery of email out.

describe("isLikelyPerson", () => {
  it("passes real people at any domain", () => {
    for (const e of ["ana.silva@meridian.vc", "diego@gmail.com", "k.o'neill@example.co.uk", "hello.world@startup.io"]) {
      expect(isLikelyPerson(e), e).toBe(true);
    }
  });
  it("rejects the obvious machines", () => {
    for (const e of [
      "noreply@github.com",
      "notifications@github.com",
      "no-reply@accounts.google.com",
      "calendar-notification@google.com",
      "abc123def456@resource.calendar.google.com",
      "messages-noreply@linkedin.com",
      "notification+kjdmz@facebookmail.com",
      "reply-fe9f1c7b7d67017d-12_HTML-123@mail.example.com",
      "bounce+abc=def@example.com",
      "info@company.com",
      "support@vendor.com",
      "not-an-email",
    ]) {
      expect(isLikelyPerson(e), e).toBe(false);
    }
  });
});

describe("splitName", () => {
  it("handles 'First Last', 'Last, First', quotes, and email-shaped locals", () => {
    expect(splitName("Ana Silva", "a@b.c")).toEqual({ firstName: "Ana", lastName: "Silva" });
    expect(splitName('"Silva, Ana"', "a@b.c")).toEqual({ firstName: "Ana", lastName: "Silva" });
    expect(splitName("Prince", "a@b.c")).toEqual({ firstName: "Prince", lastName: null });
    expect(splitName(null, "ana.silva@meridian.vc")).toEqual({ firstName: "Ana", lastName: "Silva" });
    expect(splitName("ana.silva@meridian.vc", "ana.silva@meridian.vc")).toEqual({ firstName: "Ana", lastName: "Silva" });
    expect(splitName(null, "x7q@meridian.vc")).toEqual({ firstName: null, lastName: null });
  });
});

describe("mergeRecent", () => {
  const s = (key: string, at: number): Sighting => ({ kind: "email", key, occurredAt: at, title: null, direction: "inbound" });
  it("dedupes on key, newest first, bounded", () => {
    const merged = mergeRecent([s("a", 1), s("b", 2)], [s("b", 2), s("c", 3)]);
    expect(merged.map((x) => x.key)).toEqual(["c", "b", "a"]);
    const many = mergeRecent([], Array.from({ length: 80 }, (_, i) => s(`k${i}`, i)));
    expect(many).toHaveLength(SUGGESTION_RECENT_MAX);
    expect(many[0].key).toBe("k79");
  });
});

describe("qualifies + rank", () => {
  const NOW = Date.UTC(2026, 8, 4);
  const row = (id: number, o: number, i: number, m: number, seen = NOW) => ({
    id, outboundCount: o, inboundCount: i, meetingCount: m, lastSeenAt: seen,
  });
  it("needs a meeting, a message from you, or repeated mail from them", () => {
    expect(qualifies(row(1, 0, 1, 0))).toBe(false);
    expect(qualifies(row(1, 0, 3, 0))).toBe(true);
    expect(qualifies(row(1, 1, 0, 0))).toBe(true);
    expect(qualifies(row(1, 0, 0, 1))).toBe(true);
  });
  it("ranks meetings over outbound over inbound, recency as tiebreak", () => {
    const ranked = rankSuggestions(
      [row(1, 0, 5, 0), row(2, 2, 0, 0), row(3, 0, 0, 1), row(4, 0, 1, 0), row(5, 2, 0, 0, NOW - 60 * 86400_000)],
      NOW
    );
    expect(ranked.map((r) => r.id)).toEqual([2, 3, 1, 5]);
  });
});

describe("describeCounts", () => {
  it("reads like a sentence", () => {
    expect(describeCounts({ outboundCount: 2, inboundCount: 1, meetingCount: 2, lastSeenAt: 0 })).toBe("3 emails both ways · met twice");
    expect(describeCounts({ outboundCount: 1, inboundCount: 0, meetingCount: 0, lastSeenAt: 0 })).toBe("you emailed once");
    expect(describeCounts({ outboundCount: 0, inboundCount: 4, meetingCount: 1, lastSeenAt: 0 })).toBe("4 emails from them · met once");
  });
});
