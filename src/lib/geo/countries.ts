// Country identity for the map (SPEC §7a). Keyed on ISO 3166-1 numeric
// ids as strings — the same ids world-atlas uses — so the resolver, the
// geometry, and the page agree without a translation layer.
//
// Dependency justification (CLAUDE.md): `world-atlas` is the geometry
// (Natural Earth, prebuilt TopoJSON, no network calls — the whole point
// is a map that never phones a tile server), `topojson-client` decodes
// it, `d3-geo` is the projection math. All three are pure data/math.

import { feature } from "topojson-client";
import type { FeatureCollection, Geometry } from "geojson";
import type { GeometryCollection, Topology } from "topojson-specification";
import worldData from "world-atlas/countries-110m.json";

// The JSON import types `type` as plain string; the data is a Topology.
const topo = worldData as unknown as Topology<{
  countries: GeometryCollection<{ name: string }>;
}>;

export type CountryFeature = {
  id: string;
  name: string;
  geometry: Geometry;
};

/** The 110m polygons — small enough to bundle (~110 KB), detailed enough
 * for a dashboard map. */
export function countryFeatures(): CountryFeature[] {
  const fc = feature(
    topo,
    topo.objects.countries
  ) as unknown as FeatureCollection<Geometry, { name: string }>;
  return fc.features
    .filter((f) => f.id !== undefined)
    .map((f) => ({
      id: String(f.id),
      name: f.properties.name,
      geometry: f.geometry,
    }));
}

/**
 * Countries/territories the 110m simplification drops entirely, several
 * of which are exactly the networking hubs a contact list is full of.
 * They get a labeled bubble at a fixed point instead of a polygon.
 * [lon, lat].
 */
export const EXTRA_PLACES: { id: string; name: string; lonLat: [number, number] }[] = [
  { id: "702", name: "Singapore", lonLat: [103.82, 1.35] },
  { id: "344", name: "Hong Kong", lonLat: [114.17, 22.32] },
  { id: "446", name: "Macao", lonLat: [113.55, 22.19] },
  { id: "470", name: "Malta", lonLat: [14.51, 35.9] },
  { id: "048", name: "Bahrain", lonLat: [50.55, 26.07] },
  { id: "492", name: "Monaco", lonLat: [7.42, 43.74] },
  { id: "020", name: "Andorra", lonLat: [1.52, 42.51] },
  { id: "438", name: "Liechtenstein", lonLat: [9.55, 47.16] },
  { id: "480", name: "Mauritius", lonLat: [57.55, -20.35] },
  { id: "462", name: "Maldives", lonLat: [73.51, 4.18] },
];

/** Display name for every id the map can produce. */
export function countryNames(): Map<string, string> {
  const names = new Map<string, string>();
  for (const f of countryFeatures()) names.set(f.id, f.name);
  for (const p of EXTRA_PLACES) names.set(p.id, p.name);
  return names;
}
