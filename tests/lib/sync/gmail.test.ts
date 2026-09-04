import { describe, expect, it } from "vitest";

import {
  buildHistoryListUrl,
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
    expect(headers).toEqual(["From", "To", "Cc", "Subject"]);
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
