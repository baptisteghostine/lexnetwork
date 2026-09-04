// What the extension reads off a LinkedIn page the owner is already
// looking at (SPEC §9c, owner request 2026-09-04): a profile, and — in
// the messaging view — a conversation. Pure: validation and mapping into
// the same rows the ZIP and the connection sync produce, so identity,
// provenance, and job-change detection are shared. Zero extra LinkedIn
// requests: the page was loaded by the owner, for the owner.

import { z } from "zod";

import {
  messageSnippet,
  normalizeLinkedInUrl,
  type LinkedInConnection,
  type LinkedInMessage,
} from "@/lib/imports/linkedin";
import { publicIdentifierFromUrl } from "@/lib/linkedin/enrich";
import { linkedInUrlFromIdentifier, splitHeadline } from "@/lib/linkedin/voyager";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v ? v : null));

export const capturedProfileSchema = z.object({
  publicIdentifier: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .transform((s) => s.toLowerCase()),
  firstName: optionalText(200),
  lastName: optionalText(200),
  /** The page's h1 when the structured name isn't available. */
  fullName: optionalText(400),
  headline: optionalText(500),
  location: optionalText(200),
});

export type CapturedProfile = z.infer<typeof capturedProfileSchema>;

export function parseCapturedProfile(raw: unknown): CapturedProfile | null {
  const parsed = capturedProfileSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** "/in/ana-silva-123/" (or a full URL) → "ana-silva-123". */
export function publicIdentifierFromPath(urlOrPath: string): string | null {
  const path = urlOrPath.startsWith("/") ? `https://www.linkedin.com${urlOrPath}` : urlOrPath;
  const normalized = normalizeLinkedInUrl(path);
  return normalized ? publicIdentifierFromUrl(normalized) : null;
}

/** A name is the one thing a contact can't do without. */
export function capturedName(p: CapturedProfile): { firstName: string; lastName: string } | null {
  if (p.firstName || p.lastName) {
    return { firstName: p.firstName ?? "", lastName: p.lastName ?? "" };
  }
  const full = (p.fullName ?? "").replace(/\s+/g, " ").trim();
  if (!full) return null;
  const space = full.indexOf(" ");
  return space === -1
    ? { firstName: full, lastName: "" }
    : { firstName: full.slice(0, space), lastName: full.slice(space + 1) };
}

/** Same shape voyagerToConnection makes — one identity ladder for all. */
export function capturedProfileToConnection(p: CapturedProfile): LinkedInConnection | null {
  const name = capturedName(p);
  if (!name) return null;
  const { title, company } = splitHeadline(p.headline);
  const profileUrlRaw = linkedInUrlFromIdentifier(p.publicIdentifier);
  return {
    firstName: name.firstName,
    lastName: name.lastName,
    profileUrl: normalizeLinkedInUrl(profileUrlRaw),
    profileUrlRaw,
    email: null,
    company,
    position: title,
    location: p.location,
    connectedOn: null,
  };
}

// ---------- conversations (messaging view) ----------

export const capturedConversationSchema = z.object({
  /** LinkedIn's thread id from the URL; the idempotency root for messages. */
  conversationId: z.string().trim().min(1).max(200),
  counterpartName: z.string().trim().min(1).max(400),
  counterpartProfileUrl: optionalText(500),
  counterpartPublicIdentifier: optionalText(200),
  messages: z
    .array(
      z.object({
        direction: z.enum(["inbound", "outbound"]),
        occurredAt: z.number().int().positive(),
        text: z.string().max(4000).nullable().optional(),
      })
    )
    .min(1)
    .max(500),
});

export type CapturedConversation = z.infer<typeof capturedConversationSchema>;

export function parseCapturedConversation(raw: unknown): CapturedConversation | null {
  const parsed = capturedConversationSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Into the ZIP's message rows: snippet-bounded (MESSAGE_SNIPPET_MAX), keyed
 * by conversation + timestamp exactly like messages.csv, so a later ZIP
 * import of the same thread lands on the same interaction rows.
 */
export function capturedConversationToMessages(c: CapturedConversation): LinkedInMessage[] {
  const url =
    c.counterpartProfileUrl ??
    (c.counterpartPublicIdentifier ? linkedInUrlFromIdentifier(c.counterpartPublicIdentifier) : null);
  const profileUrl = url ? normalizeLinkedInUrl(url) : null;
  const seen = new Set<number>();
  const out: LinkedInMessage[] = [];
  for (const m of c.messages) {
    // Two messages in the same millisecond can't both be keyed; keep the first.
    if (seen.has(m.occurredAt)) continue;
    seen.add(m.occurredAt);
    out.push({
      conversationId: c.conversationId,
      direction: m.direction,
      counterpartName: c.counterpartName,
      counterpartProfileUrl: profileUrl,
      occurredAt: m.occurredAt,
      snippet: m.text ? messageSnippet(m.text) : null,
    });
  }
  return out.sort((a, b) => a.occurredAt - b.occurredAt);
}
