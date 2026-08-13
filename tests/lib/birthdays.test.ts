import { describe, expect, it } from "vitest";

import { upcomingBirthdays, type BirthdayContact } from "@/lib/birthdays";

function contact(over: Partial<BirthdayContact> & { id: number }): BirthdayContact {
  return {
    displayName: `C${over.id}`,
    birthdayMonth: null,
    birthdayDay: null,
    birthdayYear: null,
    starred: false,
    lastInteractionAt: 1,
    ...over,
  };
}

const OPTS = { windowDays: 7, feb29: "feb28" as const, importantOnly: false };

describe("upcomingBirthdays", () => {
  it("finds birthdays inside the window, sorted soonest first", () => {
    const out = upcomingBirthdays(
      [
        contact({ id: 1, birthdayMonth: 8, birthdayDay: 20 }),
        contact({ id: 2, birthdayMonth: 8, birthdayDay: 15 }),
        contact({ id: 3, birthdayMonth: 9, birthdayDay: 1 }), // outside
      ],
      { year: 2026, month: 8, day: 13 },
      OPTS
    );
    expect(out.map((b) => b.contactId)).toEqual([2, 1]);
    expect(out[0].daysUntil).toBe(2);
  });

  it("treats today as daysUntil 0 and wraps across New Year", () => {
    const out = upcomingBirthdays(
      [
        contact({ id: 1, birthdayMonth: 12, birthdayDay: 30 }),
        contact({ id: 2, birthdayMonth: 1, birthdayDay: 2 }),
      ],
      { year: 2026, month: 12, day: 30 },
      OPTS
    );
    expect(out.map((b) => [b.contactId, b.daysUntil])).toEqual([
      [1, 0],
      [2, 3],
    ]);
  });

  it("observes Feb 29 per the configured rule in non-leap years", () => {
    const contacts = [
      contact({ id: 1, birthdayMonth: 2, birthdayDay: 29 }),
    ];
    const feb28 = upcomingBirthdays(
      contacts,
      { year: 2026, month: 2, day: 25 },
      { ...OPTS, feb29: "feb28" }
    );
    expect([feb28[0].month, feb28[0].day]).toEqual([2, 28]);
    const mar1 = upcomingBirthdays(
      contacts,
      { year: 2026, month: 2, day: 25 },
      { ...OPTS, feb29: "mar1" }
    );
    expect([mar1[0].month, mar1[0].day]).toEqual([3, 1]);
  });

  it("keeps Feb 29 itself in leap years", () => {
    const out = upcomingBirthdays(
      [contact({ id: 1, birthdayMonth: 2, birthdayDay: 29 })],
      { year: 2028, month: 2, day: 25 },
      { ...OPTS, feb29: "mar1" }
    );
    expect([out[0].month, out[0].day]).toEqual([2, 29]);
  });

  it("importantOnly drops never-interacted, unstarred contacts", () => {
    const out = upcomingBirthdays(
      [
        contact({ id: 1, birthdayMonth: 8, birthdayDay: 14, lastInteractionAt: null }),
        contact({ id: 2, birthdayMonth: 8, birthdayDay: 14, lastInteractionAt: null, starred: true }),
        contact({ id: 3, birthdayMonth: 8, birthdayDay: 14 }),
      ],
      { year: 2026, month: 8, day: 13 },
      { ...OPTS, importantOnly: true }
    );
    expect(out.map((b) => b.contactId).sort()).toEqual([2, 3]);
  });

  it("computes the age they turn when birth year is known", () => {
    const out = upcomingBirthdays(
      [
        contact({ id: 1, birthdayMonth: 8, birthdayDay: 15, birthdayYear: 1990 }),
        contact({ id: 2, birthdayMonth: 1, birthdayDay: 2, birthdayYear: 1990 }),
      ],
      { year: 2026, month: 12, day: 30 },
      { ...OPTS }
    );
    // Jan 2 birthday falls in 2027 → turns 37.
    expect(out.find((b) => b.contactId === 2)?.turns).toBe(37);
  });
});
