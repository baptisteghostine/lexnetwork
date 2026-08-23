import { describe, expect, it } from "vitest";

import {
  cityKey,
  groupCityPins,
  nominatimUrl,
  parseNominatimResponse,
} from "@/lib/geo/geocode";

describe("nominatimUrl", () => {
  it("targets the allowlisted host with one result requested", () => {
    const url = new URL(nominatimUrl("Zurich, Zurich, Switzerland"));
    expect(url.hostname).toBe("nominatim.openstreetmap.org");
    expect(url.searchParams.get("q")).toBe("Zurich, Zurich, Switzerland");
    expect(url.searchParams.get("limit")).toBe("1");
    expect(url.searchParams.get("format")).toBe("jsonv2");
  });

  it("survives locations that look like URL syntax", () => {
    const url = new URL(nominatimUrl("Foo & Bar / Baz?=x"));
    expect(url.searchParams.get("q")).toBe("Foo & Bar / Baz?=x");
  });
});

describe("parseNominatimResponse", () => {
  it("reads the first result's coordinates (Nominatim sends strings)", () => {
    expect(
      parseNominatimResponse([{ lat: "47.3745", lon: "8.5410" }])
    ).toEqual({ lat: 47.3745, lng: 8.541 });
  });

  it("treats an empty array as a miss, not an error", () => {
    expect(parseNominatimResponse([])).toBeNull();
  });

  it("rejects junk and out-of-range coordinates", () => {
    expect(parseNominatimResponse(null)).toBeNull();
    expect(parseNominatimResponse({ lat: 1, lon: 2 })).toBeNull();
    expect(parseNominatimResponse([{ lat: "91", lon: "0" }])).toBeNull();
    expect(parseNominatimResponse([{ lat: "0", lon: "181" }])).toBeNull();
    expect(parseNominatimResponse([{ lat: "abc", lon: "8.5" }])).toBeNull();
  });
});

describe("groupCityPins", () => {
  it("merges spellings that geocode to the same city", () => {
    // 47.3745 vs 47.3769 straddle a 0.005 rounding boundary — the case
    // that proves clustering is by distance, not by grid cell.
    const pins = groupCityPins([
      { location: "Zurich, Switzerland", lat: 47.3745, lng: 8.541 },
      { location: "Zürich, Zurich, Switzerland", lat: 47.3769, lng: 8.5417 },
      { location: "Zürich, Zurich, Switzerland", lat: 47.3769, lng: 8.5417 },
    ]);
    expect(pins).toHaveLength(1);
    expect(pins[0].count).toBe(3);
    // Most common string wins the label, trimmed to its city half.
    expect(pins[0].label).toBe("Zürich");
    expect(pins[0].members).toHaveLength(3);
  });

  it("is order-independent — the same rows group the same way shuffled", () => {
    const rows = [
      { location: "Zurich, Switzerland", lat: 47.3745, lng: 8.541 },
      { location: "Zürich, Zurich, Switzerland", lat: 47.3769, lng: 8.5417 },
      { location: "Paris, France", lat: 48.8575, lng: 2.3514 },
    ];
    const a = groupCityPins(rows).map((p) => p.key);
    const b = groupCityPins([...rows].reverse()).map((p) => p.key);
    expect(a).toEqual(b);
  });

  it("keeps genuinely different cities apart", () => {
    const pins = groupCityPins([
      { location: "London, UK", lat: 51.5072, lng: -0.1276 },
      { location: "Paris, France", lat: 48.8575, lng: 2.3514 },
    ]);
    expect(pins).toHaveLength(2);
  });

  it("sorts by count so the side list leads with the biggest city", () => {
    const pins = groupCityPins([
      { location: "Paris, France", lat: 48.8575, lng: 2.3514 },
      { location: "London, UK", lat: 51.5072, lng: -0.1276 },
      { location: "London, UK", lat: 51.5072, lng: -0.1276 },
    ]);
    expect(pins[0].label).toBe("London");
  });

  it("keys are stable and round-trip through URLs", () => {
    const key = cityKey(47.3745, 8.541);
    expect(key).toBe("47.37,8.54");
    expect(decodeURIComponent(encodeURIComponent(key))).toBe(key);
  });
});
