"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import type { CityPin } from "@/lib/geo/geocode";
import {
  bubbleRadius,
  MAP_HEIGHT,
  MAP_WIDTH,
  projectPoint,
  worldGeometry,
} from "@/lib/geo/world";
import { cn } from "@/lib/utils";

// The map itself (SPEC §7a): country polygons shaded by presence, a
// count bubble per country (the Dex pattern), click → the page reloads
// with that country's contact list in the side panel. Geocoded contacts
// render as city pins instead of feeding a country bubble, so each
// person appears exactly once. All geometry is bundled — this component
// makes zero network requests of its own.

export function WorldMap({
  counts,
  cities = [],
  selectedId,
  selectedCityKey = null,
}: {
  counts: Record<string, number>;
  cities?: CityPin[];
  selectedId: string | null;
  selectedCityKey?: string | null;
}) {
  const router = useRouter();
  const [hovered, setHovered] = useState<string | null>(null);
  const geometry = useMemo(() => worldGeometry(), []);
  const maxCount = Math.max(0, ...Object.values(counts));

  const bubbles = useMemo(() => {
    const anchors = new Map<string, { name: string; point: [number, number] }>();
    for (const s of geometry.shapes) {
      anchors.set(s.id, { name: s.name, point: s.centroid });
    }
    for (const p of geometry.extraPoints) {
      anchors.set(p.id, { name: p.name, point: p.point });
    }
    return Object.entries(counts)
      .filter(([id, n]) => n > 0 && anchors.has(id))
      .map(([id, n]) => ({
        id,
        count: n,
        name: anchors.get(id)!.name,
        point: anchors.get(id)!.point,
        r: bubbleRadius(n, maxCount),
      }))
      // Big bubbles first so small neighbours stay clickable on top.
      .sort((a, b) => b.r - a.r);
  }, [counts, geometry, maxCount]);

  const maxCity = Math.max(0, ...cities.map((c) => c.count));
  const cityDots = useMemo(
    () =>
      cities
        .flatMap((c) => {
          const point = projectPoint(c.lng, c.lat);
          return point ? [{ ...c, point, r: bubbleRadius(c.count, maxCity) * 0.75 }] : [];
        })
        .sort((a, b) => b.r - a.r),
    [cities, maxCity]
  );

  const select = (id: string) =>
    router.push(id === selectedId ? "/map" : `/map?c=${id}`);
  const selectCity = (key: string) =>
    router.push(key === selectedCityKey ? "/map" : `/map?city=${key}`);

  return (
    <svg
      viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
      className="h-auto w-full"
      role="img"
      aria-label="Contacts by country"
    >
      {geometry.shapes.map((s) => {
        const has = (counts[s.id] ?? 0) > 0;
        return (
          <path
            key={s.id}
            d={s.d}
            data-country={s.id}
            onClick={() => has && select(s.id)}
            onMouseEnter={() => setHovered(s.id)}
            onMouseLeave={() => setHovered((h) => (h === s.id ? null : h))}
            className={cn(
              "stroke-border stroke-[0.5]",
              has
                ? "cursor-pointer fill-primary/25 hover:fill-primary/40"
                : "fill-muted",
              selectedId === s.id && "fill-primary/50"
            )}
          >
            <title>
              {s.name}
              {has ? ` — ${counts[s.id]} contact${counts[s.id] === 1 ? "" : "s"}` : ""}
            </title>
          </path>
        );
      })}
      {bubbles.map((b) => (
        <g
          key={b.id}
          data-bubble={b.id}
          transform={`translate(${b.point[0]}, ${b.point[1]})`}
          onClick={() => select(b.id)}
          onMouseEnter={() => setHovered(b.id)}
          onMouseLeave={() => setHovered((h) => (h === b.id ? null : h))}
          className="cursor-pointer"
        >
          <circle
            r={b.r}
            className={cn(
              "fill-primary stroke-background stroke-1 transition-opacity",
              hovered === b.id || selectedId === b.id
                ? "opacity-100"
                : "opacity-80"
            )}
          />
          <text
            textAnchor="middle"
            dominantBaseline="central"
            className="fill-primary-foreground font-medium"
            fontSize={Math.max(9, Math.min(12, b.r))}
          >
            {b.count}
          </text>
          <title>
            {b.name} — {b.count} contact{b.count === 1 ? "" : "s"}
          </title>
        </g>
      ))}
      {cityDots.map((c) => (
        <g
          key={c.key}
          data-city={c.key}
          transform={`translate(${c.point[0]}, ${c.point[1]})`}
          onClick={() => selectCity(c.key)}
          className="cursor-pointer"
        >
          <circle
            r={c.r}
            className={cn(
              "fill-primary stroke-background transition-opacity",
              selectedCityKey === c.key ? "opacity-100" : "opacity-90"
            )}
            strokeWidth={1.5}
          />
          {c.r >= 7 ? (
            <text
              textAnchor="middle"
              dominantBaseline="central"
              className="pointer-events-none fill-primary-foreground font-medium"
              fontSize={Math.max(8, Math.min(11, c.r))}
            >
              {c.count}
            </text>
          ) : null}
          <title>
            {c.label} — {c.count} contact{c.count === 1 ? "" : "s"}
          </title>
        </g>
      ))}
    </svg>
  );
}
