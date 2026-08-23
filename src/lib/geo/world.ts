// Projected world geometry for the map (SPEC §7a). Importable from the
// client bundle: the atlas + projection math ship once with the app and
// render locally — no tile server, no API key, nothing phoned.

import { geoNaturalEarth1, geoPath } from "d3-geo";
import type { Geometry } from "geojson";

import { countryFeatures, EXTRA_PLACES } from "./countries";

export const MAP_WIDTH = 960;
export const MAP_HEIGHT = 500;

export type CountryShape = {
  id: string;
  name: string;
  d: string;
  centroid: [number, number];
};

export type WorldGeometry = {
  shapes: CountryShape[];
  /** Bubble anchors for places with no 110m polygon (Singapore, HK…). */
  extraPoints: { id: string; name: string; point: [number, number] }[];
};

let cached: WorldGeometry | null = null;
let cachedProjection: ReturnType<typeof geoNaturalEarth1> | null = null;

/** lon/lat → SVG x/y in the same projection the country shapes use, so
 * city pins land exactly on their polygons. Null off-projection. */
export function projectPoint(
  lng: number,
  lat: number
): [number, number] | null {
  if (!cachedProjection) worldGeometry();
  const p = cachedProjection?.([lng, lat]);
  return p ? [p[0], p[1]] : null;
}

export function worldGeometry(): WorldGeometry {
  if (cached) return cached;
  const features = countryFeatures();
  const projection = geoNaturalEarth1().fitSize([MAP_WIDTH, MAP_HEIGHT], {
    type: "FeatureCollection",
    features: features.map((f) => ({
      type: "Feature" as const,
      geometry: f.geometry,
      properties: {},
    })),
  });
  const path = geoPath(projection);
  const shapes: CountryShape[] = [];
  for (const f of features) {
    const featureObj = {
      type: "Feature" as const,
      geometry: f.geometry as Geometry,
      properties: {},
    };
    const d = path(featureObj);
    if (!d) continue;
    const centroid = path.centroid(featureObj);
    shapes.push({ id: f.id, name: f.name, d, centroid: [centroid[0], centroid[1]] });
  }
  const extraPoints = EXTRA_PLACES.flatMap((p) => {
    const projected = projection(p.lonLat);
    return projected
      ? [{ id: p.id, name: p.name, point: [projected[0], projected[1]] as [number, number] }]
      : [];
  });
  cachedProjection = projection;
  cached = { shapes, extraPoints };
  return cached;
}

/** Bubble radius: area proportional to count, clamped to stay readable. */
export function bubbleRadius(count: number, maxCount: number): number {
  const MIN = 7;
  const MAX = 26;
  if (maxCount <= 0 || count <= 0) return 0;
  return MIN + (MAX - MIN) * Math.sqrt(count / maxCount);
}
