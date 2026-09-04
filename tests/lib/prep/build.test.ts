import { describe, expect, it } from "vitest";

import {
  ago,
  buildMeetingPrepEmail,
  clampLeadMinutes,
  PREP_GRACE_MS,
  selectEventsToPrep,
  type MeetingPrep,
  type PrepCandidate,
} from "@/lib/prep/build";

// SPEC §9e: a brief goes out once per meeting, inside the lead window,
// only for meetings with someone Rolo knows.

const NOW = Date.UTC(2026, 8, 4, 12, 0, 0);
const H = 3600_000;

function candidate(over: Partial<PrepCandidate>): PrepCandidate {
  return {
    eventKey: "e",
    startsAt: NOW + H,
    status: "confirmed",
    myResponse: "accepted",
    preppedAt: null,
    matchedContactIds: [1],
    ...over,
  };
}

describe("selectEventsToPrep", () => {
  const lead = 2 * H;

  it("takes meetings inside the lead window, soonest first", () => {
    const picked = selectEventsToPrep(
      [
        candidate({ eventKey: "later", startsAt: NOW + 1.5 * H }),
        candidate({ eventKey: "soon", startsAt: NOW + 0.5 * H }),
        candidate({ eventKey: "too-far", startsAt: NOW + 3 * H }),
      ],
      NOW,
      lead
    );
    expect(picked.map((e) => e.eventKey)).toEqual(["soon", "later"]);
  });

  it("allows a meeting that just started, not one long over", () => {
    const picked = selectEventsToPrep(
      [
        candidate({ eventKey: "just-started", startsAt: NOW - PREP_GRACE_MS + 1000 }),
        candidate({ eventKey: "over", startsAt: NOW - 2 * H }),
      ],
      NOW,
      lead
    );
    expect(picked.map((e) => e.eventKey)).toEqual(["just-started"]);
  });

  it("skips prepped, declined, cancelled, and stranger-only meetings", () => {
    const picked = selectEventsToPrep(
      [
        candidate({ eventKey: "done", preppedAt: NOW - H }),
        candidate({ eventKey: "declined", myResponse: "declined" }),
        candidate({ eventKey: "cancelled", status: "cancelled" }),
        candidate({ eventKey: "strangers", matchedContactIds: [] }),
        candidate({ eventKey: "ok" }),
      ],
      NOW,
      lead
    );
    expect(picked.map((e) => e.eventKey)).toEqual(["ok"]);
  });
});

describe("clampLeadMinutes", () => {
  it("defaults, floors, and caps", () => {
    expect(clampLeadMinutes(undefined)).toBe(120);
    expect(clampLeadMinutes(5)).toBe(15);
    expect(clampLeadMinutes(99999)).toBe(1440);
    expect(clampLeadMinutes(45.9)).toBe(45);
  });
});

describe("ago", () => {
  it("rounds down through days, months, years", () => {
    const D = 86400_000;
    expect(ago(NOW - 1000, NOW)).toBe("today");
    expect(ago(NOW - D, NOW)).toBe("yesterday");
    expect(ago(NOW - 12 * D, NOW)).toBe("12d ago");
    expect(ago(NOW - 100 * D, NOW)).toBe("3mo ago");
    expect(ago(NOW - 800 * D, NOW)).toBe("2y ago");
  });
});

const PREP: MeetingPrep = {
  eventKey: "evt-1",
  summary: "Q3 catch-up",
  startsAt: NOW + H,
  endsAt: NOW + 1.5 * H,
  htmlLink: "https://calendar.google.com/x",
  generatedAt: NOW,
  contacts: [
    {
      contactId: 7,
      displayName: "Ana Silva",
      title: "Partner",
      company: "Meridian Ventures",
      lastInteractionAt: NOW - 14 * 86400_000,
      interactions: [
        { kind: "email", direction: "outbound", title: "Intro to Diego", occurredAt: NOW - 14 * 86400_000 },
        { kind: "meeting", direction: null, title: "Coffee", occurredAt: NOW - 60 * 86400_000 },
      ],
      reminders: [{ title: "Send the deck", dueAt: NOW }],
      changes: [{ field: "company", oldValue: "Stripe", newValue: "Meridian Ventures", detectedAt: NOW - 3 * 86400_000 }],
      notes: ["Wants intros to biotech founders <bold>"],
      talkingPoints: ["Ask how the Meridian move is going"],
    },
  ],
};

describe("buildMeetingPrepEmail", () => {
  const email = buildMeetingPrepEmail(PREP, { appUrl: "http://localhost:3000", timezone: "UTC", now: NOW });

  it("names the person and the time in the subject", () => {
    expect(email.subject).toBe("Before 13:00 with Ana Silva — Q3 catch-up");
  });

  it("carries every section: touch, reminder, change, notes, points", () => {
    for (const s of [
      "last spoke 14d ago",
      "You emailed — Intro to Diego",
      "Met — Coffee",
      "Send the deck",
      "Stripe",
      "Meridian Ventures",
      "Wants intros to biotech founders",
      "Ask how the Meridian move is going",
      "AI-drafted",
      "/contacts/7",
    ]) {
      expect(email.html).toContain(s);
      if (!s.startsWith("/") && s !== "AI-drafted") expect(email.text).toContain(s);
    }
  });

  it("escapes owner-written markup", () => {
    expect(email.html).not.toContain("<bold>");
    expect(email.html).toContain("&lt;bold&gt;");
  });

  it("phrases groups naturally", () => {
    const two = buildMeetingPrepEmail(
      { ...PREP, contacts: [PREP.contacts[0], { ...PREP.contacts[0], contactId: 8, displayName: "Diego Fernandez" }] },
      { appUrl: "x", timezone: "UTC", now: NOW }
    );
    expect(two.subject).toContain("with Ana Silva and Diego Fernandez");
    const four = buildMeetingPrepEmail(
      { ...PREP, contacts: [1, 2, 3, 4].map((i) => ({ ...PREP.contacts[0], contactId: i, displayName: `P${i}` })) },
      { appUrl: "x", timezone: "UTC", now: NOW }
    );
    expect(four.subject).toContain("with P1 and 3 others");
  });
});
