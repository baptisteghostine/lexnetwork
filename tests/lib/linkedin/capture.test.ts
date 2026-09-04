import { describe, expect, it } from "vitest";

import { MESSAGE_SNIPPET_MAX } from "@/lib/imports/linkedin";
import {
  capturedConversationToMessages,
  capturedName,
  capturedProfileToConnection,
  parseCapturedConversation,
  parseCapturedProfile,
  publicIdentifierFromPath,
} from "@/lib/linkedin/capture";

// SPEC §9c: what the extension reads off a page becomes the same import
// rows the ZIP produces — one identity ladder, one snippet bound.

describe("publicIdentifierFromPath", () => {
  it("reads the identifier from a path, a full URL, or a locale subdomain", () => {
    expect(publicIdentifierFromPath("/in/Ana-Silva-123/")).toBe("ana-silva-123");
    expect(publicIdentifierFromPath("https://www.linkedin.com/in/ana-silva-123/details/experience/")).toBe("ana-silva-123");
    expect(publicIdentifierFromPath("https://uk.linkedin.com/in/ana-silva-123?trk=x")).toBe("ana-silva-123");
    expect(publicIdentifierFromPath("/feed/")).toBeNull();
    expect(publicIdentifierFromPath("/company/acme/")).toBeNull();
  });
});

describe("captured profile", () => {
  it("validates and lowercases the identifier, blanks become null", () => {
    const p = parseCapturedProfile({ publicIdentifier: " Ana-Silva ", headline: "", location: "  " });
    expect(p).toEqual({ publicIdentifier: "ana-silva", firstName: null, lastName: null, fullName: null, headline: null, location: null });
    expect(parseCapturedProfile({ publicIdentifier: "" })).toBeNull();
    expect(parseCapturedProfile(null)).toBeNull();
  });

  it("falls back from structured name to the page heading", () => {
    expect(capturedName(parseCapturedProfile({ publicIdentifier: "x", firstName: "Ana", lastName: "Silva" })!)).toEqual({ firstName: "Ana", lastName: "Silva" });
    expect(capturedName(parseCapturedProfile({ publicIdentifier: "x", fullName: "Ana  Maria Silva" })!)).toEqual({ firstName: "Ana", lastName: "Maria Silva" });
    expect(capturedName(parseCapturedProfile({ publicIdentifier: "x", fullName: "Prince" })!)).toEqual({ firstName: "Prince", lastName: "" });
    expect(capturedName(parseCapturedProfile({ publicIdentifier: "x" })!)).toBeNull();
  });

  it("maps to the shared connection row with the profile URL as identity", () => {
    const row = capturedProfileToConnection(
      parseCapturedProfile({ publicIdentifier: "Ana-Silva-123", fullName: "Ana Silva", headline: "Partner at Meridian Ventures", location: "Zurich, Switzerland" })!
    )!;
    expect(row.profileUrl).toBe("linkedin.com/in/ana-silva-123");
    expect(row.firstName).toBe("Ana");
    expect(row.company).toBe("Meridian Ventures");
    expect(row.position).toBe("Partner");
    expect(row.location).toBe("Zurich, Switzerland");
    expect(row.email).toBeNull();
    expect(capturedProfileToConnection(parseCapturedProfile({ publicIdentifier: "x" })!)).toBeNull();
  });
});

describe("captured conversation", () => {
  const raw = {
    conversationId: "2-abc==",
    counterpartName: "Ana Silva",
    counterpartPublicIdentifier: "ana-silva-123",
    messages: [
      { direction: "outbound", occurredAt: 2000, text: "Hi Ana, it's Baptiste from LBS — " + "long ".repeat(80) },
      { direction: "inbound", occurredAt: 1000, text: "Hello!" },
      { direction: "inbound", occurredAt: 1000, text: "dupe in the same ms" },
      { direction: "inbound", occurredAt: 3000, text: null },
    ],
  };

  it("validates, keys on conversation + timestamp, and bounds the snippet", () => {
    const msgs = capturedConversationToMessages(parseCapturedConversation(raw)!);
    expect(msgs.map((m) => m.occurredAt)).toEqual([1000, 2000, 3000]);
    expect(msgs[0].counterpartProfileUrl).toBe("linkedin.com/in/ana-silva-123");
    expect(msgs[1].snippet!.length).toBeLessThanOrEqual(MESSAGE_SNIPPET_MAX + 1);
    expect(msgs[1].snippet).toMatch(/…$/);
    expect(msgs[2].snippet).toBeNull();
    expect(msgs.every((m) => m.conversationId === "2-abc==")).toBe(true);
  });

  it("rejects an empty thread or an unknown direction", () => {
    expect(parseCapturedConversation({ ...raw, messages: [] })).toBeNull();
    expect(parseCapturedConversation({ ...raw, messages: [{ direction: "sideways", occurredAt: 1 }] })).toBeNull();
  });
});
