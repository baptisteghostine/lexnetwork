import "server-only";

import { and, desc, eq, gte, inArray, isNotNull, ne } from "drizzle-orm";

import { db } from "@/db/client";
import { contactEmails, contacts, emailGuesses, interactions } from "@/db/schema";
import { normalizeSubject } from "@/lib/agent/writes";
import { recomputeContact } from "@/lib/cadence/recompute";
import { normalizeEmail } from "@/lib/contacts/normalize";
import {
  bounceKey,
  learnPatterns,
  splitAddress,
  suggestEmails,
  type DomainEvidence,
  type EmailCandidate,
  type FirmFormat,
  type Observation,
} from "@/lib/outreach/email-pattern";
import { BAD_ADDRESS_TAG } from "@/lib/outreach/stage";
import { allFirms, firmKey, formatOf, isSameHouse } from "@/server/firms-core";
import { findOrCreateTag, setTagMembership } from "@/server/membership-core";

// Addresses Rolo works out rather than is given (SPEC §17). A suggestion
// is computed each time it is shown and stored nowhere. It becomes an
// address on a contact only by the owner's click — never by an agent —
// and from then on it is an ordinary address that Rolo remembers was a
// guess, until the person answers from it or it bounces.
// Shared by the pages and the agent connector; never export these from a
// "use server" file.

export type CoreError = { ok: false; error: string };

const DAY_MS = 24 * 60 * 60 * 1000;
/** How far back a bounce may reach for the email it is about. */
export const BOUNCE_WINDOW_MS = 21 * DAY_MS;

export type Suggestion = {
  contactId: number;
  /** Addresses the contact already has. */
  emails: number;
  candidates: EmailCandidate[];
  /** Why there is nothing to offer, when there is nothing. */
  reason: string | null;
};

type Evidence = {
  /** A firm key as somebody spells it, for saying whose evidence was borrowed. */
  names: Map<string, string>;
  learned: Map<string, DomainEvidence[]>;
  formats: Map<string, { name: string; format: FirmFormat }>;
  bounces: { contactId: number; domain: string; pattern: string }[];
};

function gatherEvidence(): Evidence {
  // An address that is itself an unproven guess is evidence of nothing.
  const unproven = new Set(
    db
      .select({ contactId: emailGuesses.contactId, email: emailGuesses.emailNormalized })
      .from(emailGuesses)
      .where(eq(emailGuesses.status, "accepted"))
      .all()
      .map((g) => `${g.contactId}|${g.email}`)
  );
  const observations: Observation[] = [];
  const names = new Map<string, string>();
  for (const row of db
    .select({ contactId: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName, company: contacts.company, email: contactEmails.emailNormalized })
    .from(contactEmails)
    .innerJoin(contacts, eq(contacts.id, contactEmails.contactId))
    .where(isNotNull(contacts.company))
    .all()) {
    if (unproven.has(`${row.contactId}|${row.email}`)) continue;
    const key = firmKey(row.company);
    if (key && row.company && !names.has(key)) names.set(key, row.company.replace(/\s+/g, " ").trim());
    observations.push({ firmKey: key, firstName: row.firstName, lastName: row.lastName, email: row.email });
  }
  const formats = new Map<string, { name: string; format: FirmFormat }>();
  for (const firm of allFirms()) {
    const format = formatOf(firm);
    if (format) formats.set(firm.companyKey, { name: firm.name, format });
  }
  const bounces = db
    .select({ contactId: emailGuesses.contactId, domain: emailGuesses.domain, pattern: emailGuesses.pattern })
    .from(emailGuesses)
    .where(eq(emailGuesses.status, "bounced"))
    .all();
  return { names, learned: learnPatterns(observations), formats, bounces };
}

/** The firm's own evidence, or that of the firm it is part of. */
function evidenceFor(key: string, evidence: Evidence): { learned: DomainEvidence[]; stated: FirmFormat | null; from: string | null } {
  const own = { learned: evidence.learned.get(key) ?? [], stated: evidence.formats.get(key)?.format ?? null };
  if (own.learned.length > 0 || own.stated) return { ...own, from: null };
  // "Goldman Sachs International" borrows from "Goldman Sachs": the closest relative with anything to say.
  const relatives = [...new Set([...evidence.learned.keys(), ...evidence.formats.keys()])]
    .filter((other) => isSameHouse(key, other))
    .sort((a, b) => Math.abs(a.length - key.length) - Math.abs(b.length - key.length) || (a < b ? -1 : 1));
  const relative = relatives[0];
  if (!relative) return { ...own, from: null };
  return {
    learned: evidence.learned.get(relative) ?? [],
    stated: evidence.formats.get(relative)?.format ?? null,
    from: evidence.formats.get(relative)?.name ?? evidence.names.get(relative) ?? relative,
  };
}

/**
 * What Rolo can suggest for each of these people. Someone who already
 * has an address still gets an answer — the caller decides whether to
 * show it — but never an address they, or anyone else, already hold.
 */
export function suggestionsFor(contactIds: number[]): Map<number, Suggestion> {
  const out = new Map<number, Suggestion>();
  const ids = [...new Set(contactIds)].filter((id) => Number.isInteger(id) && id > 0);
  if (ids.length === 0) return out;
  const people = db
    .select({ id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName, company: contacts.company })
    .from(contacts)
    .where(inArray(contacts.id, ids))
    .all();
  const evidence = gatherEvidence();
  const own = new Map<number, Set<string>>();
  for (const e of db.select({ contactId: contactEmails.contactId, email: contactEmails.emailNormalized }).from(contactEmails).where(inArray(contactEmails.contactId, ids)).all()) {
    own.set(e.contactId, (own.get(e.contactId) ?? new Set()).add(e.email));
  }
  const refused = new Map<number, Set<string>>();
  for (const g of db
    .select({ contactId: emailGuesses.contactId, email: emailGuesses.emailNormalized })
    .from(emailGuesses)
    .where(and(inArray(emailGuesses.contactId, ids), inArray(emailGuesses.status, ["bounced", "dismissed"])))
    .all()) {
    refused.set(g.contactId, (refused.get(g.contactId) ?? new Set()).add(g.email));
  }

  for (const p of people) {
    const emails = own.get(p.id)?.size ?? 0;
    const key = firmKey(p.company);
    if (!key) {
      out.set(p.id, { contactId: p.id, emails, candidates: [], reason: "Rolo does not know where this person works." });
      continue;
    }
    const { learned, stated, from } = evidenceFor(key, evidence);
    const bounces = new Map<string, number>();
    for (const b of evidence.bounces) {
      if (b.contactId === p.id) continue;
      const k = bounceKey(b.domain, b.pattern);
      bounces.set(k, (bounces.get(k) ?? 0) + 1);
    }
    const excluded = new Set<string>([...(own.get(p.id) ?? []), ...(refused.get(p.id) ?? [])]);
    let result = suggestEmails({ firstName: p.firstName, lastName: p.lastName, firmName: p.company, learned, stated, evidenceFirm: from, excluded, bounces });
    // An address somebody else in Rolo holds is theirs, not a guess for this person.
    for (let pass = 0; pass < 3 && result.candidates.length > 0; pass++) {
      const taken = db
        .select({ email: contactEmails.emailNormalized })
        .from(contactEmails)
        .where(and(inArray(contactEmails.emailNormalized, result.candidates.map((c) => normalizeEmail(c.email))), ne(contactEmails.contactId, p.id)))
        .all();
      if (taken.length === 0) break;
      for (const t of taken) excluded.add(t.email);
      for (const c of result.candidates) if (taken.some((t) => t.email === normalizeEmail(c.email))) excluded.add(c.email);
      result = suggestEmails({ firstName: p.firstName, lastName: p.lastName, firmName: p.company, learned, stated, evidenceFirm: from, excluded, bounces });
    }
    // For someone who has an address, "nothing left to try" usually means the format gives the one they have.
    const reason = result.candidates.length === 0 && emails > 0 && learned.length + (stated ? 1 : 0) > 0 ? "Rolo already holds the address its formats give for this person." : result.reason;
    out.set(p.id, { contactId: p.id, emails, candidates: result.candidates, reason });
  }
  return out;
}

export function suggestionFor(contactId: number): Suggestion | null {
  return suggestionsFor([contactId]).get(contactId) ?? null;
}

/** The first suggestion for each person who has no address at all. */
export function topGuessForAddressless(contactIds: number[]): Map<number, EmailCandidate> {
  const out = new Map<number, EmailCandidate>();
  for (const s of suggestionsFor(contactIds).values()) {
    if (s.emails === 0 && s.candidates.length > 0) out.set(s.contactId, s.candidates[0]);
  }
  return out;
}

// ---------- the owner's answer ----------

function guessRow(contactId: number, emailNormalized: string) {
  return db
    .select()
    .from(emailGuesses)
    .where(and(eq(emailGuesses.contactId, contactId), eq(emailGuesses.emailNormalized, emailNormalized)))
    .get();
}

function setGuess(contactId: number, candidate: { email: string; domain: string; pattern: string }, status: string, now: number): void {
  const emailNormalized = normalizeEmail(candidate.email);
  db.insert(emailGuesses)
    .values({ contactId, emailNormalized, domain: candidate.domain, pattern: candidate.pattern, status, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: [emailGuesses.contactId, emailGuesses.emailNormalized], set: { status, updatedAt: now } })
    .run();
}

/**
 * Put a suggested address on the contact. Only an address Rolo is
 * suggesting for this person right now is accepted here — this is not a
 * way to type one in.
 */
export function acceptGuess(contactId: number, email: string, now = Date.now()): { ok: true; email: string } | CoreError {
  const wanted = normalizeEmail(String(email ?? ""));
  return db.transaction((): { ok: true; email: string } | CoreError => {
    const suggestion = suggestionFor(contactId);
    if (!suggestion) return { ok: false, error: "That contact no longer exists." };
    const candidate = suggestion.candidates.find((c) => normalizeEmail(c.email) === wanted);
    if (!candidate) return { ok: false, error: "Rolo is no longer suggesting that address for this person." };
    db.insert(contactEmails)
      .values({ contactId, email: candidate.email, emailNormalized: wanted, label: null, priority: suggestion.emails, source: "guess", createdAt: now })
      .run();
    setGuess(contactId, candidate, "accepted", now);
    db.update(contacts).set({ updatedAt: now }).where(eq(contacts.id, contactId)).run();
    return { ok: true, email: candidate.email };
  });
}

/** "Not this one": it is not offered for this person again. */
export function dismissGuess(contactId: number, email: string, now = Date.now()): { ok: true } | CoreError {
  const wanted = normalizeEmail(String(email ?? ""));
  const suggestion = suggestionFor(contactId);
  const candidate = suggestion?.candidates.find((c) => normalizeEmail(c.email) === wanted);
  if (!candidate) return { ok: false, error: "Rolo is no longer suggesting that address for this person." };
  setGuess(contactId, candidate, "dismissed", now);
  return { ok: true };
}

export type GuessState = "accepted" | "confirmed";

/** Which of a contact's addresses began as guesses, and whether they have been proven. */
export function guessStates(contactId: number): Map<string, GuessState> {
  const out = new Map<string, GuessState>();
  for (const g of db
    .select({ email: emailGuesses.emailNormalized, status: emailGuesses.status })
    .from(emailGuesses)
    .where(and(eq(emailGuesses.contactId, contactId), inArray(emailGuesses.status, ["accepted", "confirmed"])))
    .all()) {
    out.set(g.email, g.status === "confirmed" ? "confirmed" : "accepted");
  }
  return out;
}

export type ConfirmResult = { ok: true; changed: boolean; wasGuess: boolean; previous: string | null } | CoreError;

/**
 * The address works — the person answered from it. From now on it counts
 * as evidence for the firm's format like any address Rolo was given.
 */
export function confirmGuess(contactId: number, email: string, now = Date.now()): ConfirmResult {
  const wanted = normalizeEmail(String(email ?? ""));
  const held = db.select({ id: contactEmails.id }).from(contactEmails).where(and(eq(contactEmails.contactId, contactId), eq(contactEmails.emailNormalized, wanted))).get();
  if (!held) return { ok: false, error: "That address is not on this contact." };
  const guess = guessRow(contactId, wanted);
  if (!guess) return { ok: true, changed: false, wasGuess: false, previous: null };
  if (guess.status === "confirmed") return { ok: true, changed: false, wasGuess: true, previous: "confirmed" };
  db.update(emailGuesses).set({ status: "confirmed", updatedAt: now }).where(eq(emailGuesses.id, guess.id)).run();
  return { ok: true, changed: true, wasGuess: true, previous: guess.status };
}

/** Take a confirmation back, while it is still one. */
export function unconfirmGuess(contactId: number, email: string, previous: string, now = Date.now()): { ok: true } | CoreError {
  const guess = guessRow(contactId, normalizeEmail(email));
  if (!guess || guess.status !== "confirmed") return { ok: false, error: "the address is no longer marked as confirmed" };
  db.update(emailGuesses).set({ status: previous, updatedAt: now }).where(eq(emailGuesses.id, guess.id)).run();
  return { ok: true };
}

// ---------- a bounce ----------

/** Whether a timeline row is an email that never arrived. */
export function isBouncedMeta(meta: string | null): boolean {
  if (!meta || !meta.includes('"bounced"')) return false;
  try {
    return (JSON.parse(meta) as { bounced?: unknown }).bounced === true;
  } catch {
    return false;
  }
}

function withBounced(meta: string | null, bounced: boolean): string | null {
  let parsed: Record<string, unknown> = {};
  if (meta) {
    try {
      const value: unknown = JSON.parse(meta);
      if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
    } catch {
      // Unreadable metadata is replaced rather than guessed at.
    }
  }
  if (bounced) parsed.bounced = true;
  else delete parsed.bounced;
  return Object.keys(parsed).length > 0 ? JSON.stringify(parsed) : null;
}

export type BounceRecord = {
  contactId: number;
  email: string;
  /** The guessed address taken off the contact, as it was. */
  retracted: { email: string; label: string | null; priority: number; source: string; createdAt: number; guessStatus: string } | null;
  /** The tag added, when the address was not a guess. */
  tagged: { tagId: number; tagName: string; createdTag: boolean } | null;
  /** The email marked as never having arrived. */
  send: { id: number; occurredAt: number; createdAt: number; countedForTouch: boolean } | null;
};

export type BounceResult = { ok: true; record: BounceRecord; sendTitle: string | null; next: EmailCandidate[] } | CoreError;

/**
 * An email to this address came back. A guessed address is taken off the
 * contact and remembered as wrong — for this person, and as a mark
 * against that format at the firm. An address Rolo was given stays, and
 * the contact is tagged "bad address". Either way the email it was sent
 * in stops counting as sent: nobody is waiting on a reply to it.
 */
export function recordBounce(input: { contactId: number; email: string; subject?: string | null }, now = Date.now()): BounceResult {
  const wanted = normalizeEmail(String(input.email ?? ""));
  if (!splitAddress(wanted)) return { ok: false, error: "That is not an email address." };
  return db.transaction((): BounceResult => {
    const contact = db.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, input.contactId)).get();
    if (!contact) return { ok: false, error: `There is no contact with id ${input.contactId}.` };
    const held = db.select().from(contactEmails).where(and(eq(contactEmails.contactId, input.contactId), eq(contactEmails.emailNormalized, wanted))).get();
    const guess = guessRow(input.contactId, wanted);
    if (!held && !guess) {
      return { ok: false, error: "That address is not one Rolo holds for this person, so there is nothing to correct." };
    }
    const record: BounceRecord = { contactId: input.contactId, email: wanted, retracted: null, tagged: null, send: null };

    if (held && guess && guess.status === "accepted") {
      // A guess that proved wrong: it goes, and is not offered again.
      db.delete(contactEmails).where(eq(contactEmails.id, held.id)).run();
      db.update(emailGuesses).set({ status: "bounced", updatedAt: now }).where(eq(emailGuesses.id, guess.id)).run();
      record.retracted = { email: held.email, label: held.label, priority: held.priority, source: held.source, createdAt: held.createdAt, guessStatus: guess.status };
    } else if (held) {
      // An address Rolo was given, or one that used to work: the owner decides what to do with it.
      const tag = findOrCreateTag(BAD_ADDRESS_TAG);
      if (!tag.ok) return { ok: false, error: tag.error };
      const res = setTagMembership([input.contactId], tag.tagId, true);
      if (!res.ok) return { ok: false, error: res.error };
      if (res.changedContactIds.length > 0) record.tagged = { tagId: tag.tagId, tagName: tag.name, createdTag: tag.created };
    }

    // The email that bounced: the latest one sent, or the latest with that subject.
    const want = normalizeSubject(input.subject ?? null);
    const sends = db
      .select()
      .from(interactions)
      .where(
        and(
          eq(interactions.contactId, input.contactId),
          eq(interactions.kind, "email"),
          eq(interactions.direction, "outbound"),
          gte(interactions.occurredAt, now - BOUNCE_WINDOW_MS)
        )
      )
      .orderBy(desc(interactions.occurredAt))
      .all()
      .filter((s) => !isBouncedMeta(s.meta));
    const send = (want ? sends.find((s) => normalizeSubject(s.title) === want) : undefined) ?? (want ? undefined : sends[0]);
    if (send) {
      db.update(interactions).set({ meta: withBounced(send.meta, true), countsForTouch: false }).where(eq(interactions.id, send.id)).run();
      record.send = { id: send.id, occurredAt: send.occurredAt, createdAt: send.createdAt, countedForTouch: send.countsForTouch };
      recomputeContact(input.contactId);
    }
    db.update(contacts).set({ updatedAt: now }).where(eq(contacts.id, input.contactId)).run();
    const next = suggestionFor(input.contactId);
    return { ok: true, record, sendTitle: send?.title ?? null, next: next && next.emails === 0 ? next.candidates : [] };
  });
}

/** Undo a recorded bounce, each part only while it is still as the bounce left it. */
export function undoBounce(record: BounceRecord, now = Date.now()): { reversed: string[]; skipped: string[] } {
  const reversed: string[] = [];
  const skipped: string[] = [];
  if (record.retracted) {
    const guess = guessRow(record.contactId, record.email);
    const exists = db.select({ id: contactEmails.id }).from(contactEmails).where(and(eq(contactEmails.contactId, record.contactId), eq(contactEmails.emailNormalized, record.email))).get();
    const contact = db.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, record.contactId)).get();
    if (!contact) skipped.push("the contact is gone");
    else if (exists || !guess || guess.status !== "bounced") skipped.push("the address has been dealt with since, so it was left");
    else {
      const r = record.retracted;
      db.insert(contactEmails)
        .values({ contactId: record.contactId, email: r.email, emailNormalized: record.email, label: r.label, priority: r.priority, source: r.source, createdAt: r.createdAt })
        .run();
      db.update(emailGuesses).set({ status: r.guessStatus, updatedAt: now }).where(eq(emailGuesses.id, guess.id)).run();
      reversed.push("put the address back on the contact");
    }
  }
  if (record.tagged) {
    const res = setTagMembership([record.contactId], record.tagged.tagId, false);
    if (res.ok && res.changedContactIds.length > 0) reversed.push(`removed the tag "${record.tagged.tagName}"`);
    else skipped.push(`the tag "${record.tagged.tagName}" was already off`);
  }
  if (record.send) {
    const row = db.select().from(interactions).where(eq(interactions.id, record.send.id)).get();
    // A row id is not an identity: this must be the email the bounce marked.
    if (!row || row.contactId !== record.contactId || row.createdAt !== record.send.createdAt || row.occurredAt !== record.send.occurredAt || !isBouncedMeta(row.meta)) {
      skipped.push("the email it marked has changed since, so it was left");
    } else {
      db.update(interactions).set({ meta: withBounced(row.meta, false), countsForTouch: record.send.countedForTouch }).where(eq(interactions.id, row.id)).run();
      recomputeContact(record.contactId);
      reversed.push("counted the email as sent again");
    }
  }
  return { reversed, skipped };
}
