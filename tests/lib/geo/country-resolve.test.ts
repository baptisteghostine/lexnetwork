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
  // Diacritics and case — suffix scanning reads the trailing city name
  ["MÜNCHEN? no — munich", "276"],
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

describe("localized and Arabic locations (Dex/LinkedIn export reality)", () => {
  const LOCALIZED: [string, string][] = [
    ["Lausanne, Waadt, Schweiz", "756"],
    ["Zürich, Zürich, Schweiz", "756"],
    ["Genf, Genf, Schweiz", "756"],
    ["München, Bayern, Deutschland", "276"],
    ["Madrid, Comunidad de Madrid, España", "724"],
    ["Amsterdam, Nederland", "528"],
    ["Wien, Österreich", "040"],
    ["Paris, Île-de-France, France", "250"],
    ["Lyon, Auvergne-Rhône-Alpes, France", "250"],
    ["Roma, Italia", "380"],
    ["København, Danmark", "208"],
    ["Vereinigtes Königreich", "826"],
    ["États-Unis", "840"],
    // Arabic, including the comma-less governorate form
    ["محافظة بيروت لبنان", "422"],
    ["دبي الإمارات العربية المتحدة", "784"],
    ["الرياض السعودية", "682"],
    ["القاهرة, مصر", "818"],
    ["بيروت", "422"],
  ];
  for (const [input, expected] of LOCALIZED) {
    it(`${JSON.stringify(input)} → ${expected}`, () => {
      expect(resolveCountry(input)).toBe(expected);
    });
  }
});
