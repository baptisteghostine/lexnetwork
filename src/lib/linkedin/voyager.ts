// Parsing for LinkedIn's Voyager connections responses. Pure — no network.
//
// This reads an undocumented internal API, so the response shape is expected to
// drift. The parser is therefore structural rather than positional: it looks for
// objects that *look like* profiles anywhere in the payload instead of walking a
// fixed path that a rename would break. Callers treat an empty result as an
// error (see server/sync/voyager.ts) — a shape change must fail loudly, never
// look like "you have no connections".

import type { LinkedInConnection } from "@/lib/imports/linkedin";
import { normalizeLinkedInUrl } from "@/lib/imports/linkedin";

export type VoyagerConnection = {
  publicIdentifier: string;
  firstName: string | null;
  lastName: string | null;
  headline: string | null;
  /** Unix ms; null when the payload didn't pair a date with this profile. */
  connectedAt: number | null;
};

export type ConnectionsPage = {
  connections: VoyagerConnection[];
  /** Total connections reported by paging, when present. */
  total: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Profiles are identified by duck-typing: a `publicIdentifier` plus at least one
 * name part. Company and school entities in the same `included` array have
 * neither, so they fall out naturally.
 */
function asProfile(value: unknown): VoyagerConnection | null {
  if (!isRecord(value)) return null;
  const publicIdentifier = str(value.publicIdentifier);
  if (publicIdentifier === null) return null;

  const firstName = str(value.firstName);
  const lastName = str(value.lastName);
  if (firstName === null && lastName === null) return null;

  return {
    publicIdentifier: publicIdentifier.toLowerCase(),
    firstName,
    lastName,
    headline: str(value.headline) ?? str(value.occupation),
    connectedAt: null,
  };
}

/** Every `entityUrn` this object is reachable by, so connection dates can be paired up. */
function urnsOf(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const urns: string[] = [];
  for (const key of ["entityUrn", "*entityUrn", "objectUrn", "dashEntityUrn"]) {
    const urn = str(value[key]);
    if (urn !== null) urns.push(urn);
  }
  return urns;
}

/** Recursively collect every record in the payload — shape drift resistant. */
function walk(value: unknown, out: unknown[], depth = 0): void {
  if (depth > 8) return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, out, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  out.push(value);
  for (const item of Object.values(value)) walk(item, out, depth + 1);
}

/**
 * Connection elements carry `createdAt` and point at a profile by URN. Pairing
 * them is best-effort: a missed date costs a `connected_on` value, not a contact.
 */
function collectConnectionDates(records: unknown[]): Map<string, number> {
  const dates = new Map<string, number>();
  for (const record of records) {
    if (!isRecord(record)) continue;
    const createdAt = num(record.createdAt) ?? num(record.connectedAt);
    if (createdAt === null) continue;
    for (const key of [
      "*connectedMemberResolutionResult",
      "connectedMemberResolutionResult",
      "*miniProfile",
      "miniProfile",
      "*profile",
      "profile",
    ]) {
      const ref = record[key];
      const urn = typeof ref === "string" ? ref : null;
      if (urn !== null) dates.set(urn, createdAt);
    }
  }
  return dates;
}

export function parseConnectionsResponse(payload: unknown): ConnectionsPage {
  const records: unknown[] = [];
  walk(payload, records);

  const dates = collectConnectionDates(records);

  // Dedupe by public identifier: normalized payloads repeat the same profile
  // under both `included` and inline element references.
  const byIdentifier = new Map<string, VoyagerConnection>();
  for (const record of records) {
    const profile = asProfile(record);
    if (profile === null) continue;

    const connectedAt =
      urnsOf(record)
        .map((urn) => dates.get(urn))
        .find((d): d is number => d !== undefined) ?? null;

    const existing = byIdentifier.get(profile.publicIdentifier);
    if (existing) {
      // Merge: later copies of the same profile often carry fields the first lacked.
      existing.firstName ??= profile.firstName;
      existing.lastName ??= profile.lastName;
      existing.headline ??= profile.headline;
      existing.connectedAt ??= connectedAt;
      continue;
    }
    byIdentifier.set(profile.publicIdentifier, { ...profile, connectedAt });
  }

  let total: number | null = null;
  for (const record of records) {
    if (!isRecord(record)) continue;
    const paging = record.paging;
    if (isRecord(paging)) {
      total = num(paging.total) ?? total;
    }
  }

  return { connections: [...byIdentifier.values()], total };
}

/**
 * Splits "Senior Engineer at Acme" into title + company. Deliberately
 * conservative — a headline is freeform text, and a wrong split writes a wrong
 * company onto a contact. Only the unambiguous separators are honoured; anything
 * else stays whole as the title.
 */
export function splitHeadline(headline: string | null): {
  title: string | null;
  company: string | null;
} {
  if (headline === null) return { title: null, company: null };
  const trimmed = headline.trim();
  if (!trimmed) return { title: null, company: null };

  // Last separator wins: "VP at Foo at Bar" means the company is Bar.
  const match = [...trimmed.matchAll(/\s+(?:at|@)\s+/gi)].pop();
  if (!match || match.index === undefined) {
    return { title: trimmed, company: null };
  }
  const title = trimmed.slice(0, match.index).trim();
  const company = trimmed.slice(match.index + match[0].length).trim();
  if (!title || !company) return { title: trimmed, company: null };
  return { title, company };
}

/** Canonical URL form for a public identifier: what the profile-URL identity rung matches on. */
export function linkedInUrlFromIdentifier(publicIdentifier: string): string {
  return `https://www.linkedin.com/in/${encodeURIComponent(
    publicIdentifier.toLowerCase()
  )}`;
}

/**
 * Bridge into the Phase 7 import core: a Voyager connection becomes the same
 * `LinkedInConnection` row the ZIP's Connections.csv and the §9a snapshot
 * produce, so identity, provenance, and job-change detection are shared.
 * Voyager rows carry no email or phone — profile-URL matching is what keeps
 * every weekly sync from re-creating the same people.
 */
export function voyagerToConnection(
  connection: VoyagerConnection
): LinkedInConnection {
  const { title, company } = splitHeadline(connection.headline);
  const profileUrlRaw = linkedInUrlFromIdentifier(connection.publicIdentifier);
  return {
    firstName: connection.firstName ?? "",
    lastName: connection.lastName ?? "",
    profileUrl: normalizeLinkedInUrl(profileUrlRaw),
    profileUrlRaw,
    email: null,
    company,
    position: title,
    connectedOn:
      connection.connectedAt === null
        ? null
        : new Date(connection.connectedAt).toISOString().slice(0, 10),
  };
}
