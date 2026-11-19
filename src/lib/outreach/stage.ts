// Outreach (SPEC §16): where someone stands in a campaign, worked out
// from what happened — never typed in, never dragged. This is the same
// idea as next_touch_at: a fact derived from the timeline. There are no
// stages to move a person between, only messages that were or were not
// sent and answered.

export const DAY_MS = 24 * 60 * 60 * 1000;

export const STAGES = [
  "not_contacted",
  "drafted",
  "awaiting_reply",
  "your_move",
  "call_booked",
  "met",
  "dormant",
  "bad_address",
  "not_pursuing",
] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABEL: Record<Stage, string> = {
  not_contacted: "Not contacted",
  drafted: "Draft ready",
  awaiting_reply: "Awaiting reply",
  your_move: "Replied — your move",
  call_booked: "Call booked",
  met: "Met",
  dormant: "No reply",
  bad_address: "Address bounced",
  not_pursuing: "Not pursuing",
};

/** The order a campaign page lists stages in: what needs the owner first. */
export const STAGE_ORDER: Stage[] = [
  "your_move",
  "drafted",
  "awaiting_reply",
  "call_booked",
  "not_contacted",
  "met",
  "dormant",
  "bad_address",
  "not_pursuing",
];

/** One thing that happened between the owner and a person. */
export type OutreachEvent = {
  at: number;
  /** sent = the owner wrote; received = they did; met = a call or a meeting took place. */
  kind: "sent" | "received" | "met";
};

export type StageInput = {
  now: number;
  /** The campaign's start: what happened before it is history, not progress. */
  startedAt: number;
  events: OutreachEvent[];
  hasOpenDraft: boolean;
  /** A call or meeting still to come, if one is booked. */
  callAt: number | null;
  /** The owner tagged them "not pursuing". */
  notPursuing: boolean;
  /** Their address was tagged as bouncing. */
  badAddress: boolean;
  nudgeAfterDays: number;
  dormantAfterDays: number;
};

export type StageResult = {
  stage: Stage;
  /** When they entered this stage, where that is a moment. */
  since: number | null;
  /** Whole days since the owner's last message, while a reply is awaited. */
  daysWaiting: number | null;
  /** Awaiting a reply for long enough that a follow-up is due. */
  nudgeDue: boolean;
  /** Messages the owner has sent since they last wrote (1 = no nudge yet). */
  sentSinceReply: number;
  lastSentAt: number | null;
  lastReceivedAt: number | null;
  /** The last contact of any kind before the campaign began: how warm this is. */
  lastContactBefore: number | null;
};

export function deriveStage(input: StageInput): StageResult {
  const { now, startedAt } = input;
  const past = input.events.filter((e) => e.at <= now).sort((a, b) => a.at - b.at);
  const before = past.filter((e) => e.at < startedAt);
  const during = past.filter((e) => e.at >= startedAt);
  const last = (kind: OutreachEvent["kind"]) => {
    for (let i = during.length - 1; i >= 0; i--) if (during[i].kind === kind) return during[i].at;
    return null;
  };
  const lastSentAt = last("sent");
  const lastReceivedAt = last("received");
  const lastMetAt = last("met");
  const sentSinceReply = during.filter((e) => e.kind === "sent" && (lastReceivedAt === null || e.at > lastReceivedAt)).length;
  const base = {
    daysWaiting: null as number | null,
    nudgeDue: false,
    sentSinceReply,
    lastSentAt,
    lastReceivedAt,
    lastContactBefore: before.length ? before[before.length - 1].at : null,
  };

  // The owner's own decision outranks everything that merely happened.
  if (input.notPursuing) return { ...base, stage: "not_pursuing", since: null };
  // A call still to come is where things stand, whatever was said before it.
  if (input.callAt !== null && input.callAt > now) return { ...base, stage: "call_booked", since: input.callAt };
  if (lastMetAt !== null) return { ...base, stage: "met", since: lastMetAt };
  // A bounce is only the answer while they have not written from anywhere.
  if (input.badAddress && lastReceivedAt === null) return { ...base, stage: "bad_address", since: lastSentAt };

  if (lastSentAt === null && lastReceivedAt === null) {
    return { ...base, stage: input.hasOpenDraft ? "drafted" : "not_contacted", since: null };
  }
  // They wrote last (or wrote first): the next message is the owner's.
  if (lastReceivedAt !== null && (lastSentAt === null || lastReceivedAt > lastSentAt)) {
    return { ...base, stage: "your_move", since: lastReceivedAt };
  }
  const waitedMs = now - (lastSentAt as number);
  const daysWaiting = Math.floor(waitedMs / DAY_MS);
  if (daysWaiting >= input.dormantAfterDays) {
    return { ...base, stage: "dormant", since: lastSentAt, daysWaiting };
  }
  return {
    ...base,
    stage: "awaiting_reply",
    since: lastSentAt,
    daysWaiting,
    // A follow-up already written is not "due" again.
    nudgeDue: daysWaiting >= input.nudgeAfterDays && !input.hasOpenDraft,
  };
}

/** Tag names the owner (or their agent) uses to say two things no message can. */
export const NOT_PURSUING_TAG = "not pursuing";
export const BAD_ADDRESS_TAG = "bad address";

export const DEFAULT_NUDGE_AFTER_DAYS = 7;
export const DEFAULT_DORMANT_AFTER_DAYS = 30;
