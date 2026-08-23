"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import type { Map as MapboxMapInstance, Marker } from "mapbox-gl";

import "mapbox-gl/dist/mapbox-gl.css";

import type { CityPin } from "@/lib/geo/geocode";

// The Mapbox renderer (SPEC §7a, owner-amended 2026-08-24): the Dex-style
// interactive globe, shown INSTEAD of the bundled SVG map when the owner
// has pasted a Mapbox token in Settings. Rendering only — identity of the
// data is unchanged: the same city pins (Nominatim-geocoded) and the same
// country bubbles, clicking through to the same ?city=/?c= URLs, so the
// side panel neither knows nor cares which renderer drew the click.
//
// Tiles load in the owner's browser straight from Mapbox using their own
// token — an integration the owner explicitly configured, per the §13
// invariant. No token, no Mapbox: the page falls back to the SVG map.

export type CountryBubble = {
  id: string;
  name: string;
  lng: number;
  lat: number;
  count: number;
};

// Mapbox Standard: the full-colour earth — blue oceans, green terrain,
// atmosphere halo (the Dex look, owner-preferred over the muted
// monochrome basemap first shipped). Dark mode maps to its night
// lighting preset instead of a different style.
const STANDARD_STYLE = "mapbox://styles/mapbox/standard";

function pinElement(count: number, label: string, max: number): HTMLElement {
  const el = document.createElement("div");
  const size = 22 + 26 * Math.sqrt(Math.max(1, count) / Math.max(1, max));
  el.style.cssText = `width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;border-radius:9999px;background:var(--primary);color:var(--primary-foreground);font:600 ${Math.max(10, Math.min(13, size / 3))}px/1 system-ui,sans-serif;border:1.5px solid var(--background);box-shadow:0 1px 4px rgb(0 0 0 / 0.25);cursor:pointer;`;
  el.textContent = count > 1 ? String(count) : "";
  el.title = `${label} — ${count} contact${count === 1 ? "" : "s"}`;
  return el;
}

function bubbleElement(count: number, label: string, max: number): HTMLElement {
  const el = pinElement(count, label, max);
  // Country remainders read as secondary next to city pins.
  el.style.opacity = "0.55";
  return el;
}

export function MapboxMap({
  token,
  cities,
  countryBubbles,
}: {
  token: string;
  cities: CityPin[];
  countryBubbles: CountryBubble[];
}) {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapboxMapInstance | null>(null);

  useEffect(() => {
    let cancelled = false;
    const markers: Marker[] = [];

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
        map.setConfigProperty(
          "basemap",
          "lightPreset",
          dark ? "night" : "day"
        );
      });
      mapRef.current = map;
      map.addControl(new mapboxgl.NavigationControl({ showCompass: false }));

      const maxCity = Math.max(1, ...cities.map((c) => c.count));
      for (const c of cities) {
        const el = pinElement(c.count, c.label, maxCity);
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          router.push(`/map?city=${c.key}`);
        });
        markers.push(
          new mapboxgl.Marker({ element: el })
            .setLngLat([c.lng, c.lat])
            .addTo(map)
        );
      }
      const maxCountry = Math.max(1, ...countryBubbles.map((b) => b.count));
      for (const b of countryBubbles) {
        const el = bubbleElement(b.count, b.name, maxCountry);
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          router.push(`/map?c=${b.id}`);
        });
        markers.push(
          new mapboxgl.Marker({ element: el })
            .setLngLat([b.lng, b.lat])
            .addTo(map)
        );
      }

      // Open framed on the network rather than on a default hemisphere.
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
    })();

    return () => {
      cancelled = true;
      for (const m of markers) m.remove();
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // Recreating the map on data change is correct here: the props only
    // change with a server rerender (navigation), and markers are cheap.
  }, [token, cities, countryBubbles, router]);

  return (
    <div
      ref={containerRef}
      className="h-[560px] w-full overflow-hidden rounded-lg border border-border"
      role="img"
      aria-label="Contacts on an interactive world map"
    />
  );
}
