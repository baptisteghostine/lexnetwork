import Link from "next/link";

import { ContactAvatar } from "@/components/contact-avatar";
import { MapboxMap, type CountryBubble } from "@/components/mapbox-map";
import { WorldMap } from "@/components/world-map";
import { requireAuth } from "@/lib/auth";
import { countryNames } from "@/lib/geo/countries";
import { countryCentroidsLonLat } from "@/lib/geo/world";
import { getSetting } from "@/lib/settings";
import { readMapData } from "@/server/map";

export const dynamic = "force-dynamic";

export default async function MapPage({ searchParams }: PageProps<"/map">) {
  // Pages guard themselves — see contacts/page.tsx for why.
  await requireAuth();
  const params = await searchParams;
  const selectedId = typeof params.c === "string" ? params.c : null;
  const selectedCity = typeof params.city === "string" ? params.city : null;
  const data = await readMapData(selectedId, selectedCity);

  const names = countryNames();
  const ranked = Object.entries(data.counts)
    .map(([id, count]) => ({ id, count, name: names.get(id) ?? id }))
    .sort((a, b) => b.count - a.count);

  // Renderer choice (SPEC §7a, owner-amended 2026-08-24): Mapbox globe
  // when the owner pasted a token, the bundled SVG otherwise — same
  // data, same click-through URLs either way.
  const mapboxToken = getSetting<string>("mapbox.token") ?? "";
  const centroids = countryCentroidsLonLat();
  const countryBubbles: CountryBubble[] = Object.entries(data.bubbleCounts)
    .filter(([id, n]) => n > 0 && centroids.has(id))
    .map(([id, n]) => ({
      id,
      name: names.get(id) ?? id,
      lng: centroids.get(id)![0],
      lat: centroids.get(id)![1],
      count: n,
    }));

  return (
    <div className="flex h-[calc(100vh-0px)] min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-baseline justify-between border-b border-border px-5 py-2.5">
          <h1 className="text-sm font-semibold">Map</h1>
          <p className="text-xs text-muted-foreground">
            {data.totalPlaced.toLocaleString()} contacts placed in{" "}
            {ranked.length} countries
            {data.noLocation > 0 ? ` · ${data.noLocation} without a location` : ""}
          </p>
        </header>
        {mapboxToken ? (
          // Full-bleed globe: the map is the page, helpers float on it.
          <div className="relative min-h-0 flex-1">
            <MapboxMap
              token={mapboxToken}
              cities={data.cities}
              countryBubbles={countryBubbles}
              fill
            />
            <div className="pointer-events-none absolute bottom-6 left-3 z-10 max-w-[60%] space-y-1.5">
              {data.unrecognized.length > 0 && (
                <ul className="flex flex-wrap gap-1.5 text-[11px]">
                  {data.unrecognized.map((u) => (
                    <li
                      key={u.location}
                      title='This location string could not be placed — edit it to a "City, Country" form.'
                      className="rounded-md border border-border bg-background/85 px-1.5 py-0.5 text-muted-foreground backdrop-blur"
                    >
                      {u.location} · {u.count}
                    </li>
                  ))}
                </ul>
              )}
              {data.cities.length > 0 ? (
                <p className="text-[10px] text-muted-foreground/80 [text-shadow:0_0_4px_var(--background)]">
                  City placement data © OpenStreetMap contributors
                </p>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="p-4">
              <WorldMap
                counts={data.bubbleCounts}
                cities={data.cities}
                selectedId={selectedId}
                selectedCityKey={selectedCity}
              />
              {data.cities.length > 0 ? (
                <p className="mt-1 text-right text-[10px] text-muted-foreground/70">
                  City placement data © OpenStreetMap contributors
                </p>
              ) : null}
              {!data.geocodeOn && data.totalPlaced > 0 ? (
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Want city-level pins like Dex? Turn on{" "}
                  <span className="font-medium">
                    Settings → Integrations → Place cities with OpenStreetMap
                  </span>{" "}
                  — free, no account, and only the location text ever leaves
                  Rolo.
                </p>
              ) : null}
            </div>
            {data.unrecognized.length > 0 && (
              <div className="border-t border-border px-5 py-3">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Locations the map couldn&rsquo;t place
                </h2>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Editing these contacts&rsquo; locations to a &ldquo;City,
                  Country&rdquo; form will put them on the map.
                </p>
                <ul className="mt-2 flex flex-wrap gap-2 text-xs">
                  {data.unrecognized.map((u) => (
                    <li
                      key={u.location}
                      className="rounded-md border border-border px-2 py-1 text-muted-foreground"
                    >
                      {u.location} · {u.count}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>

      <aside className="flex w-72 shrink-0 flex-col border-l border-border">
        {data.selected ? (
          <>
            <div className="flex items-baseline justify-between border-b border-border px-4 py-2.5">
              <h2 className="text-[13px] font-semibold">{data.selected.name}</h2>
              <Link
                href="/map"
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Clear
              </Link>
            </div>
            <ul className="flex-1 space-y-0.5 overflow-y-auto p-2">
              {data.selected.contacts.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/contacts/${c.id}`}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent"
                  >
                    <ContactAvatar
                      contactId={c.id}
                      name={c.displayName}
                      hasPhoto={c.hasPhoto}
                      size="sm"
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-[12.5px] font-medium">
                        {c.displayName}
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {[c.title, c.company].filter(Boolean).join(" · ") ||
                          c.location}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <div className="flex-1 overflow-y-auto">
            {data.cities.length > 0 ? (
              <>
                <div className="border-b border-border px-4 py-2.5">
                  <h2 className="text-[13px] font-semibold">By city</h2>
                </div>
                <ul className="p-2">
                  {data.cities.slice(0, 15).map((c) => (
                    <li key={c.key}>
                      <Link
                        href={`/map?city=${c.key}`}
                        className="flex items-baseline justify-between rounded-md px-2 py-1.5 text-[12.5px] hover:bg-accent"
                      >
                        <span className="truncate">{c.label}</span>
                        <span className="tabular-nums text-muted-foreground">
                          {c.count}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            <div className="border-b border-t border-border px-4 py-2.5">
              <h2 className="text-[13px] font-semibold">By country</h2>
            </div>
            <ul className="p-2">
              {ranked.length === 0 ? (
                <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                  No contacts with recognizable locations yet.
                </p>
              ) : (
                ranked.map((c) => (
                  <li key={c.id}>
                    <Link
                      href={`/map?c=${c.id}`}
                      className="flex items-baseline justify-between rounded-md px-2 py-1.5 text-[12.5px] hover:bg-accent"
                    >
                      <span className="truncate">{c.name}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {c.count}
                      </span>
                    </Link>
                  </li>
                ))
              )}
            </ul>
          </div>
        )}
      </aside>
    </div>
  );
}
