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

/** Words people put before or after a name that are not part of it. */
const NOT_A_NAME = new Set([
  "jr", "sr", "ii", "iii", "iv", "phd", "mba", "cfa", "cpa", "md", "esq", "acca", "aca", "frm", "caia",
  "dr", "prof", "professor", "sir", "dame", "lord", "lady", "mr", "mrs", "ms", "miss", "mme", "mlle", "herr", "frau",
]);

/** The longest a part before the @ may be (RFC 5321). */
export const LOCAL_PART_MAX = 64;

/** "José-María" → ["jose", "maria"]: ascii letters only, in the order written. */
function tokens(text: string): string[] {
  const plain = text
    // What follows a divider is a tagline, not the name: "Silva | Hiring", "Silva - Recruiter at GS".
    .split(/\s+[|•·–—-]\s+|,/)[0]
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
  // An initial is not a first name: "J. Smith" cannot be spelled out.
  if (first.join("").length < 2) return null;
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

/** A hostname as an address has it: lowercase labels, a dot, a TLD of letters. */
const DOMAIN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/;

export function isDomain(value: string): boolean {
  return value.length <= 253 && DOMAIN.test(value) && !value.split(".").some((l) => l.length > 63 || l.startsWith("-") || l.endsWith("-"));
}

/** Mailbox providers, by the name they go by in every country: hotmail.es, yahoo.de, gmail.co.uk. */
const PROVIDER_NAMES = new Set([
  "gmail", "googlemail", "hotmail", "outlook", "live", "msn", "yahoo", "ymail", "aol", "icloud", "protonmail", "proton",
  "gmx", "yandex", "zoho", "fastmail", "tutanota", "virginmedia", "btinternet", "btopenworld", "talktalk", "ntlworld",
  "blueyonder", "sky", "orange", "wanadoo", "laposte", "sfr", "free", "bluewin", "telenet", "ziggo", "comcast", "verizon", "att",
]);
const SECOND_LEVEL = new Set(["co", "com", "net", "org", "ac", "edu"]);

/** The name a domain is registered under: "gs" for gs.com, "evercore" for uk.evercore.co.uk. */
export function registeredName(domain: string): string {
  const labels = domain.toLowerCase().split(".");
  const tldParts = labels.length >= 3 && SECOND_LEVEL.has(labels[labels.length - 2]) ? 2 : 1;
  return labels[labels.length - tldParts - 1] ?? "";
}

/**
 * A domain that says nothing about an employer: a mailbox provider, or a
 * school (an alumni address stays with a person through every job).
 */
export function isPersonalDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  if (PERSONAL_DOMAINS.has(d) || PROVIDER_NAMES.has(registeredName(d)) || d === "mail.ru") return true;
  return /\.edu$/.test(d) || /\.edu\.[a-z]{2}$/.test(d) || /\.ac\.[a-z]{2}$/.test(d) || /(^|\.)alumni\./.test(d);
}

export function splitAddress(email: string): { local: string; domain: string } | null {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  const domain = email.slice(at + 1).toLowerCase().trim();
  const local = email.slice(0, at).trim();
  return isDomain(domain) && local ? { local, domain } : null;
}

const FIRM_FILLER = new Set([
  "the", "and", "of", "group", "bank", "banking", "capital", "partners", "partner", "company", "international", "global",
  "advisors", "advisory", "management", "asset", "securities", "holdings", "investments", "investment", "europe", "limited",
  "llp", "llc", "plc", "ltd", "inc", "corp",
]);

/**
 * Whether a domain plausibly belongs to the firm with this key: its
 * registered name shares a word with the firm's ("lazard.com" / lazard,
 * "morganstanley.com" / morgan stanley) or is its initials ("gs.com" /
 * goldman sachs). One person's address at an unrelated domain is their
 * own mailbox or their school, not their employer's format.
 */
export function domainFitsFirm(firmKey: string, domain: string): boolean {
  const name = registeredName(domain).replace(/[^a-z0-9]/g, "");
  if (!name) return false;
  const words = firmKey.split(/[^a-z0-9]+/).filter(Boolean);
  const telling = words.filter((w) => w.length >= 3 && !FIRM_FILLER.has(w));
  if (telling.some((w) => name.includes(w) || (name.length >= 3 && w.includes(name)))) return true;
  const initials = words.map((w) => w[0]).join("");
  return initials.length >= 2 && (name === initials || name.startsWith(initials));
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
        // Two people there share it, or it carries the firm's name: otherwise it is not evidence about the firm.
        .filter(([domain, e]) => e.addresses >= 2 || domainFitsFirm(firm, domain))
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
  // The owner's format settles the domain. Failing that, the addresses Rolo
  // holds do; a format an agent recorded decides it only when there is
  // nothing else, and never moves a firm to a domain its real addresses are not at.
  const domain = (input.stated?.source === "user" ? input.stated.domain : null) ?? input.learned[0]?.domain ?? input.stated?.domain ?? null;
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
  if (input.stated && input.stated.domain === domain) {
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
    const local = applyPattern(s.pattern, name);
    if (local.length > LOCAL_PART_MAX) continue;
    const email = `${local}@${domain}`;
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
