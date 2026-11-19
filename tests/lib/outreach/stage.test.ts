import { describe, expect, it } from "vitest";

import { DAY_MS, deriveStage, STAGE_LABEL, STAGE_ORDER, STAGES, type OutreachEvent, type StageInput } from "@/lib/outreach/stage";

// SPEC §16: where a person stands in a campaign is read off what
// happened. This is the whole rule, one transition at a time.

const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);
const START = NOW - 30 * DAY_MS;
const ago = (days: number) => NOW - days * DAY_MS;
const sent = (days: number): OutreachEvent => ({ at: ago(days), kind: "sent" });
const received = (days: number): OutreachEvent => ({ at: ago(days), kind: "received" });
const met = (days: number): OutreachEvent => ({ at: ago(days), kind: "met" });

function stage(events: OutreachEvent[], over: Partial<StageInput> = {}) {
  return deriveStage({
    now: NOW,
    startedAt: START,
    events,
    hasOpenDraft: false,
    callAt: null,
    notPursuing: false,
    badAddress: false,
    nudgeAfterDays: 7,
    dormantAfterDays: 30,
    ...over,
  });
}

describe("deriveStage", () => {
  it("nothing has happened: not contacted — or drafted, once an email is written", () => {
    expect(stage([])).toMatchObject({ stage: "not_contacted", since: null, daysWaiting: null, nudgeDue: false, sentSinceReply: 0 });
    expect(stage([], { hasOpenDraft: true })).toMatchObject({ stage: "drafted" });
  });

  it("the owner wrote: awaiting reply, counting whole days", () => {
    expect(stage([sent(0)])).toMatchObject({ stage: "awaiting_reply", daysWaiting: 0, nudgeDue: false, sentSinceReply: 1, since: ago(0) });
    expect(stage([sent(6.9)])).toMatchObject({ stage: "awaiting_reply", daysWaiting: 6, nudgeDue: false });
  });

  it("a week of silence makes a follow-up due — unless one is already written", () => {
    expect(stage([sent(7)])).toMatchObject({ stage: "awaiting_reply", daysWaiting: 7, nudgeDue: true });
    expect(stage([sent(12)], { hasOpenDraft: true })).toMatchObject({ stage: "awaiting_reply", nudgeDue: false });
    expect(stage([sent(3)], { nudgeAfterDays: 3 })).toMatchObject({ nudgeDue: true });
  });

  it("the follow-up went out: the wait starts again, and it knows a nudge was sent", () => {
    expect(stage([sent(10), sent(2)])).toMatchObject({ stage: "awaiting_reply", daysWaiting: 2, nudgeDue: false, sentSinceReply: 2 });
    expect(stage([sent(20), sent(9)])).toMatchObject({ nudgeDue: true, sentSinceReply: 2 });
  });

  it("they answered — after the first email or after a nudge: your move", () => {
    expect(stage([sent(5), received(1)])).toMatchObject({ stage: "your_move", since: ago(1), daysWaiting: null, sentSinceReply: 0 });
    expect(stage([sent(12), sent(4), received(1)])).toMatchObject({ stage: "your_move", sentSinceReply: 0, lastReceivedAt: ago(1) });
    // They wrote first: still the owner's move.
    expect(stage([received(2)])).toMatchObject({ stage: "your_move", lastSentAt: null });
  });

  it("the owner answered them: awaiting again, counted from that answer", () => {
    expect(stage([sent(10), received(6), sent(5)])).toMatchObject({ stage: "awaiting_reply", daysWaiting: 5, sentSinceReply: 1 });
    // Both on the same instant: the owner's message is the later word.
    expect(stage([{ at: ago(2), kind: "received" }, { at: ago(2), kind: "sent" }])).toMatchObject({ stage: "awaiting_reply" });
  });

  it("a month without an answer is no reply at all", () => {
    expect(stage([sent(29.9)])).toMatchObject({ stage: "awaiting_reply" });
    expect(stage([sent(30)], { startedAt: ago(60) })).toMatchObject({ stage: "dormant", daysWaiting: 30, nudgeDue: false });
    expect(stage([sent(50), sent(40)], { startedAt: ago(60) })).toMatchObject({ stage: "dormant", sentSinceReply: 2 });
    // …until they do answer.
    expect(stage([sent(50), received(1)], { startedAt: ago(60) })).toMatchObject({ stage: "your_move" });
  });

  it("a call still to come is where things stand, whatever came before", () => {
    const callAt = NOW + 2 * DAY_MS;
    expect(stage([sent(5), received(3), sent(2)], { callAt })).toMatchObject({ stage: "call_booked", since: callAt });
    expect(stage([], { callAt })).toMatchObject({ stage: "call_booked" });
    // A call whose time has passed books nothing: the exchange decides again.
    expect(stage([sent(5), received(3)], { callAt: NOW - 1000 })).toMatchObject({ stage: "your_move" });
  });

  it("they met: met — and a thank-you afterwards does not undo that", () => {
    expect(stage([sent(9), received(8), met(2)])).toMatchObject({ stage: "met", since: ago(2) });
    expect(stage([sent(9), received(8), met(2), sent(1)])).toMatchObject({ stage: "met" });
    // A second call booked after meeting is the newer fact.
    expect(stage([met(5)], { callAt: NOW + DAY_MS })).toMatchObject({ stage: "call_booked" });
  });

  it("a bounce: address bounced — until they write from anywhere", () => {
    expect(stage([sent(1)], { badAddress: true })).toMatchObject({ stage: "bad_address", since: ago(1) });
    expect(stage([], { badAddress: true })).toMatchObject({ stage: "bad_address" });
    expect(stage([sent(4), received(1)], { badAddress: true })).toMatchObject({ stage: "your_move" });
  });

  it("\"not pursuing\" is the owner's word, and outranks everything that happened", () => {
    for (const events of [[], [sent(1)], [sent(5), received(1)], [met(1)]]) {
      expect(stage(events, { notPursuing: true, callAt: NOW + DAY_MS, badAddress: true }).stage).toBe("not_pursuing");
    }
  });

  it("what happened before the campaign began is history, not progress", () => {
    const old = stage([sent(400), received(399), met(380)]);
    expect(old).toMatchObject({ stage: "not_contacted", lastSentAt: null, lastReceivedAt: null, lastContactBefore: ago(380) });
    expect(stage([met(380), sent(3)])).toMatchObject({ stage: "awaiting_reply", lastContactBefore: ago(380) });
  });

  it("the future is not counted, and the order events arrive in does not matter", () => {
    expect(stage([{ at: NOW + DAY_MS, kind: "received" }, sent(2)])).toMatchObject({ stage: "awaiting_reply" });
    const shuffled = stage([received(1), sent(12), sent(4)]);
    expect(shuffled).toEqual(stage([sent(12), sent(4), received(1)]));
  });

  it("every stage has a label and a place in the list", () => {
    expect([...STAGE_ORDER].sort()).toEqual([...STAGES].sort());
    for (const s of STAGES) expect(STAGE_LABEL[s]).toBeTruthy();
  });
});
