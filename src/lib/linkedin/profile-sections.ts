// A profile's Experience, Education and About, as read off the page the
// owner is looking at (SPEC §9c, profile capture — career history added
// 2026-11-19). The extension sends each list entry as its lines of text
// and nothing more; everything that decides what a line means is here, on
// the server, where a layout change is fixed by a deploy instead of by
// reloading the extension. Pure.

import { z } from "zod";

const line = z.string().max(4000);
const entryLines = z.array(line).max(60);

export const sectionEntrySchema = z.object({
  lines: entryLines,
  /** Roles listed under one employer. */
  children: z.array(z.object({ lines: entryLines })).max(30).optional(),
});

export type SectionEntry = z.infer<typeof sectionEntrySchema>;

export const capturedSectionsSchema = z.object({
  experience: z.array(sectionEntrySchema).max(80).optional(),
  education: z.array(sectionEntrySchema).max(40).optional(),
  about: z
    .string()
    .max(8000)
    .nullable()
    .optional()
    .transform((v) => (v && v.trim() ? v : null)),
});

export type CapturedSections = z.infer<typeof capturedSectionsSchema>;

export const ROLE_DESCRIPTION_MAX = 1500;
export const BIO_MAX = 2000;

export type CapturedRole = {
  company: string;
  title: string | null;
  /** 'YYYY-MM' or 'YYYY'. */
  startDate: string | null;
  endDate: string | null;
  isCurrent: boolean;
  description: string | null;
};

export type CapturedSchool = {
  school: string;
  degree: string | null;
  field: string | null;
  startYear: number | null;
  endYear: number | null;
};

// ---------- text ----------

/** Lower-case, accents off: "Févr." and "fevr" compare equal. */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
}

/**
 * An entry's lines as a reader sees them. LinkedIn prints most text
 * twice — once for the eye, once for screen readers — so the same line
 * arrives back to back; and a line is sometimes the previous one with
 * more on the end.
 */
export function cleanLines(lines: string[]): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (out.length > 0 && out[out.length - 1] === text) continue;
    out.push(text);
  }
  return out;
}

// ---------- dates ----------

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, janv: 1, janvier: 1,
  feb: 2, february: 2, fev: 2, fevr: 2, fevrier: 2,
  mar: 3, march: 3, mars: 3,
  apr: 4, april: 4, avr: 4, avril: 4,
  may: 5, mai: 5,
  jun: 6, june: 6, juin: 6,
  jul: 7, july: 7, juil: 7, juillet: 7,
  aug: 8, august: 8, aout: 8,
  sep: 9, sept: 9, september: 9, septembre: 9,
  oct: 10, october: 10, octobre: 10,
  nov: 11, november: 11, novembre: 11,
  dec: 12, december: 12, decembre: 12,
};

const PRESENT = /^(present|now|current|aujourd ?hui|actuel|ce jour|heute|actualidad|presente|oggi|heden)$/;

/** "Jan 2022" → "2022-01"; "2022" → "2022"; anything else → null. */
export function parsePartialDate(text: string): string | null {
  const t = fold(text).replace(/\./g, "").trim();
  const year = /^(19|20)\d{2}$/.exec(t);
  if (year) return t;
  const m = /^([a-z]+) ((?:19|20)\d{2})$/.exec(t);
  if (!m) return null;
  const month = MONTHS[m[1]];
  return month ? `${m[2]}-${String(month).padStart(2, "0")}` : null;
}

export type DateRange = { start: string; end: string | null; current: boolean };

/**
 * "Jan 2022 - Present · 2 yrs 11 mos", "2019 – 2021", "sept. 2020 -
 * aujourd’hui · 4 ans" → the two ends. Null for a line that is not a
 * date range, which is how the date line of an entry is found.
 */
export function parseDateRange(text: string): DateRange | null {
  // The duration after the dot is LinkedIn's arithmetic, not a date.
  const head = fold(text.split(" · ")[0]).trim();
  const parts = head.split(/\s+(?:-|–|—|to|a|au)\s+/).map((p) => p.trim());
  if (parts.length === 1) {
    // A single month or year: a role that began and ended inside it.
    const only = parsePartialDate(parts[0]);
    return only && / · /.test(text) ? { start: only, end: only, current: false } : null;
  }
  if (parts.length !== 2) return null;
  const start = parsePartialDate(parts[0]);
  if (!start) return null;
  const last = parts[1].replace(/[’'.]/g, " ").replace(/\s+/g, " ").trim();
  if (PRESENT.test(last)) return { start, end: null, current: true };
  const end = parsePartialDate(parts[1]);
  return end ? { start, end, current: false } : null;
}

// ---------- experience ----------

const NOT_DESCRIPTION = /^(skills|competences|kenntnisse|aptitudes)\s*:/;
const SEE_MORE = /^(…|\.\.\.)?\s*(see more|voir plus|show more|afficher plus)$/;
const WORK_MODE = /\b(remote|hybrid|on-site|onsite|sur site|a distance|hybride|teletravail)\b/;

/** "London, England, United Kingdom · Hybrid" — where, not what. */
function looksLikeLocation(text: string): boolean {
  if (text.length > 110) return false;
  const f = fold(text);
  if (/[.!?]\s|[.!?]$/.test(text) && !/ · /.test(text)) return false;
  return WORK_MODE.test(f) || /^[^,]{2,40}(, [^,]{2,40}){1,3}$/.test(text) || / · /.test(text);
}

function describe(lines: string[]): string | null {
  const kept: string[] = [];
  for (const l of lines) {
    const f = fold(l);
    if (NOT_DESCRIPTION.test(f) || SEE_MORE.test(f)) continue;
    kept.push(l.replace(/\s*(…|\.\.\.)\s*(see more|voir plus)\s*$/i, "").trim());
  }
  const text = kept.filter(Boolean).join("\n").trim();
  if (!text) return null;
  return text.length > ROLE_DESCRIPTION_MAX ? `${text.slice(0, ROLE_DESCRIPTION_MAX - 1).trimEnd()}…` : text;
}

/** The employer on a "Company · Full-time" line. */
function employer(text: string): string {
  return text.split(" · ")[0].trim();
}

function roleFrom(company: string, title: string | null, range: DateRange, after: string[]): CapturedRole {
  const rest = after.length > 0 && looksLikeLocation(after[0]) ? after.slice(1) : after;
  return {
    company: company.slice(0, 200),
    title: title ? title.slice(0, 200) : null,
    startDate: range.start,
    endDate: range.end,
    isCurrent: range.current,
    description: describe(rest),
  };
}

/**
 * Roles from the Experience list. An entry is either one role — title,
 * employer, dates, then what they wrote — or an employer with several
 * roles under it. An entry with no date line is not a role (it is a
 * "show all" link, or a layout this does not know) and is left out.
 */
export function parseExperience(entries: SectionEntry[]): CapturedRole[] {
  const roles: CapturedRole[] = [];
  for (const entry of entries) {
    const lines = cleanLines(entry.lines);
    const at = lines.findIndex((l) => parseDateRange(l) !== null);
    const nested = (entry.children ?? [])
      .map((c) => cleanLines(c.lines))
      .map((l) => ({ lines: l, at: l.findIndex((x) => parseDateRange(x) !== null) }));
    const children = nested.filter((c) => c.at >= 1);

    // Title, employer, dates: one role. What they wrote about it sits in
    // the entries nested under it — the ones that are not roles themselves.
    if (at >= 2) {
      const company = employer(lines[1]);
      const written = nested.filter((c) => c.at === -1).flatMap((c) => c.lines);
      if (company) roles.push(roleFrom(company, lines[0], parseDateRange(lines[at]) as DateRange, [...lines.slice(at + 1), ...written]));
      continue;
    }
    // An employer, then its roles.
    if (children.length > 0 && lines.length > 0) {
      const company = employer(lines[0]);
      if (!company) continue;
      for (const c of children) {
        roles.push(roleFrom(company, c.lines[0], parseDateRange(c.lines[c.at]) as DateRange, c.lines.slice(c.at + 1)));
      }
    }
  }
  // The same role read twice (a list rendered once per breakpoint) is one role.
  const seen = new Set<string>();
  return roles.filter((r) => {
    const key = `${fold(r.company)}|${fold(r.title ?? "")}|${r.startDate}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------- education ----------

const NOT_A_SCHOOL = /^(show all|afficher|voir (les|tout)|see all)\b/;
const EDUCATION_EXTRA = /^(grade|note|activities and societies|activites et associations|skills|competences)\s*:/;

function yearOf(date: string | null): number | null {
  return date ? Number(date.slice(0, 4)) : null;
}

export function parseEducation(entries: SectionEntry[]): CapturedSchool[] {
  const schools: CapturedSchool[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const lines = cleanLines(entry.lines);
    if (lines.length === 0 || NOT_A_SCHOOL.test(fold(lines[0]))) continue;
    const school = lines[0].slice(0, 200);
    const at = lines.findIndex((l, i) => i > 0 && parseDateRange(l) !== null);
    const range = at === -1 ? null : parseDateRange(lines[at]);
    // The line between the school and the dates, when there is one.
    const second = lines[1] && at !== 1 && !EDUCATION_EXTRA.test(fold(lines[1])) ? lines[1] : null;
    // A lone line with no dates and no degree is a link or a heading, not a school.
    if (!second && !range) continue;
    let degree: string | null = null;
    let field: string | null = null;
    if (second) {
      const comma = second.indexOf(", ");
      degree = (comma === -1 ? second : second.slice(0, comma)).trim().slice(0, 200) || null;
      field = comma === -1 ? null : second.slice(comma + 2).trim().slice(0, 200) || null;
    }
    const key = `${fold(school)}|${fold(degree ?? "")}|${range?.start ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    schools.push({ school, degree, field, startYear: yearOf(range?.start ?? null), endYear: yearOf(range?.end ?? null) });
  }
  return schools;
}

const ABOUT_HEADING = /^(about|infos|a propos|info|acerca de|uber mich)$/;

/** The About text as one bounded paragraph block. */
export function parseAbout(about: string | null): string | null {
  if (!about) return null;
  const text = cleanLines(about.split("\n"))
    // The section's own heading, when it came along.
    .filter((l, i) => !(i === 0 && ABOUT_HEADING.test(fold(l))))
    .filter((l) => !SEE_MORE.test(fold(l)))
    .join("\n")
    .replace(/\s*(…|\.\.\.)\s*(see more|voir plus)\s*$/i, "")
    .trim();
  if (!text) return null;
  return text.length > BIO_MAX ? `${text.slice(0, BIO_MAX - 1).trimEnd()}…` : text;
}

// ---------- fitting it to what Rolo already holds ----------

export type StoredRole = {
  id: number;
  companyNormalized: string;
  title: string | null;
  startDate: string | null;
  endDate: string | null;
  isCurrent: boolean;
  description: string | null;
  source: string;
};

export type RoleUpdate = {
  id: number;
  title?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  isCurrent?: boolean;
  description?: string | null;
  source?: string;
};

export type RolePlan = { inserts: CapturedRole[]; updates: RoleUpdate[] };

/** The source of a role read off the profile page. */
export const PROFILE_SOURCE = "linkedin_profile";
/** Rows the LinkedIn imports keep from the headline: one, current, undated or dated to when it was noticed. */
const HEADLINE_SOURCE = "linkedin";

/**
 * What to write so the stored history holds the captured roles — once
 * each. A profile page shows only its first few roles, so nothing is
 * ever removed for being absent. The current row the imports keep from
 * the headline becomes the real role rather than sitting beside it; a
 * row from any other source (typed, imported from a file) is only filled
 * in where it is empty.
 */
export function planWorkHistory(stored: StoredRole[], captured: CapturedRole[], normalize: (company: string) => string): RolePlan {
  const plan: RolePlan = { inserts: [], updates: [] };
  const taken = new Set<number>();
  for (const role of captured) {
    const key = normalize(role.company);
    if (!key) continue;
    const pool = stored.filter((s) => s.companyNormalized === key && !taken.has(s.id));
    const match =
      pool.find((s) => s.startDate !== null && s.startDate === role.startDate) ??
      (role.isCurrent ? pool.find((s) => s.isCurrent && s.source === HEADLINE_SOURCE) : undefined) ??
      pool.find((s) => s.startDate === null && fold(s.title ?? "") === fold(role.title ?? ""));
    if (!match) {
      plan.inserts.push(role);
      continue;
    }
    taken.add(match.id);
    const ours = match.source === HEADLINE_SOURCE || match.source === PROFILE_SOURCE;
    const update: RoleUpdate = { id: match.id };
    const set = <K extends keyof Omit<RoleUpdate, "id">>(field: K, value: RoleUpdate[K], current: RoleUpdate[K]) => {
      if (value === undefined || value === current) return;
      // Somebody else's row: add what is missing, change nothing that is there.
      if (!ours && current !== null && current !== false) return;
      update[field] = value;
    };
    if (role.title) set("title", role.title, match.title);
    set("startDate", role.startDate, match.startDate);
    if (role.endDate !== null || ours) set("endDate", role.endDate, match.endDate);
    if (ours) set("isCurrent", role.isCurrent, match.isCurrent);
    if (role.description) set("description", role.description, match.description);
    if (match.source === HEADLINE_SOURCE) update.source = PROFILE_SOURCE;
    if (Object.keys(update).length > 1) plan.updates.push(update);
  }
  return plan;
}

export type StoredSchool = {
  id: number;
  school: string;
  degree: string | null;
  field: string | null;
  startYear: number | null;
  endYear: number | null;
};

export type SchoolUpdate = { id: number; degree?: string; field?: string; startYear?: number; endYear?: number };

export type SchoolPlan = { inserts: CapturedSchool[]; updates: SchoolUpdate[] };

/** Schools, once each: a stored row is filled in where it is empty, never rewritten. */
export function planEducation(stored: StoredSchool[], captured: CapturedSchool[]): SchoolPlan {
  const plan: SchoolPlan = { inserts: [], updates: [] };
  const taken = new Set<number>();
  for (const school of captured) {
    const key = fold(school.school).replace(/\s+/g, " ").trim();
    const pool = stored.filter((s) => fold(s.school).replace(/\s+/g, " ").trim() === key && !taken.has(s.id));
    const sameYears = (s: StoredSchool) =>
      (s.endYear === null || school.endYear === null || s.endYear === school.endYear) &&
      (s.startYear === null || school.startYear === null || s.startYear === school.startYear);
    const match =
      pool.find((s) => sameYears(s) && fold(s.degree ?? "") === fold(school.degree ?? "")) ??
      pool.find((s) => sameYears(s) && (s.degree === null || school.degree === null));
    if (!match) {
      plan.inserts.push(school);
      continue;
    }
    taken.add(match.id);
    const update: SchoolUpdate = { id: match.id };
    if (match.degree === null && school.degree) update.degree = school.degree;
    if (match.field === null && school.field) update.field = school.field;
    if (match.startYear === null && school.startYear !== null) update.startYear = school.startYear;
    if (match.endYear === null && school.endYear !== null) update.endYear = school.endYear;
    if (Object.keys(update).length > 1) plan.updates.push(update);
  }
  return plan;
}
