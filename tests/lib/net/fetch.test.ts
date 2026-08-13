import { describe, expect, it } from "vitest";

import {
  isAllowedOutboundUrl,
  outboundFetch,
  OutboundBlockedError,
} from "../../../src/lib/net/fetch";

describe("outbound host allowlist (CLAUDE.md privacy invariant)", () => {
  it("allows the configured integration hosts over https", () => {
    for (const url of [
      "https://accounts.google.com/o/oauth2/v2/auth",
      "https://oauth2.googleapis.com/token",
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
      "https://www.linkedin.com/oauth/v2/accessToken",
      "https://api.linkedin.com/rest/memberSnapshotData?q=criteria",
      "https://api.anthropic.com/v1/messages",
    ]) {
      expect(isAllowedOutboundUrl(url), url).toBe(true);
    }
  });

  it("blocks everything else", () => {
    for (const url of [
      "https://example.com/",
      "https://evil.googleapis.com.attacker.io/x",
      "https://getdex.com/api",
      "https://linkedin.com.evil.io/oauth",
      "not a url",
    ]) {
      expect(isAllowedOutboundUrl(url), url).toBe(false);
    }
  });

  it("blocks plain http even for allowed hosts", () => {
    expect(isAllowedOutboundUrl("http://api.linkedin.com/rest/x")).toBe(false);
  });

  it("outboundFetch throws before any network I/O on a blocked host", async () => {
    await expect(outboundFetch("https://example.com/")).rejects.toBeInstanceOf(
      OutboundBlockedError
    );
  });
});
