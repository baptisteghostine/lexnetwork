import { describe, expect, it } from "vitest";

import {
  buildVoyagerHeaders,
  parseCookieBlob,
  redactSession,
  scrubSecrets,
} from "@/lib/linkedin/session";

const LI_AT = "AQEDATestTokenValueLongEnough1234567890";
const JSESSION = "ajax:1234567890123456789";

describe("parseCookieBlob", () => {
  it("parses a full Cookie header", () => {
    const blob = `li_at=${LI_AT}; JSESSIONID="${JSESSION}"; lang=v=2&lang=en-us`;
    expect(parseCookieBlob(blob)).toEqual({
      liAt: LI_AT,
      jsessionId: JSESSION,
    });
  });

  it("parses newline-separated pairs pasted out of devtools", () => {
    const blob = `li_at\t=\t${LI_AT}\nJSESSIONID = "${JSESSION}"\n`;
    expect(parseCookieBlob(blob)).toEqual({
      liAt: LI_AT,
      jsessionId: JSESSION,
    });
  });

  it("is case-insensitive on cookie names", () => {
    const blob = `LI_AT=${LI_AT}; jsessionid="${JSESSION}"`;
    expect(parseCookieBlob(blob)?.liAt).toBe(LI_AT);
  });

  it("strips the quotes LinkedIn wraps JSESSIONID in", () => {
    const blob = `li_at=${LI_AT}; JSESSIONID="${JSESSION}"`;
    expect(parseCookieBlob(blob)?.jsessionId).toBe(JSESSION);
    expect(parseCookieBlob(blob)?.jsessionId).not.toContain('"');
  });

  it("returns null when JSESSIONID is missing — a half session is useless", () => {
    expect(parseCookieBlob(`li_at=${LI_AT}`)).toBeNull();
  });

  it("returns null when li_at is missing", () => {
    expect(parseCookieBlob(`JSESSIONID="${JSESSION}"`)).toBeNull();
  });

  it("rejects an li_at too short to be a real token", () => {
    expect(parseCookieBlob(`li_at=abc; JSESSIONID="${JSESSION}"`)).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parseCookieBlob("   ")).toBeNull();
  });
});

describe("buildVoyagerHeaders", () => {
  const headers = buildVoyagerHeaders({ liAt: LI_AT, jsessionId: JSESSION });

  it("sends csrf-token unquoted to match the quoted cookie", () => {
    expect(headers["csrf-token"]).toBe(JSESSION);
    expect(headers.cookie).toContain(`JSESSIONID="${JSESSION}"`);
  });

  it("carries the auth cookie", () => {
    expect(headers.cookie).toContain(`li_at=${LI_AT}`);
  });

  it("identifies itself as Rolo rather than impersonating a browser build", () => {
    expect(headers["user-agent"]).toContain("Rolo");
    expect(headers["user-agent"]).not.toMatch(/Chrome\/|Safari\/|Firefox\//);
  });
});

describe("credential redaction", () => {
  it("redactSession keeps only a non-reusable fingerprint", () => {
    const fingerprint = redactSession({ liAt: LI_AT, jsessionId: JSESSION });
    expect(fingerprint).not.toContain(LI_AT);
    expect(fingerprint).toContain(LI_AT.slice(-4));
  });

  it("scrubSecrets strips a cookie echoed back in an error body", () => {
    const body = `Request failed. Sent: li_at=${LI_AT}; JSESSIONID="${JSESSION}"`;
    const scrubbed = scrubSecrets(body);
    expect(scrubbed).not.toContain(LI_AT);
    expect(scrubbed).not.toContain(JSESSION);
    expect(scrubbed).toContain("[redacted]");
  });

  it("scrubSecrets leaves ordinary error text intact", () => {
    expect(scrubSecrets("LinkedIn returned HTTP 429.")).toBe(
      "LinkedIn returned HTTP 429."
    );
  });
});
