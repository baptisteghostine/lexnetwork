import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  linkedInUrlFromIdentifier,
  parseConnectionsResponse,
  splitHeadline,
  voyagerToConnection,
} from "@/lib/linkedin/voyager";

const fixture = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../../fixtures/linkedin-connections-page.json"),
    "utf8"
  )
) as unknown;

describe("parseConnectionsResponse", () => {
  const page = parseConnectionsResponse(fixture);

  it("finds every person in the payload", () => {
    expect(page.connections).toHaveLength(3);
    expect(page.connections.map((c) => c.publicIdentifier).sort()).toEqual([
      "ada-lovelace-1815",
      "alan-turing",
      "grace-hopper",
    ]);
  });

  it("lowercases identifiers so casing can't split one person into two", () => {
    const grace = page.connections.find((c) => c.firstName === "Grace");
    expect(grace?.publicIdentifier).toBe("grace-hopper");
  });

  it("ignores company entities in the same included array", () => {
    expect(
      page.connections.some((c) => c.publicIdentifier === "analytical-engines")
    ).toBe(false);
  });

  it("pairs the connection date with the right profile via URN", () => {
    const ada = page.connections.find((c) => c.firstName === "Ada");
    expect(ada?.connectedAt).toBe(1690000000000);
    const grace = page.connections.find((c) => c.firstName === "Grace");
    expect(grace?.connectedAt).toBe(1700000000000);
  });

  it("keeps a profile whose connection element carried no date", () => {
    const alan = page.connections.find((c) => c.firstName === "Alan");
    expect(alan).toBeDefined();
    expect(alan?.connectedAt).toBeNull();
  });

  it("falls back to `occupation` when `headline` is absent", () => {
    const alan = page.connections.find((c) => c.firstName === "Alan");
    expect(alan?.headline).toBe("Cryptanalyst @ Bletchley Park");
  });

  it("reads the reported total from paging", () => {
    expect(page.total).toBe(4);
  });

  it("returns empty rather than throwing on a drifted shape", () => {
    // The caller treats empty as a loud failure; the parser itself must not crash.
    expect(parseConnectionsResponse({ unexpected: true }).connections).toEqual([]);
    expect(parseConnectionsResponse(null).connections).toEqual([]);
    expect(parseConnectionsResponse([]).connections).toEqual([]);
  });

  it("deduplicates a profile repeated across the payload", () => {
    const doubled = {
      included: [
        { entityUrn: "a", firstName: "Ada", publicIdentifier: "ada" },
        { entityUrn: "b", lastName: "Lovelace", publicIdentifier: "ada" },
      ],
    };
    const parsed = parseConnectionsResponse(doubled);
    expect(parsed.connections).toHaveLength(1);
    // Merged rather than first-wins: the second copy supplied the surname.
    expect(parsed.connections[0].firstName).toBe("Ada");
    expect(parsed.connections[0].lastName).toBe("Lovelace");
  });

  it("skips records with an identifier but no name at all", () => {
    const nameless = { included: [{ publicIdentifier: "ghost" }] };
    expect(parseConnectionsResponse(nameless).connections).toEqual([]);
  });
});

describe("splitHeadline", () => {
  it("splits the common 'Title at Company' shape", () => {
    expect(splitHeadline("Principal Engineer at Analytical Engines")).toEqual({
      title: "Principal Engineer",
      company: "Analytical Engines",
    });
  });

  it("splits on '@' too", () => {
    expect(splitHeadline("Cryptanalyst @ Bletchley Park")).toEqual({
      title: "Cryptanalyst",
      company: "Bletchley Park",
    });
  });

  it("uses the last separator when a headline has several", () => {
    expect(splitHeadline("Looking at options at Acme")).toEqual({
      title: "Looking at options",
      company: "Acme",
    });
  });

  it("leaves an unsplittable headline whole rather than guessing", () => {
    expect(splitHeadline("Rear Admiral")).toEqual({
      title: "Rear Admiral",
      company: null,
    });
    expect(splitHeadline("Acme | Engineer")).toEqual({
      title: "Acme | Engineer",
      company: null,
    });
  });

  it("does not split on 'at' inside a word", () => {
    expect(splitHeadline("Database Architect")).toEqual({
      title: "Database Architect",
      company: null,
    });
  });

  it("keeps the headline whole when a split would leave an empty side", () => {
    expect(splitHeadline("Engineer at ")).toEqual({
      title: "Engineer at",
      company: null,
    });
  });

  it("handles null and blank", () => {
    expect(splitHeadline(null)).toEqual({ title: null, company: null });
    expect(splitHeadline("   ")).toEqual({ title: null, company: null });
  });
});

describe("linkedInUrlFromIdentifier", () => {
  it("builds the canonical profile URL, lowercased and encoded", () => {
    expect(linkedInUrlFromIdentifier("Ada-Lovelace")).toBe(
      "https://www.linkedin.com/in/ada-lovelace"
    );
    expect(linkedInUrlFromIdentifier("josé-garcía")).toBe(
      "https://www.linkedin.com/in/jos%C3%A9-garc%C3%ADa"
    );
  });
});

describe("voyagerToConnection", () => {
  it("produces the shared LinkedInConnection row with the profile URL as identity", () => {
    const row = voyagerToConnection({
      publicIdentifier: "ada-lovelace",
      firstName: "Ada",
      lastName: "Lovelace",
      headline: "Principal Engineer at Analytical Engines",
      connectedAt: 1690000000000,
    });
    expect(row.profileUrlRaw).toBe("https://www.linkedin.com/in/ada-lovelace");
    // Normalized identity key — what the import engine's rung-0 match uses.
    expect(row.profileUrl).toBe("linkedin.com/in/ada-lovelace");
    expect(row.firstName).toBe("Ada");
    expect(row.lastName).toBe("Lovelace");
    expect(row.position).toBe("Principal Engineer");
    expect(row.company).toBe("Analytical Engines");
    expect(row.connectedOn).toBe("2023-07-22");
  });

  it("carries no email — Voyager connections have none", () => {
    // This is why profile-URL matching has to be rung 0 of the identity ladder:
    // without it every weekly sync would re-create the same people.
    const row = voyagerToConnection({
      publicIdentifier: "ada-lovelace",
      firstName: "Ada",
      lastName: null,
      headline: null,
      connectedAt: null,
    });
    expect(row.email).toBeNull();
    expect(row.firstName).toBe("Ada");
    expect(row.lastName).toBe("");
    expect(row.position).toBeNull();
    expect(row.company).toBeNull();
    expect(row.connectedOn).toBeNull();
  });
});
