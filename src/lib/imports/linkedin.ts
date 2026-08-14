import { unzipSync } from "fflate";

import { parseCsv } from "@/lib/imports/csv";

// LinkedIn official data-export ZIP (SPEC §8 "LinkedIn import"). Pure
// parsing only — matching/writes live in the server engine.
// Dependency justification: fflate reads the ZIP container; stdlib zlib
// decompresses deflate streams but has no ZIP directory support.

export type LinkedInConnection = {
  firstName: string;
  lastName: string;
  /** Normalized identity key, e.g. "linkedin.com/in/ana-silva". */
  profileUrl: string | null;
  profileUrlRaw: string | null;
  email: string | null;
  company: string | null;
  position: string | null;
  connectedOn: string | null;
};

export type LinkedInMessage = {
  conversationId: string;
  direction: "inbound" | "outbound";
  /** The other person. */
  counterpartName: string;
  counterpartProfileUrl: string | null;
  occurredAt: number;
};

export type LinkedInArchiveFiles = {
  connections: string | null;
  messages: string | null;
  profile: string | null;
};

/** Case-insensitive basename lookup across the ZIP (files may be nested). */
export function extractArchiveFiles(zip: Uint8Array): LinkedInArchiveFiles {
  const entries = unzipSync(zip);
  const out: LinkedInArchiveFiles = {
    connections: null,
    messages: null,
    profile: null,
  };
  const decoder = new TextDecoder("utf-8");
  for (const [name, data] of Object.entries(entries)) {
    const base = name.split("/").pop()?.toLowerCase();
    if (base === "connections.csv") out.connections = decoder.decode(data);
    else if (base === "messages.csv") out.messages = decoder.decode(data);
    else if (base === "profile.csv") out.profile = decoder.decode(data);
  }
  return out;
}

/**
 * Canonical form of a LinkedIn profile URL — the identity key. Strips
 * protocol/www/query/fragment/trailing slash, lowercases, folds country
 * subdomains (uk.linkedin.com) into linkedin.com, and percent-decodes the
 * path. Every source of profile URLs (ZIP, §9a snapshot, Voyager) must
 * produce byte-identical keys here or the same person imports twice.
 */
export function normalizeLinkedInUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  let s = trimmed.toLowerCase();
  s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
  const cut = s.search(/[?#]/);
  if (cut >= 0) s = s.slice(0, cut);
  s = s.replace(/\/+$/, "");
  // Country/language subdomains address the same profile.
  s = s.replace(/^[a-z]{2,3}(?:-[a-z]{2})?\.linkedin\.com\//, "linkedin.com/");
  if (!s.includes("linkedin.com/")) return null;
  // One canonical byte form for non-ASCII identifiers: percent-decoded.
  try {
    s = decodeURIComponent(s);
  } catch {
    // Malformed escapes: keep the raw form rather than dropping identity.
  }
  return s;
}

/**
 * Connections.csv ships with a "Notes:" preamble above the real header —
 * find the header line and parse from there (SPEC §8: preamble-tolerant).
 */
export function stripConnectionsPreamble(text: string): string {
  const noBom = text.replace(/^﻿/, "");
  const lines = noBom.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) =>
    /^"?first name"?\s*,/i.test(l.trim())
  );
  return headerIdx <= 0 ? noBom : lines.slice(headerIdx).join("\n");
}

function col(headers: string[], name: string): number {
  return headers.findIndex((h) => h.trim().toLowerCase() === name);
}

export function parseConnections(text: string): LinkedInConnection[] {
  const table = parseCsv(stripConnectionsPreamble(text));
  const iFirst = col(table.headers, "first name");
  const iLast = col(table.headers, "last name");
  const iUrl = col(table.headers, "url");
  const iEmail = col(table.headers, "email address");
  const iCompany = col(table.headers, "company");
  const iPosition = col(table.headers, "position");
  const iConnected = col(table.headers, "connected on");
  if (iFirst < 0 && iLast < 0) return [];

  const out: LinkedInConnection[] = [];
  for (const row of table.rows) {
    const get = (i: number) => (i >= 0 ? (row[i] ?? "").trim() : "");
    const firstName = get(iFirst);
    const lastName = get(iLast);
    const rawUrl = get(iUrl);
    if (!firstName && !lastName && !rawUrl) continue;
    out.push({
      firstName,
      lastName,
      profileUrl: rawUrl ? normalizeLinkedInUrl(rawUrl) : null,
      profileUrlRaw: rawUrl || null,
      email: get(iEmail) || null,
      company: get(iCompany) || null,
      position: get(iPosition) || null,
      connectedOn: get(iConnected) || null,
    });
  }
  return out;
}

/** Owner's name from Profile.csv — drives message direction. */
export function parseProfileOwnerName(text: string): string | null {
  const table = parseCsv(text.replace(/^﻿/, ""));
  const iFirst = col(table.headers, "first name");
  const iLast = col(table.headers, "last name");
  const row = table.rows[0];
  if (!row) return null;
  const name = [
    iFirst >= 0 ? row[iFirst]?.trim() : "",
    iLast >= 0 ? row[iLast]?.trim() : "",
  ]
    .filter(Boolean)
    .join(" ");
  return name || null;
}

/** "2024-03-02 10:21:04 UTC" → epoch ms (LinkedIn's messages.csv format). */
export function parseLinkedInDate(s: string): number | null {
  const m = s
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\s*UTC)?$/i);
  if (!m) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

export function parseMessages(
  text: string,
  ownerName: string | null
): LinkedInMessage[] {
  const table = parseCsv(text.replace(/^﻿/, ""));
  const iConvo = col(table.headers, "conversation id");
  const iFrom = col(table.headers, "from");
  const iSenderUrl = col(table.headers, "sender profile url");
  const iTo = col(table.headers, "to");
  const iRecipientUrls = col(table.headers, "recipient profile urls");
  const iDate = col(table.headers, "date");
  if (iConvo < 0 || iFrom < 0 || iDate < 0) return [];

  const owner = ownerName?.trim().toLowerCase() ?? null;
  const out: LinkedInMessage[] = [];
  for (const row of table.rows) {
    const get = (i: number) => (i >= 0 ? (row[i] ?? "").trim() : "");
    const conversationId = get(iConvo);
    const from = get(iFrom);
    const occurredAt = parseLinkedInDate(get(iDate));
    if (!conversationId || !from || occurredAt === null) continue;
    const outbound = owner !== null && from.toLowerCase() === owner;
    // Recipient list is comma- or semicolon-separated when a thread has
    // several people; the counterpart is the first non-owner one.
    const recipientUrl =
      get(iRecipientUrls).split(/[;,]/)[0]?.trim() || "";
    out.push({
      conversationId,
      direction: outbound ? "outbound" : "inbound",
      counterpartName: outbound ? get(iTo) : from,
      counterpartProfileUrl: normalizeLinkedInUrl(
        outbound ? recipientUrl : get(iSenderUrl)
      ),
      occurredAt,
    });
  }
  return out;
}
