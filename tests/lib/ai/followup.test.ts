import { describe, expect, it } from "vitest";

import {
  attendeeMentions,
  buildFollowupPrompt,
  FOLLOWUP_WINDOW_MS,
  parseFollowup,
  selectFollowups,
  type FollowupCandidate,
} from "@/lib/ai/followup";

// SPEC §9e/§11 follow-up: the card appears for meetings that just ended
// with people Rolo knows and disappears once answered, skipped, or noted
// by hand; the parsed capture never invents attendees.

const H = 60 * 60 * 1000;
const NOW = 1_000_000 * H;
const base: FollowupCandidate = {
  id: 1,
  eventKey: "e1",
  summary: "Coffee",
  startsAt: NOW - 3 * H,
  endsAt: NOW - 2 * H,
  status: "confirmed",
  myResponse: "accepted",
  matchedContactIds: [7],
  handled: false,
  notedSince: false,
};

describe("selectFollowups", () => {
  it("keeps a recently ended, attended meeting with a known person", () => {
    expect(selectFollowups([base], NOW)).toHaveLength(1);
  });

  it("drops the ones that should not ask", () => {
    const cases: Partial<FollowupCandidate>[] = [
      { endsAt: NOW + H }, // not over yet
      { startsAt: NOW - 60 * H, endsAt: NOW - FOLLOWUP_WINDOW_MS - H }, // too old
      { myResponse: "declined" },
      { matchedContactIds: [] },
      { handled: true },
      { notedSince: true },
      { status: "cancelled" },
    ];
    for (const c of cases) expect(selectFollowups([{ ...base, ...c }], NOW)).toHaveLength(0);
  });

  it("assumes an hour when the end is unknown and sorts newest first", () => {
    const noEnd = { ...base, id: 2, startsAt: NOW - 30 * 60 * 1000, endsAt: null }; // ends in 30 min
    const older = { ...base, id: 3, startsAt: NOW - 10 * H, endsAt: NOW - 9 * H };
    expect(selectFollowups([older, noEnd, base], NOW).map((e) => e.id)).toEqual([1, 3]);
  });
});

describe("prompt and parse", () => {
  it("names each attendee with their id", () => {
    const p = buildFollowupPrompt({
      meetingSummary: "Coffee",
      meetingDate: "Sep 26",
      contacts: [{ contactId: 7, name: "Sam Ford", title: "Associate", company: "Santander" }],
      answer: "good chat, send deck tmrw",
    });
    expect(p).toContain("With: #7 Sam Ford (Associate, Santander)");
    expect(p).toContain("The owner says: good chat, send deck tmrw");
  });

  it("clamps due days and drops reminder contacts that were not there", () => {
    const out = parseFollowup(
      JSON.stringify({
        noteMd: "- Good chat\n- Send the deck tomorrow",
        reminders: [
          { title: "Send the deck", dueInDays: 0, contactId: 7 },
          { title: "Intro to Priya", dueInDays: 900, contactId: 99 },
        ],
      }),
      new Set([7])
    );
    expect(out?.reminders).toEqual([
      { title: "Send the deck", dueInDays: 1, contactId: 7 },
      { title: "Intro to Priya", dueInDays: 365, contactId: null },
    ]);
    expect(parseFollowup("nope", new Set([7]))).toBeNull();
  });

  it("mentions the other attendees, never the note's own contact", () => {
    expect(attendeeMentions([{ contactId: 7, name: "Sam" }, { contactId: 8, name: "Ana" }], 7)).toBe(
      "\n\nWith [@Ana](mention://contact/8)"
    );
    expect(attendeeMentions([{ contactId: 7, name: "Sam" }], 7)).toBe("");
  });
});
