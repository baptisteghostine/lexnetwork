import { describe, expect, it } from "vitest";

import {
  buildLinkedInAuthUrl,
  buildSnapshotUrl,
  LINKEDIN_SCOPE,
  mapConnectionRecord,
  parseSnapshotPage,
  snapshotHeaders,
} from "../../../src/lib/sync/linkedin-portability";

describe("LinkedIn portability request builders (SPEC §9a)", () => {
  it("authorizes with exactly the self-serve portability scope", () => {
    const url = new URL(
      buildLinkedInAuthUrl({
        clientId: "cid",
        redirectUri: "https://rolo.example/api/linkedin/callback",
        state: "s",
      })
    );
    expect(url.origin + url.pathname).toBe(
      "https://www.linkedin.com/oauth/v2/authorization"
    );
    expect(url.searchParams.get("scope")).toBe("r_dma_portability_self_serve");
    expect(LINKEDIN_SCOPE).toBe("r_dma_portability_self_serve");
  });

  it("builds snapshot URLs with criteria query, optional domain and start", () => {
    expect(buildSnapshotUrl({})).toBe(
      "https://api.linkedin.com/rest/memberSnapshotData?q=criteria"
    );
    const url = new URL(buildSnapshotUrl({ domain: "CONNECTIONS", start: 10 }));
    expect(url.searchParams.get("domain")).toBe("CONNECTIONS");
    expect(url.searchParams.get("start")).toBe("10");
  });

  it("sends the LinkedIn-Version header", () => {
    const headers = snapshotHeaders("tok");
    expect(headers.Authorization).toBe("Bearer tok");
    expect(headers["LinkedIn-Version"]).toMatch(/^\d{6}$/);
  });
});

describe("parseSnapshotPage", () => {
  it("collects domains, records and computes the next start", () => {
    const page = parseSnapshotPage({
      elements: [
        {
          snapshotDomain: "CONNECTIONS",
          snapshotData: [
            { "First Name": "Ana", "Last Name": "Silva" },
            { "First Name": "Bob", ignored: 42 },
          ],
        },
        { snapshotDomain: "PROFILE", snapshotData: [] },
      ],
      paging: { start: 0, count: 2, total: 5 },
    });
    expect(page.domains).toEqual(["CONNECTIONS", "PROFILE"]);
    expect(page.records).toHaveLength(2);
    expect(page.records[1]).toEqual({ "First Name": "Bob" });
    expect(page.nextStart).toBe(2);
  });

  it("returns null nextStart on the last page or without paging info", () => {
    expect(
      parseSnapshotPage({ paging: { start: 4, count: 2, total: 5 } }).nextStart
    ).toBeNull();
    expect(parseSnapshotPage({}).nextStart).toBeNull();
  });
});

describe("mapConnectionRecord", () => {
  it("maps the export-archive column names to the ZIP import row shape", () => {
    const row = mapConnectionRecord({
      "First Name": "Ana",
      "Last Name": "Silva",
      URL: "https://www.linkedin.com/in/ana-silva",
      "Email Address": "ana@x.io",
      Company: "Acme",
      Position: "CTO",
      "Connected On": "12 Aug 2026",
    })!;
    expect(row.firstName).toBe("Ana");
    expect(row.lastName).toBe("Silva");
    expect(row.profileUrl).toBe("linkedin.com/in/ana-silva");
    expect(row.email).toBe("ana@x.io");
    expect(row.company).toBe("Acme");
    expect(row.position).toBe("CTO");
    expect(row.connectedOn).toBe("12 Aug 2026");
  });

  it("tolerates header variants (snake_case, spacing, casing)", () => {
    const row = mapConnectionRecord({
      first_name: "Bob",
      LastName: "Jones",
      profile_url: "https://linkedin.com/in/bob-jones/",
      email: "bob@y.io",
      title: "Designer",
    })!;
    expect(row.firstName).toBe("Bob");
    expect(row.lastName).toBe("Jones");
    expect(row.profileUrl).toBe("linkedin.com/in/bob-jones");
    expect(row.position).toBe("Designer");
  });

  it("drops records with no usable identity", () => {
    expect(mapConnectionRecord({ Company: "Acme" })).toBeNull();
    expect(mapConnectionRecord({})).toBeNull();
  });

  it("keeps a URL-only record (identity ladder can still match it)", () => {
    const row = mapConnectionRecord({
      URL: "https://www.linkedin.com/in/mystery",
    })!;
    expect(row.profileUrl).toBe("linkedin.com/in/mystery");
    expect(row.firstName).toBe("");
  });
});
