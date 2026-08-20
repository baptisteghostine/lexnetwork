"use server";

import { isNull } from "drizzle-orm";

import { db } from "@/db/client";
import { contacts } from "@/db/schema";
import { requireAuth } from "@/lib/auth";
import { countryNames } from "@/lib/geo/countries";
import { resolveCountry } from "@/lib/geo/country-resolve";

// Data for the map page (SPEC §7a): one pass over non-archived contacts,
// resolver in lib/geo where it's unit-tested.

export type MapContact = {
  id: number;
  displayName: string;
  title: string | null;
  company: string | null;
  location: string | null;
  hasPhoto: boolean;
};

export type MapData = {
  counts: Record<string, number>;
  totalPlaced: number;
  noLocation: number;
  /** Distinct location strings the resolver couldn't place, most common first. */
  unrecognized: { location: string; count: number }[];
  selected: { id: string; name: string; contacts: MapContact[] } | null;
};

export async function readMapData(selectedId: string | null): Promise<MapData> {
  await requireAuth();
  const rows = db
    .select({
      id: contacts.id,
      displayName: contacts.displayName,
      title: contacts.title,
      company: contacts.company,
      location: contacts.location,
      photoPath: contacts.photoPath,
    })
    .from(contacts)
    .where(isNull(contacts.archivedAt))
    .all();

  const counts: Record<string, number> = {};
  const unrecognizedCounts = new Map<string, number>();
  let noLocation = 0;
  let totalPlaced = 0;
  const selectedContacts: MapContact[] = [];

  for (const row of rows) {
    if (!row.location || row.location.trim() === "") {
      noLocation += 1;
      continue;
    }
    const country = resolveCountry(row.location);
    if (country === null) {
      unrecognizedCounts.set(
        row.location,
        (unrecognizedCounts.get(row.location) ?? 0) + 1
      );
      continue;
    }
    counts[country] = (counts[country] ?? 0) + 1;
    totalPlaced += 1;
    if (selectedId !== null && country === selectedId) {
      selectedContacts.push({
        id: row.id,
        displayName: row.displayName,
        title: row.title,
        company: row.company,
        location: row.location,
        hasPhoto: row.photoPath !== null,
      });
    }
  }

  selectedContacts.sort((a, b) => a.displayName.localeCompare(b.displayName));
  const names = countryNames();
  return {
    counts,
    totalPlaced,
    noLocation,
    unrecognized: [...unrecognizedCounts.entries()]
      .map(([location, count]) => ({ location, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12),
    selected:
      selectedId !== null && names.has(selectedId)
        ? {
            id: selectedId,
            name: names.get(selectedId)!,
            contacts: selectedContacts,
          }
        : null,
  };
}
