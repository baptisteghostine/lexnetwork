import { describe, expect, it } from "vitest";

import { connectNotice, describeConnectError } from "@/lib/sync/connect-errors";

describe("describeConnectError", () => {
  it("explains the callback's own codes", () => {
    expect(describeConnectError("bad-state")).toMatch(/15 minutes|different Rolo address/);
    expect(describeConnectError("access_denied")).toMatch(/Test users/);
    expect(describeConnectError("google-creds")).toMatch(/client ID and secret/);
    expect(describeConnectError("profile-403")).toMatch(/HTTP 403.*Gmail API/);
  });

  it("recognises the provider's token-endpoint replies", () => {
    expect(
      describeConnectError("Google token endpoint: redirect_uri_mismatch Bad Request")
    ).toMatch(/redirect URI/);
    expect(describeConnectError("Google token endpoint: invalid_client Unauthorized")).toMatch(
      /client ID or secret/
    );
  });

  it("passes an unknown code through rather than guessing", () => {
    expect(describeConnectError("something-new")).toBe("Connecting failed: something-new");
  });
});

describe("connectNotice", () => {
  it("prefers an error over a success flag and names the provider on success", () => {
    expect(connectNotice({})).toBeNull();
    expect(connectNotice({ connected: "google" })).toEqual({
      kind: "ok",
      text: expect.stringContaining("Google connected"),
    });
    expect(connectNotice({ connected: "google", connect_error: "bad-state" })?.kind).toBe(
      "error"
    );
    expect(connectNotice({ connect_error: ["access_denied"] })?.text).toMatch(/Test users/);
  });
});
