import Link from "next/link";

import { ContactAvatar } from "@/components/contact-avatar";
import { WorldMap } from "@/components/world-map";
import { requireAuth } from "@/lib/auth";
import { countryNames } from "@/lib/geo/countries";
import { readMapData } from "@/server/map";

export const dynamic = "force-dynamic";

export default async function MapPage({ searchParams }: PageProps<"/map">) {
  // Pages guard themselves — see contacts/page.tsx for why.
  await requireAuth();
  const params = await searchParams;
  const selectedId = typeof params.c === "string" ? params.c : null;
  const data = await readMapData(selectedId);

  const names = countryNames();
  const ranked = Object.entries(data.counts)
    .map(([id, count]) => ({ id, count, name: names.get(id) ?? id }))
    .sort((a, b) => b.count - a.count);

  return (
    <div className="flex h-[calc(100vh-0px)] min-h-0">
      <div className="min-w-0 flex-1 overflow-y-auto">
        <header className="flex items-baseline justify-between border-b border-border px-5 py-2.5">
          <h1 className="text-sm font-semibold">Map</h1>
          <p className="text-xs text-muted-foreground">
            {data.totalPlaced.toLocaleString()} contacts placed in{" "}
            {ranked.length} countries
            {data.noLocation > 0 ? ` · ${data.noLocation} without a location` : ""}
          </p>
        </header>
        <div className="p-4">
          <WorldMap counts={data.counts} selectedId={data.selected?.id ?? null} />
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
          <>
            <div className="border-b border-border px-4 py-2.5">
              <h2 className="text-[13px] font-semibold">By country</h2>
            </div>
            <ul className="flex-1 overflow-y-auto p-2">
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
          </>
        )}
      </aside>
    </div>
  );
}
