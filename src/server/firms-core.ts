import "server-only";

import { eq, isNull } from "drizzle-orm";

import { db } from "@/db/client";
import { contacts, firms } from "@/db/schema";
import { cleanLine, cleanName } from "@/lib/agent/writes";
import { normalizeForCompare } from "@/lib/imports/planner";
import { isDomain, isEmailPattern, isPersonalDomain, type EmailPattern, type FirmFormat } from "@/lib/outreach/email-pattern";

// What Rolo knows about an employer as a firm (SPEC §17): its tier, and
// how its email addresses are formed. There is no companies table — a
// firm is whatever `contacts.company` texts compare equal under the
// import engine's rule, the same folding list_companies uses — so a
// record here is keyed by that comparison form. Shared by the Firms page
// and the agent connector; never export these from a "use server" file.

export type CoreError = { ok: false; error: string };

export const TIER_NAME_MAX = 40;
export const FIRM_NOTE_MAX = 300;

/** The form two spellings of one employer share. Empty for no employer. */
export function firmKey(company: string | null | undefined): string {
  const raw = (company ?? "").replace(/\s+/g, " ").trim();
  return raw ? normalizeForCompare("company", raw) : "";
}

export type Firm = typeof firms.$inferSelect;

export type Employer = { key: string; name: string; contacts: number; spellings: string[] };

/** Every employer among the active contacts, keyed the way firms are. */
export function employers(): Map<string, Employer> {
  const counts = new Map<string, Map<string, number>>();
  for (const row of db.select({ company: contacts.company }).from(contacts).where(isNull(contacts.archivedAt)).all()) {
    const raw = row.company?.replace(/\s+/g, " ").trim();
    const key = firmKey(raw);
    if (!raw || !key) continue;
    const spellings = counts.get(key) ?? new Map<string, number>();
    spellings.set(raw, (spellings.get(raw) ?? 0) + 1);
    counts.set(key, spellings);
  }
  const out = new Map<string, Employer>();
  for (const [key, spellings] of counts) {
    const ordered = [...spellings.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    out.set(key, { key, name: ordered[0][0], contacts: ordered.reduce((n, s) => n + s[1], 0), spellings: ordered.map((s) => s[0]) });
  }
  return out;
}

export function firmByKey(key: string): Firm | null {
  if (!key) return null;
  return db.select().from(firms).where(eq(firms.companyKey, key)).get() ?? null;
}

export function allFirms(): Firm[] {
  return db.select().from(firms).all();
}

/** The format recorded for a firm, when there is a usable one. */
export function formatOf(firm: Firm | null): FirmFormat | null {
  if (!firm || !firm.emailDomain || !isEmailPattern(firm.emailPattern)) return null;
  return {
    domain: firm.emailDomain,
    pattern: firm.emailPattern,
    source: firm.emailSource === "user" ? "user" : "agent",
    basis: firm.emailBasis === "seen_in_mail" ? "seen_in_mail" : firm.emailBasis === "published" ? "published" : null,
    note: firm.emailNote,
  };
}

/**
 * Whether one firm key names part of the other: "goldman sachs" and
 * "goldman sachs international". Whole words only, so "citi" is not
 * "citizens bank".
 */
export function isSameHouse(a: string, b: string): boolean {
  if (!a || !b || a === b) return a === b && a !== "";
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return long.startsWith(`${short} `);
}

export type FirmRow = Firm & { contacts: number };

/** Firms with a record, largest first, each with how many contacts work there now. */
export function listFirms(): FirmRow[] {
  const known = employers();
  return allFirms()
    .filter((f) => f.tier !== null || f.emailDomain !== null)
    .map((f) => ({ ...f, contacts: known.get(f.companyKey)?.contacts ?? 0 }))
    .sort((a, b) => b.contacts - a.contacts || (a.name < b.name ? -1 : 1));
}

/** The tier names in use, most firms first. */
export function tierNames(): { tier: string; firms: number }[] {
  const counts = new Map<string, number>();
  for (const f of allFirms()) if (f.tier) counts.set(f.tier, (counts.get(f.tier) ?? 0) + 1);
  return [...counts.entries()].map(([tier, n]) => ({ tier, firms: n })).sort((a, b) => b.firms - a.firms || (a.tier < b.tier ? -1 : 1));
}

/** Tier by firm key, for decorating lists of people and employers. */
export function tiersByKey(): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of allFirms()) if (f.tier) out.set(f.companyKey, f.tier);
  return out;
}

/**
 * Every spelling of `contacts.company` whose firm has one of these tiers
 * — what a SQL filter needs, since the key is not a column.
 */
export function companySpellingsForTiers(wanted: string[]): string[] {
  const want = new Set(wanted.map((t) => t.trim().toLowerCase()).filter(Boolean));
  if (want.size === 0) return [];
  const keys = new Set(allFirms().filter((f) => f.tier && want.has(f.tier.toLowerCase())).map((f) => f.companyKey));
  if (keys.size === 0) return [];
  const out: string[] = [];
  for (const row of db.selectDistinct({ company: contacts.company }).from(contacts).all()) {
    if (row.company && keys.has(firmKey(row.company))) out.push(row.company);
  }
  return out;
}

function resolveEmployer(company: string): { key: string; name: string } | CoreError {
  const name = cleanName(company, 200);
  const key = firmKey(name);
  if (!key) return { ok: false, error: "A firm needs a name." };
  const known = employers().get(key);
  const existing = firmByKey(key);
  // A firm nobody in Rolo works at would be a row about nothing.
  if (!known && !existing) return { ok: false, error: `Nobody in Rolo works at "${name}". Use the employer's name as list_companies spells it.` };
  return { key, name: existing?.name ?? known?.name ?? name };
}

function ensureFirm(key: string, name: string, now: number): { firm: Firm; created: boolean } {
  const existing = firmByKey(key);
  if (existing) return { firm: existing, created: false };
  const firm = db.insert(firms).values({ companyKey: key, name, createdAt: now, updatedAt: now }).returning().get();
  return { firm, created: true };
}

/** A record that says nothing is not kept. */
function dropIfEmpty(firmId: number): void {
  const f = db.select().from(firms).where(eq(firms.id, firmId)).get();
  if (f && f.tier === null && f.emailDomain === null) db.delete(firms).where(eq(firms.id, firmId)).run();
}

// ---------- tier ----------

export type TierState = { tier: string | null; tierSource: string | null; tierNote: string | null };

export type SetTierResult =
  | { ok: true; key: string; name: string; created: boolean; changed: boolean; before: TierState; after: TierState }
  | { ok: false; error: string; conflict?: boolean };

/**
 * Set or clear a firm's tier. The owner's word stands: an agent may
 * replace a tier an agent set, never one the owner did.
 */
export function setFirmTier(
  input: { company: string; tier: string | null; note?: string | null; source: "user" | "agent" },
  now = Date.now()
): SetTierResult {
  const who = resolveEmployer(input.company);
  if ("ok" in who) return who;
  const tier = input.tier === null ? null : cleanName(input.tier, TIER_NAME_MAX);
  if (input.tier !== null && !tier) return { ok: false, error: `A tier needs a name of at most ${TIER_NAME_MAX} characters.` };
  const note = input.note ? cleanLine(input.note, FIRM_NOTE_MAX) || null : null;
  return db.transaction((): SetTierResult => {
    const { firm, created } = ensureFirm(who.key, who.name, now);
    const before: TierState = { tier: firm.tier, tierSource: firm.tierSource, tierNote: firm.tierNote };
    if (input.source === "agent" && firm.tier !== null && firm.tierSource === "user") {
      if (created) dropIfEmpty(firm.id);
      return { ok: false, conflict: true, error: `You set ${firm.name}'s tier to "${firm.tier}" yourself, so it was kept.` };
    }
    // The spelling in use wins over a new one that differs only in case.
    const inUse = tier ? tierNames().find((t) => t.tier.toLowerCase() === tier.toLowerCase())?.tier ?? tier : null;
    const after: TierState = { tier: inUse, tierSource: inUse === null ? null : input.source, tierNote: inUse === null ? null : note };
    const changed = before.tier !== after.tier || before.tierSource !== after.tierSource || before.tierNote !== after.tierNote;
    if (changed) db.update(firms).set({ ...after, updatedAt: now }).where(eq(firms.id, firm.id)).run();
    dropIfEmpty(firm.id);
    return { ok: true, key: who.key, name: firm.name, created, changed, before, after };
  });
}

/** Put a tier back as an agent's write found it — only while the row still holds what that write set. */
export function restoreFirmTier(key: string, before: TierState, after: TierState, now = Date.now()): { ok: true } | CoreError {
  const firm = firmByKey(key);
  if (!firm) return { ok: false, error: "the firm's record is gone" };
  if (firm.tier !== after.tier || firm.tierSource !== after.tierSource) return { ok: false, error: `${firm.name}'s tier has been changed since, so it was left` };
  db.update(firms).set({ ...before, updatedAt: now }).where(eq(firms.id, firm.id)).run();
  dropIfEmpty(firm.id);
  return { ok: true };
}

// ---------- email format ----------

export type FormatState = {
  emailDomain: string | null;
  emailPattern: string | null;
  emailSource: string | null;
  emailBasis: string | null;
  emailNote: string | null;
};

const NO_FORMAT: FormatState = { emailDomain: null, emailPattern: null, emailSource: null, emailBasis: null, emailNote: null };

export type SetFormatResult =
  | { ok: true; key: string; name: string; created: boolean; changed: boolean; before: FormatState; after: FormatState }
  | { ok: false; error: string; conflict?: boolean };

/** Record how a firm forms its addresses, or (domain null) forget it. */
export function setFirmEmailFormat(
  input: {
    company: string;
    domain: string | null;
    pattern?: EmailPattern | null;
    basis?: "seen_in_mail" | "published" | null;
    note?: string | null;
    source: "user" | "agent";
  },
  now = Date.now()
): SetFormatResult {
  const who = resolveEmployer(input.company);
  if ("ok" in who) return who;
  let after: FormatState = NO_FORMAT;
  if (input.domain !== null) {
    const domain = input.domain.trim().toLowerCase().replace(/^@/, "");
    if (!isDomain(domain)) return { ok: false, error: `"${cleanLine(input.domain, 80)}" is not a domain. Give what comes after the @, like "gs.com".` };
    if (isPersonalDomain(domain)) return { ok: false, error: `${domain} is a mailbox provider or a school, not a firm's own domain.` };
    if (!isEmailPattern(input.pattern)) return { ok: false, error: "Choose how the part before the @ is built." };
    after = {
      emailDomain: domain,
      emailPattern: input.pattern,
      emailSource: input.source,
      emailBasis: input.source === "agent" ? (input.basis ?? "published") : null,
      emailNote: input.note ? cleanLine(input.note, FIRM_NOTE_MAX) || null : null,
    };
  }
  return db.transaction((): SetFormatResult => {
    const { firm, created } = ensureFirm(who.key, who.name, now);
    const before: FormatState = {
      emailDomain: firm.emailDomain,
      emailPattern: firm.emailPattern,
      emailSource: firm.emailSource,
      emailBasis: firm.emailBasis,
      emailNote: firm.emailNote,
    };
    if (input.source === "agent" && firm.emailDomain !== null && firm.emailSource === "user") {
      if (created) dropIfEmpty(firm.id);
      return { ok: false, conflict: true, error: `You set ${firm.name}'s address format yourself (${firm.emailPattern}@${firm.emailDomain}), so it was kept.` };
    }
    const changed = (Object.keys(after) as (keyof FormatState)[]).some((k) => before[k] !== after[k]);
    if (changed) db.update(firms).set({ ...after, updatedAt: now }).where(eq(firms.id, firm.id)).run();
    dropIfEmpty(firm.id);
    return { ok: true, key: who.key, name: firm.name, created, changed, before, after };
  });
}

export function restoreFirmEmailFormat(key: string, before: FormatState, after: FormatState, now = Date.now()): { ok: true } | CoreError {
  const firm = firmByKey(key);
  if (!firm) return { ok: false, error: "the firm's record is gone" };
  if (firm.emailDomain !== after.emailDomain || firm.emailPattern !== after.emailPattern || firm.emailSource !== after.emailSource) {
    return { ok: false, error: `${firm.name}'s address format has been changed since, so it was left` };
  }
  db.update(firms).set({ ...before, updatedAt: now }).where(eq(firms.id, firm.id)).run();
  dropIfEmpty(firm.id);
  return { ok: true };
}
