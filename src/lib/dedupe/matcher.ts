// Duplicate-candidate scoring (SPEC §10). Pure: rows in, scored pairs out —
// the scan job feeds it contacts and writes the queue; nothing here touches
// the DB, which is what makes the threshold battery unit-testable.

import { nicknameEquivalents, nicknamesMatch } from "@/lib/dedupe/nicknames";
import { jaroWinkler } from "@/lib/search/jaro";
import { normalizeForSearch } from "@/lib/search/rank";

export type MatchableContact = {
  id: number;
  firstName: string | null;
  lastName: string | null;
  displayName: string;
  company: string | null;
  emailsNormalized: string[];
  phonesE164: string[];
  groupIds: number[];
};

export type CandidatePair = {
  /** Canonical aId < bId, matching `duplicate_candidates`. */
  aId: number;
  bId: number;
  score: number;
  reasons: string[];
};

// Shared freemail domains corroborate nothing — half the address book is
// on gmail. Only a shared *organisation* domain says "same person".
const FREEMAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.uk",
  "hotmail.com",
  "hotmail.co.uk",
  "outlook.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "yandex.com",
]);

type NameKey = { first: string; last: string; full: string };

/**
 * SPEC §10 name normalization: lowercase, strip diacritics/punctuation,
 * drop middle tokens — "first last" is what Jaro-Winkler compares.
 */
export function nameKeyOf(c: {
  firstName: string | null;
  lastName: string | null;
  displayName: string;
}): NameKey | null {
  const raw =
    [c.firstName, c.lastName].filter(Boolean).join(" ").trim() || c.displayName;
  const tokens = normalizeForSearch(raw)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return null;
  const first = tokens[0];
  const last = tokens.length > 1 ? tokens[tokens.length - 1] : "";
  return { first, last, full: last ? `${first} ${last}` : first };
}

function normalizedCompany(company: string | null): string | null {
  if (!company) return null;
  const c = normalizeForSearch(company).replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
  return c || null;
}

function orgDomains(emailsNormalized: string[]): Set<string> {
  const out = new Set<string>();
  for (const e of emailsNormalized) {
    const at = e.lastIndexOf("@");
    if (at < 0) continue;
    const domain = e.slice(at + 1);
    if (!FREEMAIL.has(domain)) out.add(domain);
  }
  return out;
}

function intersects<T>(a: Iterable<T>, b: Set<T>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

/**
 * The corroborating signal that lifts a 0.90–0.95 name match into the
 * queue (SPEC §10): shared company, shared non-freemail email domain, or
 * shared group. Returns the reason tag, or null.
 */
function corroboration(
  a: MatchableContact,
  b: MatchableContact
): string | null {
  const ca = normalizedCompany(a.company);
  if (ca !== null && ca === normalizedCompany(b.company)) return "same_company";
  if (intersects(orgDomains(a.emailsNormalized), orgDomains(b.emailsNormalized)))
    return "same_email_domain";
  if (intersects(a.groupIds, new Set(b.groupIds))) return "shared_group";
  return null;
}

/**
 * Score one pair per SPEC §10. Returns null when the pair doesn't clear
 * the 0.85 queue threshold. Signals don't stack — the score is the best
 * single signal — but every contributing reason is reported.
 */
export function scorePair(
  a: MatchableContact,
  b: MatchableContact
): CandidatePair | null {
  const reasons: string[] = [];
  let score = 0;

  if (intersects(a.emailsNormalized, new Set(b.emailsNormalized))) {
    reasons.push("email_match");
    score = Math.max(score, 1.0);
  }
  const phonesB = new Set(b.phonesE164.filter(Boolean));
  if (intersects(a.phonesE164.filter(Boolean), phonesB)) {
    reasons.push("phone_match");
    score = Math.max(score, 0.95);
  }

  const keyA = nameKeyOf(a);
  const keyB = nameKeyOf(b);
  if (keyA && keyB) {
    // Nickname equivalence on first tokens: bob↔robert compare as equal.
    // Substituting one side's token into the other changes the JW value,
    // so evaluate BOTH substitutions and keep the better — the score must
    // not depend on which contact has the lower id.
    const fullOf = (first: string, last: string) =>
      last ? `${first} ${last}` : first;
    let jw = jaroWinkler(keyA.full, keyB.full);
    if (nicknamesMatch(keyA.first, keyB.first)) {
      jw = Math.max(
        jw,
        jaroWinkler(keyA.full, fullOf(keyA.first, keyB.last)),
        jaroWinkler(fullOf(keyB.first, keyA.last), keyB.full)
      );
    }
    if (jw >= 0.95) {
      reasons.push(`jw:${jw.toFixed(2)}`);
      score = Math.max(score, 0.85);
    } else if (jw >= 0.9) {
      const support = corroboration(a, b);
      if (support !== null) {
        reasons.push(`jw:${jw.toFixed(2)}`, support);
        score = Math.max(score, 0.75 + 0.1);
      }
    }
  }

  if (score < 0.85 || reasons.length === 0) return null;
  const [aId, bId] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
  return { aId, bId, score, reasons };
}

// A bucket this big means the key is useless as a blocker (e.g. a company
// town where everyone is "smith") — pairing inside it would be quadratic
// noise, and the email/phone buckets still catch the real duplicates.
const MAX_BUCKET = 200;

/**
 * Compare-worthy pairs via blocking, so the scan stays fast at 10k
 * contacts: exact buckets on normalized email and E.164 phone, name
 * buckets on every nickname-equivalent of the first token, the last
 * token, and a coarse first3(first)|first3(last) prefix key. The prefix
 * key exists because a pair can clear JW ≥ 0.90 with *both* tokens
 * slightly different ("christopher anderson" / "christophe andersen") —
 * exact token buckets alone would never compare them.
 */
export function candidatePairs(
  contacts: MatchableContact[]
): CandidatePair[] {
  const byId = new Map(contacts.map((c) => [c.id, c]));
  const buckets = new Map<string, number[]>();
  const add = (key: string, id: number) => {
    const list = buckets.get(key);
    if (list) list.push(id);
    else buckets.set(key, [id]);
  };

  for (const c of contacts) {
    for (const e of c.emailsNormalized) add(`e:${e}`, c.id);
    for (const p of c.phonesE164) if (p) add(`p:${p}`, c.id);
    const key = nameKeyOf(c);
    if (key) {
      for (const eq of nicknameEquivalents(key.first)) add(`f:${eq}`, c.id);
      if (key.last) add(`l:${key.last}`, c.id);
      add(`x:${key.first.slice(0, 3)}|${key.last.slice(0, 3)}`, c.id);
    }
  }

  const seen = new Set<string>();
  const out: CandidatePair[] = [];
  for (const ids of buckets.values()) {
    if (ids.length < 2 || ids.length > MAX_BUCKET) continue;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const [aId, bId] =
          ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]];
        const pairKey = `${aId}:${bId}`;
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);
        const pair = scorePair(byId.get(aId)!, byId.get(bId)!);
        if (pair) out.push(pair);
      }
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

export type ExistingPair = {
  aId: number;
  bId: number;
  status: "open" | "dismissed" | "merged";
};

export type QueuePlan = {
  insert: CandidatePair[];
  /** Open pairs re-found this scan — refresh score/reasons. */
  update: CandidatePair[];
  /** Open pairs the scan no longer produces — stale suggestions to drop. */
  remove: { aId: number; bId: number }[];
};

/**
 * Reconcile a scan's results with the stored queue. Dismissal memory is
 * the load-bearing rule (SPEC §10): a pair the owner marked "not
 * duplicates" — or already merged — is never re-suggested, whatever the
 * scan says. Open suggestions are refreshed or dropped to match reality.
 */
export function planQueueUpdate(
  existing: ExistingPair[],
  found: CandidatePair[]
): QueuePlan {
  const keyOf = (p: { aId: number; bId: number }) => `${p.aId}:${p.bId}`;
  const existingByKey = new Map(existing.map((p) => [keyOf(p), p]));
  const foundKeys = new Set(found.map(keyOf));

  const plan: QueuePlan = { insert: [], update: [], remove: [] };
  for (const pair of found) {
    const prior = existingByKey.get(keyOf(pair));
    if (!prior) plan.insert.push(pair);
    else if (prior.status === "open") plan.update.push(pair);
    // dismissed / merged: remembered, never re-suggested.
  }
  for (const prior of existing) {
    if (prior.status === "open" && !foundKeys.has(keyOf(prior))) {
      plan.remove.push({ aId: prior.aId, bId: prior.bId });
    }
  }
  return plan;
}
