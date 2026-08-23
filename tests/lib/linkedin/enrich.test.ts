import { describe, expect, it } from "vitest";

import {
  clampDailyCap,
  DEFAULT_DAILY_CAP,
  driftWarning,
  extractLocation,
  MAX_DAILY_CAP,
  nextBatch,
  publicIdentifierFromUrl,
  rankCandidates,
  summarize,
  type EnrichCandidate,
} from "@/lib/linkedin/enrich";

function candidate(over: Partial<EnrichCandidate> = {}): EnrichCandidate {
  return {
    contactId: 1,
    publicIdentifier: "ana-silva",
    starred: false,
    hasCadence: false,
    lastInteractionAt: null,
    createdAt: 1000,
    ...over,
  };
}

describe("clampDailyCap", () => {
  it("falls back to the default for anything non-numeric", () => {
    expect(clampDailyCap(undefined)).toBe(DEFAULT_DAILY_CAP);
    expect(clampDailyCap(null)).toBe(DEFAULT_DAILY_CAP);
    expect(clampDailyCap(Number.NaN)).toBe(DEFAULT_DAILY_CAP);
  });

  it("refuses to let the trickle become a burst", () => {
    expect(clampDailyCap(100_000)).toBe(MAX_DAILY_CAP);
    expect(clampDailyCap(0)).toBe(1);
    expect(clampDailyCap(-5)).toBe(1);
  });

  it("keeps a sensible value as given", () => {
    expect(clampDailyCap(50)).toBe(50);
    expect(clampDailyCap(50.7)).toBe(50);
  });
});

describe("rankCandidates", () => {
  it("puts starred contacts first — the map should be useful on day one", () => {
    const ranked = rankCandidates([
      candidate({ contactId: 1 }),
      candidate({ contactId: 2, starred: true }),
    ]);
    expect(ranked[0].contactId).toBe(2);
  });

  it("then people on a cadence, then most recently spoken to", () => {
    const ranked = rankCandidates([
      candidate({ contactId: 1, lastInteractionAt: 500 }),
      candidate({ contactId: 2, hasCadence: true }),
      candidate({ contactId: 3, lastInteractionAt: 900 }),
    ]);
    expect(ranked.map((c) => c.contactId)).toEqual([2, 3, 1]);
  });

  it("is total — equal candidates never swap order between calls", () => {
    const input = [
      candidate({ contactId: 7 }),
      candidate({ contactId: 3 }),
      candidate({ contactId: 5 }),
    ];
    expect(rankCandidates(input).map((c) => c.contactId)).toEqual([3, 5, 7]);
    expect(rankCandidates([...input].reverse()).map((c) => c.contactId)).toEqual(
      [3, 5, 7]
    );
  });

  it("does not mutate its input", () => {
    const input = [candidate({ contactId: 1 }), candidate({ contactId: 2, starred: true })];
    rankCandidates(input);
    expect(input[0].contactId).toBe(1);
  });
});

describe("nextBatch", () => {
  const pool = [
    candidate({ contactId: 1 }),
    candidate({ contactId: 2 }),
    candidate({ contactId: 3 }),
  ];

  it("hands out at most the batch size", () => {
    expect(
      nextBatch(pool, { batchSize: 2, dailyCap: 100, checkedToday: 0 })
    ).toHaveLength(2);
  });

  it("hands out nothing once the day's budget is spent", () => {
    expect(
      nextBatch(pool, { batchSize: 10, dailyCap: 10, checkedToday: 10 })
    ).toHaveLength(0);
  });

  it("trims the last batch of the day to what's left", () => {
    expect(
      nextBatch(pool, { batchSize: 10, dailyCap: 10, checkedToday: 8 })
    ).toHaveLength(2);
  });

  it("never goes negative when the cap was lowered mid-day", () => {
    expect(
      nextBatch(pool, { batchSize: 10, dailyCap: 5, checkedToday: 40 })
    ).toHaveLength(0);
  });
});

describe("publicIdentifierFromUrl", () => {
  it("reads the identifier out of a stored profile URL", () => {
    expect(publicIdentifierFromUrl("linkedin.com/in/ana-silva")).toBe("ana-silva");
    expect(publicIdentifierFromUrl("https://www.linkedin.com/in/Ana-Silva/")).toBe(
      "ana-silva"
    );
    expect(
      publicIdentifierFromUrl("linkedin.com/in/ana-silva?trk=connections")
    ).toBe("ana-silva");
  });

  it("rejects things that aren't people", () => {
    expect(publicIdentifierFromUrl("linkedin.com/company/stripe")).toBeNull();
    expect(publicIdentifierFromUrl("linkedin.com/school/eth")).toBeNull();
    expect(publicIdentifierFromUrl("example.com/in/ana")).toBeNull();
  });
});

describe("extractLocation", () => {
  it("finds a location however deeply it is nested", () => {
    expect(
      extractLocation({ data: { included: [{ profile: { geoLocationName: "Zurich, Switzerland" } }] } })
    ).toBe("Zurich, Switzerland");
  });

  it("prefers the most specific key when several are present", () => {
    expect(
      extractLocation({
        country: "Switzerland",
        geoLocationName: "Zurich, Zurich, Switzerland",
      })
    ).toBe("Zurich, Zurich, Switzerland");
  });

  it("ignores URNs and bare ids that share those key names", () => {
    expect(extractLocation({ geoLocation: "urn:li:fs_geo:103644278" })).toBeNull();
    expect(extractLocation({ location: "1234567" })).toBeNull();
  });

  it("returns null rather than guessing when nothing is there", () => {
    // The shape the connections endpoint actually returns.
    expect(
      extractLocation({ firstName: "Ana", lastName: "Silva", headline: "PM at Stripe" })
    ).toBeNull();
  });

  it("survives junk without throwing", () => {
    expect(extractLocation(null)).toBeNull();
    expect(extractLocation("a string")).toBeNull();
    expect(extractLocation([1, 2, 3])).toBeNull();
  });

  it("stops descending rather than hanging on a cyclic payload", () => {
    const cyclic: Record<string, unknown> = { locationName: null };
    cyclic.self = cyclic;
    expect(() => extractLocation(cyclic)).not.toThrow();
  });
});

describe("summarize + driftWarning", () => {
  const results = (located: number, missing: number) => [
    ...Array.from({ length: located }, (_, i) => ({
      publicIdentifier: `found-${i}`,
      location: "Zurich",
    })),
    ...Array.from({ length: missing }, (_, i) => ({
      publicIdentifier: `none-${i}`,
      location: null,
    })),
  ];

  it("counts what was found and what wasn't", () => {
    expect(summarize(results(3, 2))).toEqual({
      attempted: 5,
      located: 3,
      missing: 2,
    });
  });

  it("stays quiet when the sample is too small to accuse anyone", () => {
    expect(driftWarning(summarize(results(0, 4)))).toBeNull();
  });

  it("calls out a large round where nobody had a location", () => {
    const warning = driftWarning(summarize(results(0, 25)));
    expect(warning).toContain("25");
    expect(warning).toContain("response shape");
  });

  it("stays quiet as soon as anything was found", () => {
    expect(driftWarning(summarize(results(1, 40)))).toBeNull();
  });
});
