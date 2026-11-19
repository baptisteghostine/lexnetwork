// Working out an address nobody gave Rolo (SPEC §17). A firm forms its
// addresses one way — ana.silva@, asilva@ — and that way can be read off
// the addresses already known there. Pure: names and addresses in,
// labelled guesses out. Nothing here decides that a guess is right; the
// owner does, by putting it on the contact.

export const EMAIL_PATTERNS = [
  "first.last",
  "firstlast",
  "first_last",
  "first-last",
  "flast",
  "f.last",
  "firstl",
  "first.l",
  "first",
  "last",
  "last.first",
  "lastfirst",
  "lastf",
  "last.f",
  "last_first",
] as const;

export type EmailPattern = (typeof EMAIL_PATTERNS)[number];

export function isEmailPattern(value: unknown): value is EmailPattern {
  return typeof value === "string" && (EMAIL_PATTERNS as readonly string[]).includes(value);
}

/** The pattern applied to "Ana Silva" — what the owner reads in a list. */
export const EMAIL_PATTERN_EXAMPLE: Record<EmailPattern, string> = {
  "first.last": "ana.silva",
  firstlast: "anasilva",
  first_last: "ana_silva",
  "first-last": "ana-silva",
  flast: "asilva",
  "f.last": "a.silva",
  firstl: "anas",
  "first.l": "ana.s",
  first: "ana",
  last: "silva",
  "last.first": "silva.ana",
  lastfirst: "silvaana",
  lastf: "silvaa",
  "last.f": "silva.a",
  last_first: "silva_ana",
};

// ---------- names ----------

const LETTERS: Record<string, string> = { ß: "ss", ø: "o", æ: "ae", œ: "oe", ł: "l", đ: "d", ð: "d", þ: "th", ı: "i" };

/** Words people put after a name that are not part of it. */
const NOT_A_NAME = new Set(["jr", "sr", "ii", "iii", "iv", "phd", "mba", "cfa", "cpa", "md", "esq", "acca", "aca", "frm", "caia"]);

/** "José-María" → ["jose", "maria"]: ascii letters only, in the order written. */
function tokens(text: string): string[] {
  const plain = text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[ßøæœłđðþı]/g, (c) => LETTERS[c] ?? c)
    // A bracketed aside — "(She/Her)", "(Annie)" — is not the name.
    .replace(/\([^)]*\)/g, " ")
    .replace(/['’`.]/g, "");
  return plain
    .split(/[^a-z]+/)
    .filter((t) => t.length > 0 && !NOT_A_NAME.has(t));
}

export type NameParts = {
  /** The form used when writing an address. */
  first: string;
  last: string;
  /** Every form an existing address may have used, the written one first. */
  firstForms: string[];
  lastForms: string[];
  /** More than one word in either part: the written form is a judgement. */
  compound: boolean;
};

function unique(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.length > 0))];
}

/**
 * A person's name as addresses spell it. Null when there is no first or
 * no last name to work with.
 */
export function nameParts(firstName: string | null, lastName: string | null): NameParts | null {
  let first = tokens(firstName ?? "");
  let last = tokens(lastName ?? "");
  // Everything in one field: the last word is the family name.
  if (last.length === 0 && first.length > 1) {
    last = [first[first.length - 1]];
    first = first.slice(0, -1);
  }
  if (first.length === 0 || last.length === 0) return null;
  const firstHyphenated = /[A-Za-zÀ-ÿ]-[A-Za-zÀ-ÿ]/.test(firstName ?? "");
  const lastHyphenated = /[A-Za-zÀ-ÿ]-[A-Za-zÀ-ÿ]/.test(lastName ?? "");
  // "Jean-Pierre" is one first name; "Ana Maria" is a first and a middle.
  const firstWritten = firstHyphenated ? first.join("") : first[0];
  const firstForms = unique([firstWritten, first.join(""), first.join("-"), first[0]]);
  // "de la Cruz" and "Smith-Jones" are one family name, written together.
  const lastWritten = last.join("");
  const lastForms = unique([lastWritten, last.join("-"), last[last.length - 1], last[0]]);
  return {
    first: firstWritten,
    last: lastWritten,
    firstForms,
    lastForms,
    compound: first.length > 1 || last.length > 1 || firstHyphenated || lastHyphenated,
  };
}

function build(pattern: EmailPattern, first: string, last: string): string {
  switch (pattern) {
    case "first.last":
      return `${first}.${last}`;
    case "firstlast":
      return `${first}${last}`;
    case "first_last":
      return `${first}_${last}`;
    case "first-last":
      return `${first}-${last}`;
    case "flast":
      return `${first[0]}${last}`;
    case "f.last":
      return `${first[0]}.${last}`;
    case "firstl":
      return `${first}${last[0]}`;
    case "first.l":
      return `${first}.${last[0]}`;
    case "first":
      return first;
    case "last":
      return last;
    case "last.first":
      return `${last}.${first}`;
    case "lastfirst":
      return `${last}${first}`;
    case "lastf":
      return `${last}${first[0]}`;
    case "last.f":
      return `${last}.${first[0]}`;
    case "last_first":
      return `${last}_${first}`;
  }
}

/** The part before the @ that `pattern` gives this person. */
export function applyPattern(pattern: EmailPattern, name: NameParts): string {
  return build(pattern, name.first, name.last);
}

/**
 * Which patterns turn this name into this local part. Usually one; none
 * when the address is not built from the name ("trading-desk"); several
 * when the name cannot tell them apart (a one-letter first name), in
 * which case the address is evidence for none of them.
 */
export function matchingPatterns(name: NameParts, localPart: string): EmailPattern[] {
  // "ana.silva+news" and "ana.silva2" are still ana.silva.
  const local = localPart.toLowerCase().replace(/\+.*$/, "").replace(/\d+$/, "");
  if (!local) return [];
  const found: EmailPattern[] = [];
  for (const pattern of EMAIL_PATTERNS) {
    const hit = name.firstForms.some((f) => name.lastForms.some((l) => build(pattern, f, l) === local));
    if (hit) found.push(pattern);
  }
  return found;
}

// ---------- domains ----------

const PERSONAL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "hotmail.com", "hotmail.co.uk", "hotmail.fr", "outlook.com", "outlook.fr", "live.com",
  "live.co.uk", "live.fr", "msn.com", "yahoo.com", "yahoo.co.uk", "yahoo.fr", "ymail.com", "icloud.com", "me.com",
  "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.de", "gmx.net", "gmx.fr", "mail.com",
  "yandex.com", "yandex.ru", "qq.com", "163.com", "126.com", "btinternet.com", "sky.com", "orange.fr", "free.fr",
  "wanadoo.fr", "laposte.net", "sfr.fr", "web.de", "hey.com", "fastmail.com", "zoho.com", "duck.com",
]);

/** A hostname as an address has it: lowercase labels, a dot, a TLD. */
const DOMAIN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

export function isDomain(value: string): boolean {
  return value.length <= 253 && DOMAIN.test(value) && !value.split(".").some((l) => l.startsWith("-") || l.endsWith("-"));
}

/**
 * A domain that says nothing about an employer: a mailbox provider, or a
 * school (an alumni address stays with a person through every job).
 */
export function isPersonalDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  if (PERSONAL_DOMAINS.has(d)) return true;
  return /\.edu$/.test(d) || /\.edu\.[a-z]{2}$/.test(d) || /\.ac\.[a-z]{2}$/.test(d) || /(^|\.)alumni\./.test(d);
}

export function splitAddress(email: string): { local: string; domain: string } | null {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  const domain = email.slice(at + 1).toLowerCase().trim();
  const local = email.slice(0, at).trim();
  return isDomain(domain) && local ? { local, domain } : null;
}

// ---------- learning ----------

export type Observation = { firmKey: string; firstName: string | null; lastName: string | null; email: string };

export type DomainEvidence = {
  domain: string;
  /** Addresses Rolo holds there, for people at this firm. */
  addresses: number;
  /** How those are built, most common first. */
  patterns: { pattern: EmailPattern; count: number }[];
  /** Addresses that fit no pattern, or more than one. */
  unclear: number;
};

/**
 * Read each firm's address format off the addresses known there. One
 * entry per firm, its domains ordered by how many addresses back them.
 */
export function learnPatterns(observations: Observation[]): Map<string, DomainEvidence[]> {
  const byFirm = new Map<string, Map<string, { addresses: number; patterns: Map<EmailPattern, number>; unclear: number }>>();
  for (const o of observations) {
    if (!o.firmKey) continue;
    const address = splitAddress(o.email);
    if (!address || isPersonalDomain(address.domain)) continue;
    const domains = byFirm.get(o.firmKey) ?? new Map();
    const entry = domains.get(address.domain) ?? { addresses: 0, patterns: new Map<EmailPattern, number>(), unclear: 0 };
    entry.addresses += 1;
    const name = nameParts(o.firstName, o.lastName);
    const matches = name ? matchingPatterns(name, address.local) : [];
    if (matches.length === 1) entry.patterns.set(matches[0], (entry.patterns.get(matches[0]) ?? 0) + 1);
    else entry.unclear += 1;
    domains.set(address.domain, entry);
    byFirm.set(o.firmKey, domains);
  }
  const out = new Map<string, DomainEvidence[]>();
  for (const [firm, domains] of byFirm) {
    out.set(
      firm,
      [...domains.entries()]
        .map(([domain, e]) => ({
          domain,
          addresses: e.addresses,
          patterns: [...e.patterns.entries()]
            .map(([pattern, count]) => ({ pattern, count }))
            .sort((a, b) => b.count - a.count || EMAIL_PATTERNS.indexOf(a.pattern) - EMAIL_PATTERNS.indexOf(b.pattern)),
          unclear: e.unclear,
        }))
        .sort((a, b) => b.addresses - a.addresses || (a.domain < b.domain ? -1 : 1))
    );
  }
  return out;
}

// ---------- suggesting ----------

export type FirmFormat = {
  domain: string;
  pattern: EmailPattern;
  source: "user" | "agent";
  /** For an agent's: where it got it. */
  basis: "seen_in_mail" | "published" | null;
  note: string | null;
};

export type GuessStrength = "strong" | "fair" | "weak";

export type EmailCandidate = {
  email: string;
  domain: string;
  pattern: EmailPattern;
  strength: GuessStrength;
  /** Why Rolo thinks so, in words the owner can check. */
  evidence: string;
};

export type SuggestInput = {
  firstName: string | null;
  lastName: string | null;
  /** The firm as the contact spells it, for the wording. */
  firmName: string | null;
  /** What was learned for the firm (or a firm it is part of). */
  learned: DomainEvidence[];
  /** A format somebody recorded for the firm. */
  stated: FirmFormat | null;
  /** When the evidence is another spelling's — "Goldman Sachs" for "Goldman Sachs International". */
  evidenceFirm?: string | null;
  /** Addresses not to offer this person: bounced, turned down, or already theirs. */
  excluded?: ReadonlySet<string>;
  /** How often each pattern has bounced for others at the domain in play. */
  bounces?: ReadonlyMap<string, number>;
};

export type SuggestResult = { candidates: EmailCandidate[]; reason: string | null };

export const MAX_CANDIDATES = 3;

/** The key `bounces` is read by. */
export function bounceKey(domain: string, pattern: string): string {
  return `${domain}|${pattern}`;
}

/**
 * Up to three addresses this person may have, best first, each with the
 * evidence for it — or the reason there is nothing to go on.
 */
export function suggestEmails(input: SuggestInput): SuggestResult {
  const firm = input.firmName?.trim() || "this firm";
  const name = nameParts(input.firstName, input.lastName);
  if (!name) return { candidates: [], reason: "Rolo needs a first and a last name to work out an address." };
  const domain = input.stated?.domain ?? input.learned[0]?.domain ?? null;
  if (!domain) {
    return { candidates: [], reason: `Rolo holds no address at ${firm} to learn from, and no format has been recorded for it.` };
  }
  const from = input.evidenceFirm ? ` (from ${input.evidenceFirm})` : "";
  const learned = input.learned.find((d) => d.domain === domain) ?? null;

  type Scored = { pattern: EmailPattern; score: number; reasons: string[]; strength: GuessStrength };
  const scored = new Map<EmailPattern, Scored>();
  const add = (pattern: EmailPattern, score: number, reason: string, strength: GuessStrength) => {
    const rank = { strong: 3, fair: 2, weak: 1 } as const;
    const have = scored.get(pattern);
    if (!have) scored.set(pattern, { pattern, score, reasons: [reason], strength });
    else {
      have.score += score;
      have.reasons.push(reason);
      if (rank[strength] > rank[have.strength]) have.strength = strength;
    }
  };

  if (learned) {
    for (const p of learned.patterns) {
      const share = p.count / learned.addresses;
      const strength: GuessStrength = p.count >= 3 && share >= 0.75 ? "strong" : p.count >= 2 ? "fair" : "weak";
      add(
        p.pattern,
        p.count,
        `${p.count} of the ${learned.addresses} address${learned.addresses === 1 ? "" : "es"} Rolo holds at ${domain}${from} ${p.count === 1 ? "is" : "are"} built this way`,
        strength
      );
    }
  }
  if (input.stated) {
    const s = input.stated;
    const note = s.note ? `: ${s.note}` : "";
    if (s.source === "user") add(s.pattern, 1000, `the format you set for ${input.evidenceFirm ?? firm}`, "strong");
    else if (s.basis === "seen_in_mail") add(s.pattern, 2.5, `the format Claude recorded from mail it read${note}`, "fair");
    else add(s.pattern, 1.5, `the format Claude recorded from a public source${note}`, "weak");
  }

  const excluded = input.excluded ?? new Set<string>();
  const candidates: EmailCandidate[] = [];
  const ordered = [...scored.values()]
    .map((s) => {
      const bounced = input.bounces?.get(bounceKey(domain, s.pattern)) ?? 0;
      if (bounced === 0) return s;
      // A bounce may be the person and not the format — they left, or spell
      // their name another way — so it weighs against the format without
      // settling it: a notch of confidence, and half as much again as one
      // address in its favour.
      const lowered: GuessStrength = s.strength === "strong" && bounced === 1 ? "fair" : "weak";
      return {
        ...s,
        score: s.score - 1.5 * bounced,
        strength: lowered,
        reasons: [...s.reasons, `but it bounced for ${bounced} other ${bounced === 1 ? "person" : "people"} there`],
      };
    })
    // A format that has only ever bounced is not worth offering — unless the owner set it.
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || EMAIL_PATTERNS.indexOf(a.pattern) - EMAIL_PATTERNS.indexOf(b.pattern));
  for (const s of ordered) {
    const email = `${applyPattern(s.pattern, name)}@${domain}`;
    if (excluded.has(email) || candidates.some((c) => c.email === email)) continue;
    candidates.push({
      email,
      domain,
      pattern: s.pattern,
      strength: s.strength,
      evidence: `${s.reasons.join("; ")}${name.compound ? " — a name of several words, so check how it is spelled" : ""}`,
    });
    if (candidates.length === MAX_CANDIDATES) break;
  }
  if (candidates.length === 0) {
    return {
      candidates,
      reason: scored.size === 0
        ? `Rolo knows the domain ${domain} but not how ${firm} builds its addresses.`
        : `Every format Rolo knows for ${firm} has already been tried for this person.`,
    };
  }
  return { candidates, reason: null };
}
