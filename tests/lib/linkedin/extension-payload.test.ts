import { describe, expect, it } from "vitest";

import {
  parseConnectionsResponse,
  voyagerToConnection,
} from "@/lib/linkedin/voyager";

// SPEC §9c: the extension is deliberately dumb — it forwards raw Voyager
// pages and Rolo parses them with the same tested parser the cookie sync
// uses. These pin the contract the endpoint depends on.

const page = {
  elements: [{ "*connectedMember": "urn:li:fsd_profile:AAA" }],
  included: [
    {
      entityUrn: "urn:li:fsd_profile:AAA",
      publicIdentifier: "ana-silva-example",
      firstName: "Ana",
      lastName: "Silva",
      headline: "Partner at Meridian Ventures",
    },
    // A company entity in the same payload must not become a contact.
    { entityUrn: "urn:li:fsd_company:99", name: "Meridian Ventures" },
  ],
  paging: { total: 1 },
};

describe("raw page → connections", () => {
  it("parses a page the extension forwards verbatim", () => {
    const parsed = parseConnectionsResponse(page);
    expect(parsed.connections).toHaveLength(1);
    expect(parsed.connections[0]).toMatchObject({
      publicIdentifier: "ana-silva-example",
      firstName: "Ana",
      lastName: "Silva",
    });
  });

  it("survives JSON round-tripping over the wire", () => {
    const overTheWire = JSON.parse(JSON.stringify(page)) as unknown;
    expect(parseConnectionsResponse(overTheWire).connections).toHaveLength(1);
  });

  it("maps to the shared import row with the profile URL as identity", () => {
    const row = voyagerToConnection(parseConnectionsResponse(page).connections[0]);
    expect(row.profileUrl).toContain("ana-silva-example");
    expect(row.firstName).toBe("Ana");
    // Voyager carries no email/phone — profile URL is the identity rung.
    expect(row.email).toBeNull();
  });

  it("a shape change yields zero connections, which the endpoint treats as failure", () => {
    // Renamed fields — the endpoint must not read this as 'no connections'.
    const drifted = {
      elements: [{ x: 1 }],
      included: [{ entityUrn: "urn:li:fsd_profile:B", handle: "someone" }],
    };
    expect(parseConnectionsResponse(drifted).connections).toHaveLength(0);
  });
});
