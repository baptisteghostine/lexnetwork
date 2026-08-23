"use server";

import { isNull } from "drizzle-orm";

import { db } from "@/db/client";
import { contacts } from "@/db/schema";
import { requireAuth } from "@/lib/auth";
import { countryNames } from "@/lib/geo/countries";
import { resolveCountry } from "@/lib/geo/country-resolve";
import { groupCityPins, type CityPin } from "@/lib/geo/geocode";
import { geocodeEnabled } from "@/server/sync/geocode";

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

/** Enough of a contact to draw them as a map marker: photo or initials. */
export type PinPerson = {
  id: number;
  displayName: string;
  hasPhoto: boolean;
};

export type MapData = {
  /** Full per-country totals: choropleth shading + the side list. */
  counts: Record<string, number>;
  /** Country bubbles show only contacts NOT pinned to a city, so each
   * person appears exactly once on the map. */
  bubbleCounts: Record<string, number>;
  /** A one-person country bubble renders as that person, not a count. */
  bubbleSingles: Record<string, PinPerson>;
  /** Geocoded city pins; `single` set when the pin is one person. */
  cities: (CityPin & { single: PinPerson | null })[];
  geocodeOn: boolean;
  totalPlaced: number;
  noLocation: number;
  /** Distinct location strings the resolver couldn't place, most common first. */
  unrecognized: { location: string; count: number }[];
  selected: { id: string; name: string; contacts: MapContact[] } | null;
};

export async function readMapData(
  selectedId: string | null,
  selectedCity: string | null = null
): Promise<MapData> {
  await requireAuth();
  const rows = db
    .select({
      id: contacts.id,
      displayName: contacts.displayName,
      title: contacts.title,
      company: contacts.company,
      location: contacts.location,
      locationLat: contacts.locationLat,
      locationLng: contacts.locationLng,
      photoPath: contacts.photoPath,
    })
    .from(contacts)
    .where(isNull(contacts.archivedAt))
    .all();

  const counts: Record<string, number> = {};
  const bubbleCounts: Record<string, number> = {};
  const bubbleMembers = new Map<string, MapContact[]>();
  const cityRows: {
    location: string;
    lat: number;
    lng: number;
    contact: MapContact;
  }[] = [];
  const unrecognizedCounts = new Map<string, number>();
  let noLocation = 0;
  let totalPlaced = 0;
  const selectedContacts: MapContact[] = [];

  const toContact = (row: (typeof rows)[number]): MapContact => ({
    id: row.id,
    displayName: row.displayName,
    title: row.title,
    company: row.company,
    location: row.location,
    hasPhoto: row.photoPath !== null,
  });

  for (const row of rows) {
    if (!row.location || row.location.trim() === "") {
      noLocation += 1;
      continue;
    }
    const pinned = row.locationLat !== null && row.locationLng !== null;
    if (pinned) {
      cityRows.push({
        location: row.location,
        lat: row.locationLat as number,
        lng: row.locationLng as number,
        contact: toContact(row),
      });
    }
    const country = resolveCountry(row.location);
    if (country === null) {
      // A geocoded contact is on the map even when the country resolver
      // is stumped — only the doubly-unplaceable land in this list.
      if (!pinned) {
        unrecognizedCounts.set(
          row.location,
          (unrecognizedCounts.get(row.location) ?? 0) + 1
        );
      } else {
        totalPlaced += 1;
      }
      continue;
    }
    counts[country] = (counts[country] ?? 0) + 1;
    // Each person appears once: city pin when geocoded, country bubble
    // otherwise.
    if (!pinned) {
      bubbleCounts[country] = (bubbleCounts[country] ?? 0) + 1;
      bubbleMembers.set(country, [
        ...(bubbleMembers.get(country) ?? []).slice(0, 1),
        toContact(row),
      ]);
    }
    totalPlaced += 1;
    if (selectedCity === null && selectedId !== null && country === selectedId) {
      selectedContacts.push(toContact(row));
    }
  }

  const names = countryNames();
  const cityGroups = groupCityPins(cityRows);
  const selectedCityPin =
    selectedCity !== null
      ? (cityGroups.find((c) => c.key === selectedCity) ?? null)
      : null;
  if (selectedCityPin) {
    // City selection replaces country selection — the contacts are the
    // group's members, whichever exact key each one rounds to.
    selectedContacts.length = 0;
    selectedContacts.push(...selectedCityPin.members.map((m) => m.contact));
  }
  selectedContacts.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return {
    counts,
    bubbleCounts,
    // Members stay server-side except the one case a marker needs a
    // face: a single-person pin renders as that person.
    cities: cityGroups.map((g) => ({
      key: g.key,
      lat: g.lat,
      lng: g.lng,
      label: g.label,
      count: g.count,
      single:
        g.count === 1
          ? {
              id: g.members[0].contact.id,
              displayName: g.members[0].contact.displayName,
              hasPhoto: g.members[0].contact.hasPhoto,
            }
          : null,
    })),
    bubbleSingles: Object.fromEntries(
      [...bubbleMembers.entries()]
        .filter(([id, m]) => m.length === 1 && bubbleCounts[id] === 1)
        .map(([id, m]) => [
          id,
          {
            id: m[0].id,
            displayName: m[0].displayName,
            hasPhoto: m[0].hasPhoto,
          },
        ])
    ),
    geocodeOn: geocodeEnabled(),
    totalPlaced,
    noLocation,
    unrecognized: [...unrecognizedCounts.entries()]
      .map(([location, count]) => ({ location, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12),
    selected: selectedCityPin
      ? {
          id: `city:${selectedCityPin.key}`,
          name: selectedCityPin.label,
          contacts: selectedContacts,
        }
      : selectedId !== null && names.has(selectedId)
        ? {
            id: selectedId,
            name: names.get(selectedId)!,
            contacts: selectedContacts,
          }
        : null,
  };
}
