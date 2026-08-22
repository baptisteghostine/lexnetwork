import { describe, expect, it } from "vitest";

import {
  buildVoyagerHeaders,
  parseCookieBlob,
  mergeSetCookies,
  redactSession,
  scrubSecrets,
} from "@/lib/linkedin/session";

const LI_AT = "AQEDATestTokenValueLongEnough1234567890";
const JSESSION = "ajax:1234567890123456789";

describe("parseCookieBlob", () => {
  it("parses a full Cookie header, keeping the extra cookies for replay", () => {
    const blob = `li_at=${LI_AT}; JSESSIONID="${JSESSION}"; lang=v=2&lang=en-us`;
    expect(parseCookieBlob(blob)).toEqual({
      liAt: LI_AT,
      jsessionId: JSESSION,
      cookieHeader: blob,
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

  it("presents as the LinkedIn web client so Voyager answers (owner amendment)", () => {
    // The private Voyager API only responds to its own web app; a bot UA
    // is bounced to a login page. The owner reversed the no-evasion
    // clause (CLAUDE.md §LinkedIn, SPEC §9b) to make the sync work.
    expect(headers["user-agent"]).toMatch(/Chrome\/\d+/);
    expect(headers["x-li-lang"]).toBe("en_US");
    const track = JSON.parse(headers["x-li-track"]) as { mpName: string };
    expect(track.mpName).toBe("voyager-web");
    expect(headers["x-li-page-instance"]).toMatch(/^urn:li:page:/);
  });

  it("is a single stable fingerprint, not randomised per call", () => {
    const again = buildVoyagerHeaders({ liAt: LI_AT, jsessionId: JSESSION });
    expect(again["user-agent"]).toBe(headers["user-agent"]);
    expect(again["x-li-track"]).toBe(headers["x-li-track"]);
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

describe("parseCookieBlob — real paste shapes (SPEC §9b AC)", () => {
  const LI_AT = "AQEDATaBbCcDdEeFfGgHhIiJjKkLlMm";

  it("accepts the two bare values on their own", () => {
    const s = parseCookieBlob(`${LI_AT}\n"ajax:1234567890"`);
    expect(s).toEqual({ liAt: LI_AT, jsessionId: "ajax:1234567890" });
  });

  it("accepts bare values in either order", () => {
    const s = parseCookieBlob(`ajax:1234567890\n${LI_AT}`);
    expect(s).toEqual({ liAt: LI_AT, jsessionId: "ajax:1234567890" });
  });

  it("accepts tab-separated devtools table rows", () => {
    const s = parseCookieBlob(
      `li_at\t${LI_AT}\nJSESSIONID\t"ajax:1234567890"`
    );
    expect(s).toEqual({ liAt: LI_AT, jsessionId: "ajax:1234567890" });
  });

  it("accepts a header pasted with its literal Cookie: prefix", () => {
    const s = parseCookieBlob(
      `Cookie: li_at=${LI_AT}; JSESSIONID="ajax:1234567890"`
    );
    expect(s).toEqual({ liAt: LI_AT, jsessionId: "ajax:1234567890" });
  });

  it("still rejects a paste missing either cookie", () => {
    expect(parseCookieBlob(LI_AT)).toBeNull();
    expect(parseCookieBlob("ajax:1234567890")).toBeNull();
  });
});

describe("full Cookie header paste (bounce diagnosis, 2026-08-20)", () => {
  const FULL =
    'bcookie="v=2&abc123"; bscookie="v=1&xyz"; li_gc=MTsyMTsxNzA; ' +
    `li_at=${LI_AT}; JSESSIONID="${JSESSION}"; lidc="b=OB01:s=O:r=1"`;

  it("keeps every cookie so lidc/bcookie reach LinkedIn", () => {
    const session = parseCookieBlob(FULL);
    expect(session).not.toBeNull();
    expect(session!.liAt).toBe(LI_AT);
    expect(session!.jsessionId).toBe(JSESSION);
    const headers = buildVoyagerHeaders(session!);
    expect(headers.cookie).toContain("lidc=");
    expect(headers.cookie).toContain("bcookie=");
    // JSESSIONID keeps its quoting exactly as the browser sends it.
    expect(headers.cookie).toContain(`JSESSIONID="${JSESSION}"`);
    // csrf-token stays unquoted regardless.
    expect(headers["csrf-token"]).toBe(JSESSION);
  });

  it("a two-cookie paste still builds the minimal header", () => {
    const session = parseCookieBlob(`li_at=${LI_AT}; JSESSIONID="${JSESSION}"`);
    expect(session!.cookieHeader).toBeUndefined();
    expect(buildVoyagerHeaders(session!).cookie).toBe(
      `li_at=${LI_AT}; JSESSIONID="${JSESSION}"`
    );
  });

  it("scrubSecrets still redacts a full header echoed into an error", () => {
    const scrubbed = scrubSecrets(`sent: ${FULL}`);
    expect(scrubbed).not.toContain(LI_AT);
    expect(scrubbed).not.toContain(JSESSION);
  });
});

describe("mergeSetCookies (the lidc redirect fix)", () => {
  it("replaces a rotated cookie in place, keeping the rest", () => {
    const before = `bcookie="v=2&abc"; li_at=${LI_AT}; lidc="b=OB01:s=O:r=1"`;
    const after = mergeSetCookies(before, [
      'lidc="b=VB02:s=V:r=2"; Expires=Sat, 23 Aug 2026 00:00:00 GMT; Path=/; Domain=linkedin.com',
    ]);
    expect(after).toContain('lidc="b=VB02:s=V:r=2"');
    expect(after).not.toContain("OB01");
    expect(after).toContain(`li_at=${LI_AT}`);
    expect(after).toContain('bcookie="v=2&abc"');
  });

  it("appends a cookie the jar didn't have", () => {
    const after = mergeSetCookies(`li_at=${LI_AT}`, ["lang=v=2&lang=en; Path=/"]);
    expect(after).toBe(`li_at=${LI_AT}; lang=v=2&lang=en`);
  });

  it("ignores attribute-only junk, and matches names case-insensitively", () => {
    // One cookie out, one cookie in — never a duplicate pair differing
    // only by case. The server's spelling wins, since that's the name it
    // asked to receive back.
    const after = mergeSetCookies(`LIDC="old"`, ["lidc=new; HttpOnly", "; Path=/"]);
    expect(after).toBe("lidc=new");
  });

  it("never drops the auth cookie while rotating others", () => {
    const after = mergeSetCookies(
      `li_at=${LI_AT}; JSESSIONID="${JSESSION}"`,
      ['lidc="b=X"; Path=/']
    );
    expect(after).toContain(`li_at=${LI_AT}`);
    expect(after).toContain(`JSESSIONID="${JSESSION}"`);
    expect(after).toContain('lidc="b=X"');
  });
});
