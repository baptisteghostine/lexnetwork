import { describe, expect, it } from "vitest";

import {
  buildHistoryListUrl,
  isBulkMail,
  isGmailRateLimit,
  RATE_LIMIT_RETRY_MS,
  RATE_LIMIT_RUN_BUDGET_MS,
  buildMessageListUrl,
  buildMessageMetadataUrl,
  extractAddressNames,
  extractAddresses,
  parseHistoryPage,
  parseMessageMeta,
  resolveDirection,
} from "../../../src/lib/sync/gmail";
import {
  buildGoogleAuthUrl,
  GOOGLE_BASE_SCOPES,
} from "../../../src/lib/sync/google-auth";

// SPEC §9 acceptance criteria: the word "body" never appears in Gmail API
// calls; requested scopes are exactly the listed ones; message fetches are
// format=metadata with an explicit header whitelist.

describe("privacy invariant — request builders", () => {
  it("requests exactly gmail.metadata + calendar.readonly by default", () => {
    expect(GOOGLE_BASE_SCOPES).toEqual([
      "https://www.googleapis.com/auth/gmail.metadata",
      "https://www.googleapis.com/auth/calendar.readonly",
    ]);
    const url = new URL(
      buildGoogleAuthUrl({
        clientId: "id",
        redirectUri: "https://rolo.example/api/google/callback",
        state: "s",
      })
    );
    expect(url.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/gmail.metadata https://www.googleapis.com/auth/calendar.readonly"
    );
  });

  it("message fetches are format=metadata and can never ask for a body", () => {
    const url = buildMessageMetadataUrl("18c2f1a2b3");
    expect(url).toContain("format=metadata");
    expect(url).not.toMatch(/format=(full|raw|minimal)/);
    expect(url.toLowerCase()).not.toContain("body");
    const headers = new URL(url).searchParams.getAll("metadataHeaders");
    // The last two are read as a bulk-mail flag only, never stored.
    expect(headers).toEqual([
      "From",
      "To",
      "Cc",
      "Subject",
      "List-Unsubscribe",
      "Precedence",
    ]);
  });

  it("no gmail URL contains the q search parameter (metadata scope forbids it)", () => {
    for (const url of [
      buildMessageListUrl({}),
      buildMessageListUrl({ pageToken: "t" }),
      buildHistoryListUrl({ startHistoryId: "123" }),
      buildMessageMetadataUrl("id"),
    ]) {
      expect(new URL(url).searchParams.has("q"), url).toBe(false);
      expect(url.toLowerCase()).not.toContain("body");
    }
  });
});

describe("parseMessageMeta", () => {
  const raw = {
    id: "msg1",
    threadId: "thread1",
    internalDate: "1723500000000",
    payload: {
      headers: [
        { name: "From", value: "Ana Silva <ana@example.com>" },
        { name: "To", value: 'me <owner@gmail.com>, "Bob, Jr." <bob@x.io>' },
        { name: "Cc", value: "carol@y.io" },
        { name: "Subject", value: "Coffee next week?" },
      ],
    },
  };

  it("extracts id, thread, timestamp and the four whitelisted headers", () => {
    const meta = parseMessageMeta(raw)!;
    expect(meta.id).toBe("msg1");
    expect(meta.threadId).toBe("thread1");
    expect(meta.internalDate).toBe(1723500000000);
    expect(meta.from).toBe("Ana Silva <ana@example.com>");
    expect(meta.subject).toBe("Coffee next week?");
    // Quoted display name containing a comma stays one recipient.
    expect(meta.to).toEqual(["me <owner@gmail.com>", '"Bob, Jr." <bob@x.io>']);
  });

  it("returns null for malformed messages", () => {
    expect(parseMessageMeta({})).toBeNull();
    expect(parseMessageMeta({ id: "x" })).toBeNull();
  });
});

describe("extractAddresses", () => {
  it("handles angle brackets, bare addresses and quoted names", () => {
    expect(
      extractAddresses('Ana <ana@x.io>, bob@y.io, "Last, First" <c@z.io>')
    ).toEqual(["ana@x.io", "bob@y.io", "c@z.io"]);
  });
  it("lowercases and tolerates trailing punctuation", () => {
    expect(extractAddresses("ANA@X.IO,")).toEqual(["ana@x.io"]);
  });
  it("returns empty for null or address-free text", () => {
    expect(extractAddresses(null)).toEqual([]);
    expect(extractAddresses("undisclosed-recipients:;")).toEqual([]);
  });
});

describe("resolveDirection", () => {
  const base = {
    id: "m",
    threadId: "t",
    internalDate: 0,
    subject: null,
    bulk: false,
  };

  it("outbound when I sent it; counterparts are the recipients minus me", () => {
    const meta = {
      ...base,
      from: "Owner <owner@gmail.com>",
      to: ["ana@x.io", "owner@gmail.com"],
      cc: ["bob@y.io"],
    };
    const r = resolveDirection(meta, ["owner@gmail.com"]);
    expect(r.direction).toBe("outbound");
    expect(r.counterparts.sort()).toEqual(["ana@x.io", "bob@y.io"]);
  });

  it("inbound when someone else sent it; counterpart is the sender", () => {
    const meta = { ...base, from: "Ana <ana@x.io>", to: ["owner@gmail.com"], cc: [] };
    const r = resolveDirection(meta, ["owner@gmail.com"]);
    expect(r.direction).toBe("inbound");
    expect(r.counterparts).toEqual(["ana@x.io"]);
  });

  it("matches aliases case-insensitively", () => {
    const meta = { ...base, from: "OWNER@WORK.COM", to: ["ana@x.io"], cc: [] };
    const r = resolveDirection(meta, ["owner@work.com"]);
    expect(r.direction).toBe("outbound");
  });
});

describe("parseHistoryPage", () => {
  it("collects added message ids and cursors", () => {
    const page = parseHistoryPage({
      history: [
        { messagesAdded: [{ message: { id: "a" } }, { message: { id: "b" } }] },
        { messagesAdded: [{ message: { id: "a" } }] },
      ],
      nextPageToken: "npt",
      historyId: "999",
    });
    expect(page.messageIds.sort()).toEqual(["a", "b"]);
    expect(page.nextPageToken).toBe("npt");
    expect(page.historyId).toBe("999");
  });

  it("handles an empty (no-change) page", () => {
    const page = parseHistoryPage({ historyId: "1000" });
    expect(page.messageIds).toEqual([]);
    expect(page.nextPageToken).toBeNull();
  });
});

describe("extractAddressNames (SPEC §9f)", () => {
  it("pairs each address with its display name, quoted or not", () => {
    expect(
      extractAddressNames('"Silva, Ana" <Ana.Silva@Meridian.vc>, Diego Fernandez <diego@x.y>, bare@x.y')
    ).toEqual([
      { email: "ana.silva@meridian.vc", name: "Silva, Ana" },
      { email: "diego@x.y", name: "Diego Fernandez" },
      { email: "bare@x.y", name: null },
    ]);
    expect(extractAddressNames(null)).toEqual([]);
  });
});

describe("isGmailRateLimit (SPEC §9 quota edge case)", () => {
  it("recognises Google's per-minute quota replies", () => {
    const body =
      '{"error":{"code":403,"message":"Quota exceeded for quota metric \'Total Query Cost\' and limit \'Units per minute per user\'","errors":[{"reason":"rateLimitExceeded"}]}}';
    expect(isGmailRateLimit(403, body)).toBe(true);
    expect(isGmailRateLimit(429, "")).toBe(true);
  });

  it("does not mistake a real 403 or a 401 for a quota pause", () => {
    expect(isGmailRateLimit(403, '{"error":{"message":"Insufficient Permission"}}')).toBe(false);
    expect(isGmailRateLimit(401, "Quota exceeded")).toBe(false);
  });

  it("the daily cap is a failure, not a two-minute pause", () => {
    expect(
      isGmailRateLimit(
        403,
        '{"error":{"message":"Quota exceeded for quota metric \'Queries\' and limit \'Queries per day\'","errors":[{"reason":"dailyLimitExceeded"}]}}'
      )
    ).toBe(false);
  });

  it("keeps the retry schedule inside the scheduler lease", () => {
    const total = RATE_LIMIT_RETRY_MS.reduce((a: number, b: number) => a + b, 0);
    expect(total).toBeLessThanOrEqual(RATE_LIMIT_RUN_BUDGET_MS);
    expect(RATE_LIMIT_RUN_BUDGET_MS).toBeLessThan(5 * 60_000);
  });
});

describe("bulk mail flag (SPEC §9 / §9f)", () => {
  const raw = (headers: Record<string, string>) => ({
    id: "m1",
    threadId: "t1",
    internalDate: "1700000000000",
    payload: { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) },
  });

  it("List-Unsubscribe marks a message as bulk, whatever the sender looks like", () => {
    const meta = parseMessageMeta(
      raw({
        From: "Sarah Lee <sarah@careers-mailer.example>",
        To: "me@london.edu",
        Subject: "This week's opportunities",
        "List-Unsubscribe": "<https://example/unsub>, <mailto:unsub@example>",
      })
    );
    expect(meta?.bulk).toBe(true);
  });

  it("Precedence bulk/list/junk marks bulk; a plain email does not", () => {
    expect(isBulkMail(new Map([["precedence", "bulk"]]))).toBe(true);
    expect(isBulkMail(new Map([["precedence", "List"]]))).toBe(true);
    expect(isBulkMail(new Map([["precedence", "junk"]]))).toBe(true);
    expect(isBulkMail(new Map([["precedence", "normal"]]))).toBe(false);
    const meta = parseMessageMeta(
      raw({ From: "Ana Silva <ana@example.com>", To: "me@london.edu", Subject: "Coffee?" })
    );
    expect(meta?.bulk).toBe(false);
  });
});
