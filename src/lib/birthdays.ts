// Pure birthday math (no DB): upcoming birthdays inside a window, the
// Feb-29 rule, and the "important only" filter (SPEC Phase 5 + Dex's
// noise-control default: starred or previously-interacted contacts).

export type BirthdayContact = {
  id: number;
  displayName: string;
  birthdayMonth: number | null;
  birthdayDay: number | null;
  birthdayYear: number | null;
  starred: boolean;
  lastInteractionAt: number | null;
  /** SPEC §6 "important only": ≥1 recorded interaction EVER — any kind,
   * counting or not. lastInteractionAt alone drops inbound-only
   * correspondents (it tracks counting interactions only). */
  hasInteraction?: boolean;
  hasPhoto?: boolean;
};

export type Feb29Rule = "feb28" | "mar1";

export type UpcomingBirthday = {
  contactId: number;
  displayName: string;
  /** 0 = today. */
  daysUntil: number;
  /** Observed celebration date. */
  month: number;
  day: number;
  /** Age they turn, when the birth year is known. */
  turns: number | null;
  starred: boolean;
  hasPhoto: boolean;
};

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function dayOfYear(year: number, month: number, day: number): number {
  let n = day;
  for (let m = 1; m < month; m++) {
    n += DAYS_IN_MONTH[m - 1] + (m === 2 && isLeap(year) ? 1 : 0);
  }
  return n;
}

function daysInYear(year: number): number {
  return isLeap(year) ? 366 : 365;
}

/** Where a Feb 29 birthday is observed in `year` under `rule`. */
function observed(
  month: number,
  day: number,
  year: number,
  rule: Feb29Rule
): { month: number; day: number } {
  if (month === 2 && day === 29 && !isLeap(year)) {
    return rule === "feb28" ? { month: 2, day: 28 } : { month: 3, day: 1 };
  }
  return { month, day };
}

/**
 * Birthdays falling within [today, today + windowDays] of the owner's
 * local date, sorted soonest first (ties: starred first, then name).
 */
export function upcomingBirthdays(
  contacts: BirthdayContact[],
  localToday: { year: number; month: number; day: number },
  opts: { windowDays: number; feb29: Feb29Rule; importantOnly: boolean }
): UpcomingBirthday[] {
  const todayN = dayOfYear(localToday.year, localToday.month, localToday.day);
  const out: UpcomingBirthday[] = [];

  for (const c of contacts) {
    if (!c.birthdayMonth || !c.birthdayDay) continue;
    const everInteracted =
      (c.hasInteraction ?? false) || c.lastInteractionAt !== null;
    if (opts.importantOnly && !c.starred && !everInteracted) {
      continue;
    }
    // Check this year and next (window can straddle New Year).
    let best: { daysUntil: number; month: number; day: number } | null = null;
    for (const yearOffset of [0, 1]) {
      const y = localToday.year + yearOffset;
      const o = observed(c.birthdayMonth, c.birthdayDay, y, opts.feb29);
      const n =
        dayOfYear(y, o.month, o.day) +
        (yearOffset === 1 ? daysInYear(localToday.year) : 0);
      const daysUntil = n - todayN;
      if (daysUntil >= 0 && (best === null || daysUntil < best.daysUntil)) {
        best = { daysUntil, month: o.month, day: o.day };
      }
    }
    if (best === null || best.daysUntil > opts.windowDays) continue;
    out.push({
      contactId: c.id,
      displayName: c.displayName,
      daysUntil: best.daysUntil,
      month: best.month,
      day: best.day,
      turns:
        c.birthdayYear !== null
          ? localToday.year +
            (best.daysUntil + todayN > daysInYear(localToday.year) ? 1 : 0) -
            c.birthdayYear
          : null,
      starred: c.starred,
      hasPhoto: c.hasPhoto ?? false,
    });
  }

  out.sort(
    (a, b) =>
      a.daysUntil - b.daysUntil ||
      Number(b.starred) - Number(a.starred) ||
      a.displayName.localeCompare(b.displayName)
  );
  return out;
}
