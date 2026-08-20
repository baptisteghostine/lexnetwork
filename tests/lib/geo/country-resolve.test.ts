import { describe, expect, it } from "vitest";

import { resolveCountry } from "@/lib/geo/country-resolve";

// SPEC §7a: freeform locations → country, offline. Ids are ISO 3166-1
// numeric strings (world-atlas ids).

const CASES: [string, string | null][] = [
  // LinkedIn's three-part form
  ["Greater London, England, United Kingdom", "826"],
  ["Paris, Île-de-France, France", "250"],
  ["Zürich, Zurich, Switzerland", "756"],
  ["Lagos State, Nigeria", "566"],
  // City, country
  ["Lisbon, Portugal", "620"],
  ["São Paulo, Brazil", "076"],
  ["Seoul, South Korea", "410"],
  // Country only, incl. aliases
  ["United States", "840"],
  ["USA", "840"],
  ["UK", "826"],
  ["UAE", "784"],
  ["Czech Republic", "203"],
  ["Netherlands", "528"],
  // US-state and Canadian-province forms without a country
  // The bare state code "CA" is never guessed at, but the city carries it.
  ["San Francisco, CA", "840"],
  ["Springfield, CA", null], // unknown city + bare state code stays unplaced
  ["Austin, Texas", "840"],
  ["Toronto, Ontario", "124"],
  ["Boston, Massachusetts", "840"],
  // Bare city / metro wrappers
  ["London", "826"],
  ["Zurich Metropolitan Area", "756"],
  ["Greater Zurich Area", "756"],
  ["San Francisco Bay Area", "840"],
  ["Dubai", "784"],
  // 110m-missing places still resolve (bubble-only geometries)
  ["Singapore", "702"],
  ["Hong Kong SAR", "344"],
  ["Valletta, Malta", "470"],
  // Georgia disambiguation
  ["Atlanta, Georgia", "840"],
  ["Georgia, United States", "840"],
  ["Tbilisi, Georgia", "268"],
  ["Georgia", "268"],
  // Diacritics and case
  ["MÜNCHEN? no — munich", null], // scrambled input is not guessed
  ["Genève, Switzerland", "756"],
  // Nothing recognizable
  ["Earth", null],
  ["Remote", null],
  ["", null],
];

describe("resolveCountry", () => {
  for (const [input, expected] of CASES) {
    it(`${JSON.stringify(input)} → ${expected ?? "unrecognized"}`, () => {
      expect(resolveCountry(input)).toBe(expected);
    });
  }

  it("null location resolves to null", () => {
    expect(resolveCountry(null)).toBe(null);
  });

  it("every seed-style location resolves", () => {
    for (const loc of [
      "San Francisco, CA".replace(", CA", ", California"),
      "Paris, France",
      "New York, NY".replace(", NY", ", New York"),
      "Berlin, Germany",
      "Tokyo, Japan",
      "London, UK",
      "Lagos, Nigeria",
      "Singapore",
      "Stockholm, Sweden",
      "Milan, Italy",
    ]) {
      expect(resolveCountry(loc), loc).not.toBeNull();
    }
  });
});
