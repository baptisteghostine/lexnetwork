"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Map as MapboxMapInstance, Marker } from "mapbox-gl";

import "mapbox-gl/dist/mapbox-gl.css";

import type { CityPin } from "@/lib/geo/geocode";
import type { PinPerson } from "@/server/map";

// The Mapbox renderer (SPEC §7a, owner-amended 2026-08-24): the Dex-style
// interactive globe, shown INSTEAD of the bundled SVG map when the owner
// has pasted a Mapbox token in Settings. Rendering only — identity of the
// data is unchanged: the same city pins (Nominatim-geocoded) and the same
// country bubbles, clicking through to the same ?city=/?c= URLs, so the
// side panel neither knows nor cares which renderer drew the click.
//
// The map instance is created ONCE and outlives navigation. Clicking a
// pin re-renders the page with new search params, which must only swap
// the markers — recreating the map would snap the camera back to its
// opening framing (and bill another map load) on every click.
//
// Tiles load in the owner's browser straight from Mapbox using their own
// token — an integration the owner explicitly configured, per the §13
// invariant. No token, no Mapbox: the page falls back to the SVG map.

export type MapCity = CityPin & { single: PinPerson | null };

export type CountryBubble = {
  id: string;
  name: string;
  lng: number;
  lat: number;
  count: number;
  single: PinPerson | null;
};

// Mapbox Standard: the full-colour earth — blue oceans, green terrain,
// atmosphere halo (the Dex look, owner-preferred over the muted
// monochrome basemap first shipped). Dark mode maps to its night
// lighting preset instead of a different style.
const STANDARD_STYLE = "mapbox://styles/mapbox/standard";

// The ContactAvatar palette, as concrete colors for raw-DOM markers —
// same hash, so a person is the same pastel here as everywhere else.
const PIN_COLORS: [string, string][] = [
  ["#ffe4e6", "#be123c"], // rose
  ["#ffedd5", "#c2410c"], // orange
  ["#fef3c7", "#b45309"], // amber
  ["#d1fae5", "#047857"], // emerald
  ["#ccfbf1", "#0f766e"], // teal
  ["#e0f2fe", "#0369a1"], // sky
  ["#e0e7ff", "#4338ca"], // indigo
  ["#ede9fe", "#6d28d9"], // violet
  ["#fce7f3", "#be185d"], // pink
];

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = [...words[0]][0] ?? "?";
  const last = words.length > 1 ? ([...words[words.length - 1]][0] ?? "") : "";
  return (first + last).toUpperCase();
}

function hue(name: string): [string, string] {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 997;
  return PIN_COLORS[h % PIN_COLORS.length];
}

const MARKER_BASE =
  "display:flex;align-items:center;justify-content:center;border-radius:9999px;border:2px solid var(--background);box-shadow:0 1px 4px rgb(0 0 0 / 0.3);cursor:pointer;overflow:hidden;";

/** One person → their face: photo when there is one, initials otherwise
 * (the Dex treatment; a violet dot says nothing about who is there). */
function personElement(person: PinPerson, title: string): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText = `${MARKER_BASE}width:32px;height:32px;`;
  el.title = title;
  if (person.hasPhoto) {
    const img = document.createElement("img");
    // Same-origin auth-gated route — the browser session cookie rides
    // along exactly as it does for avatars everywhere else in the app.
    img.src = `/api/photos/${person.id}`;
    img.alt = "";
    img.style.cssText = "width:100%;height:100%;object-fit:cover;";
    el.appendChild(img);
  } else {
    const [bg, fg] = hue(person.displayName);
    el.style.background = bg;
    el.style.color = fg;
    el.style.font = "600 12px/1 system-ui,sans-serif";
    el.textContent = initials(person.displayName);
  }
  return el;
}

/** Several people → a count, sized by share of the biggest cluster. */
function clusterElement(count: number, title: string, max: number): HTMLElement {
  const el = document.createElement("div");
  const size = 26 + 22 * Math.sqrt(count / Math.max(1, max));
  el.style.cssText = `${MARKER_BASE}width:${size}px;height:${size}px;background:var(--primary);color:var(--primary-foreground);font:600 ${Math.max(10, Math.min(13, size / 3))}px/1 system-ui,sans-serif;`;
  el.textContent = String(count);
  el.title = title;
  return el;
}

export function MapboxMap({
  token,
  cities,
  countryBubbles,
  fill = false,
}: {
  token: string;
  cities: MapCity[];
  countryBubbles: CountryBubble[];
  /** Fill the parent (full-bleed page) instead of a fixed-height card. */
  fill?: boolean;
}) {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapboxMapInstance | null>(null);
  const markersRef = useRef<Marker[]>([]);
  const didFitRef = useRef(false);
  const [ready, setReady] = useState(false);

  // Effect 1 — the map itself. Depends on the token alone: it survives
  // every ?city=/?c= navigation, keeping camera position and zoom.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Dynamic import: mapbox-gl touches `window` at module scope and is
      // ~250KB gzipped — only the map page, only when a token exists.
      const mapboxgl = (await import("mapbox-gl")).default;
      if (cancelled || !containerRef.current) return;
      mapboxgl.accessToken = token;

      const dark = document.documentElement.classList.contains("dark");
      const map = new mapboxgl.Map({
        container: containerRef.current,
        style: STANDARD_STYLE,
        projection: "globe",
        center: [15, 30],
        zoom: 1.4,
        attributionControl: true,
      });
      map.on("style.load", () => {
        map.setConfigProperty("basemap", "lightPreset", dark ? "night" : "day");
      });
      map.on("load", () => setReady(true));
      mapRef.current = map;
      map.addControl(new mapboxgl.NavigationControl({ showCompass: false }));
    })();

    return () => {
      cancelled = true;
      for (const m of markersRef.current) m.remove();
      markersRef.current = [];
      mapRef.current?.remove();
      mapRef.current = null;
      didFitRef.current = false;
      setReady(false);
    };
  }, [token]);

  // Effect 2 — markers only. Navigation re-renders the page with fresh
  // arrays; this swaps pins without touching the camera.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    void (async () => {
      const mapboxgl = (await import("mapbox-gl")).default;
      if (mapRef.current !== map) return; // torn down while importing

      for (const m of markersRef.current) m.remove();
      markersRef.current = [];

      const add = (
        lng: number,
        lat: number,
        el: HTMLElement,
        href: string
      ) => {
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          router.push(href);
        });
        markersRef.current.push(
          new mapboxgl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map)
        );
      };

      const maxCity = Math.max(1, ...cities.map((c) => c.count));
      for (const c of cities) {
        const title = `${c.label} — ${c.count} contact${c.count === 1 ? "" : "s"}`;
        const el = c.single
          ? personElement(c.single, `${c.single.displayName} — ${c.label}`)
          : clusterElement(c.count, title, maxCity);
        add(c.lng, c.lat, el, `/map?city=${c.key}`);
      }
      for (const b of countryBubbles) {
        const title = `${b.name} — ${b.count} contact${b.count === 1 ? "" : "s"}`;
        const el = b.single
          ? personElement(b.single, `${b.single.displayName} — ${b.name}`)
          : clusterElement(b.count, title, maxCity);
        if (!b.single) el.style.opacity = "0.6"; // country remainders read as secondary
        add(b.lng, b.lat, el, `/map?c=${b.id}`);
      }

      // Frame the network once, on the first data the map ever shows —
      // never again, or every click would re-home the camera.
      if (!didFitRef.current) {
        const points = [
          ...cities.map((c) => [c.lng, c.lat] as [number, number]),
          ...countryBubbles.map((b) => [b.lng, b.lat] as [number, number]),
        ];
        if (points.length > 0) {
          const bounds = points.reduce(
            (acc, p) => acc.extend(p),
            new mapboxgl.LngLatBounds(points[0], points[0])
          );
          map.fitBounds(bounds, { padding: 80, maxZoom: 5, duration: 0 });
        }
        didFitRef.current = true;
      }
    })();
  }, [ready, cities, countryBubbles, router]);

  return (
    <div
      ref={containerRef}
      className={
        fill
          ? "h-full w-full"
          : "h-[560px] w-full overflow-hidden rounded-lg border border-border"
      }
      role="img"
      aria-label="Contacts on an interactive world map"
    />
  );
}
