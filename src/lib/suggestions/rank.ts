// "People you met" (SPEC §9f): who, among the addresses the Gmail and
// Calendar syncs keep bumping into, is worth a contact. Pure — the sync
// engines feed sightings in, the queue reads rows back through this.
//
// SPEC §9's "never auto-creates contacts" stands. This ranks; the owner
// clicks. What it filters out is the machinery of email — noreply
// senders, notification addresses, calendar resources — because a queue
// that opens with "notifications@github.com" is a queue nobody reads.

export type SightingKind = "email" | "meeting";

export type Sighting = {
  kind: SightingKind;
  /** Idempotency key for the backfill: gmail message id or event key. */
  key: string;
  occurredAt: number;
  title: string | null;
  direction: "inbound" | "outbound" | null;
};

export type SightingInput = Sighting & { email: string; name: string | null };

/** How many sightings a suggestion remembers — enough to backfill a
 * relationship's recent history on approval, not its archive. */
export const SUGGESTION_RECENT_MAX = 50;

const MACHINE_LOCAL = new Set([
  "noreply", "no-reply", "no_reply", "donotreply", "do-not-reply", "do_not_reply",
  "notification", "notifications", "notify", "mailer", "mailer-daemon", "postmaster",
  "bounce", "bounces", "newsletter", "newsletters", "news", "digest", "updates", "update",
  "alert", "alerts", "info", "support", "help", "hello", "hi", "team", "contact",
  "billing", "invoice", "invoices", "receipt", "receipts", "orders", "order",
  "calendar", "calendar-notification", "admin", "administrator", "marketing", "sales",
  "jobs", "careers", "recruiting", "security", "account", "accounts", "service",
  "services", "robot", "bot", "automated", "system", "system-messages", "reply",
  "feedback", "survey", "surveys", "welcome", "community", "events", "press",
  "customerservice", "customer-service", "customer.service", "membership", "privacy",
]);

const MACHINE_DOMAIN_SUFFIXES = [
  "calendar.google.com",
  "docs.google.com",
  "drive-shares-noreply.google.com",
  "linkedin.com",
  "facebookmail.com",
  "slack.com",
  "zoom.us",
  "intercom-mail.com",
  "hubspot.com",
  "mailchimp.com",
  "sendgrid.net",
  "amazonses.com",
  "substack.com",
  "medium.com",
  "notion.so",
  "atlassian.net",
  "github.com",
];

/** Reject the addresses that are never a person. Conservative: a real
 * name at an odd domain still passes; the point is to keep the obvious
 * machinery out, not to be right about every edge. */
export function isLikelyPerson(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at <= 0) return false;
  const local = email.slice(0, at).toLowerCase();
  const domain = email.slice(at + 1).toLowerCase();
  if (MACHINE_LOCAL.has(local)) return false;
  if (/^(no-?reply|do-?not-?reply|notifications?|reply|bounce|mailer)[-+._]/.test(local)) return false;
  if (/(noreply|no-reply|donotreply)$/.test(local)) return false;
  // Long opaque tokens: reply-tracking and bounce addresses.
  if (/^[a-z0-9]{24,}$/.test(local) || /[-+.=][a-f0-9]{16,}/.test(local)) return false;
  if (MACHINE_DOMAIN_SUFFIXES.some((d) => domain === d || domain.endsWith(`.${d}`))) return false;
  return true;
}

/** "Ana Silva" / "Silva, Ana" / '"Silva, Ana"' → parts. Email-shaped
 * locals like ana.silva become a name; opaque ones stay null. */
export function splitName(
  name: string | null,
  email: string
): { firstName: string | null; lastName: string | null } {
  let n = (name ?? "").replace(/^"+|"+$/g, "").replace(/\s+/g, " ").trim();
  // A "name" that is just the address again tells us nothing.
  if (n.includes("@")) n = "";
  if (n) {
    const comma = n.indexOf(",");
    if (comma > 0) {
      return { firstName: n.slice(comma + 1).trim() || null, lastName: n.slice(0, comma).trim() || null };
    }
    const space = n.indexOf(" ");
    if (space === -1) return { firstName: n, lastName: null };
    return { firstName: n.slice(0, space), lastName: n.slice(space + 1).trim() || null };
  }
  const local = email.slice(0, email.lastIndexOf("@"));
  const m = local.match(/^([a-z]{2,})[._-]([a-z]{2,})$/i);
  if (m) {
    const cap = (s: string) => s[0].toUpperCase() + s.slice(1).toLowerCase();
    return { firstName: cap(m[1]), lastName: cap(m[2]) };
  }
  return { firstName: null, lastName: null };
}

/** Newest first, deduped on key, bounded. */
export function mergeRecent(existing: Sighting[], incoming: Sighting[]): Sighting[] {
  const byKey = new Map<string, Sighting>();
  for (const s of [...incoming, ...existing]) {
    if (!byKey.has(s.key)) byKey.set(s.key, s);
  }
  return [...byKey.values()]
    .sort((a, b) => b.occurredAt - a.occurredAt)
    .slice(0, SUGGESTION_RECENT_MAX);
}

export type SuggestionCounts = {
  outboundCount: number;
  inboundCount: number;
  meetingCount: number;
  lastSeenAt: number;
};

/** A meeting is the strongest signal; you writing to them next; them
 * writing to you needs repetition before it means anything. */
export function qualifies(r: SuggestionCounts): boolean {
  return r.meetingCount >= 1 || r.outboundCount >= 1 || r.inboundCount >= 3;
}

export function suggestionScore(r: SuggestionCounts, now: number): number {
  const recent = now - r.lastSeenAt < 30 * 24 * 3600 * 1000 ? 2 : 0;
  return r.meetingCount * 6 + r.outboundCount * 3 + r.inboundCount + recent;
}

/** Best first; stable by lastSeen then id for ties. */
export function rankSuggestions<T extends SuggestionCounts & { id: number }>(
  rows: T[],
  now: number
): T[] {
  return rows
    .filter(qualifies)
    .map((r) => ({ r, s: suggestionScore(r, now) }))
    .sort((a, b) => b.s - a.s || b.r.lastSeenAt - a.r.lastSeenAt || a.r.id - b.r.id)
    .map((x) => x.r);
}

/** "3 emails · met twice · seen 4d ago" — the row's one-line case. */
export function describeCounts(r: SuggestionCounts): string {
  const parts: string[] = [];
  const emails = r.outboundCount + r.inboundCount;
  if (emails > 0) {
    parts.push(
      r.outboundCount > 0 && r.inboundCount > 0
        ? `${emails} emails both ways`
        : r.outboundCount > 0
          ? `you emailed ${r.outboundCount === 1 ? "once" : `${r.outboundCount}×`}`
          : `${r.inboundCount} emails from them`
    );
  }
  if (r.meetingCount > 0) parts.push(`met ${r.meetingCount === 1 ? "once" : r.meetingCount === 2 ? "twice" : `${r.meetingCount}×`}`);
  return parts.join(" · ");
}
