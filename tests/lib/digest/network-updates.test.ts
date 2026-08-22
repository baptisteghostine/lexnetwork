import { describe, expect, it } from "vitest";

import {
  buildNetworkUpdates,
  changeAge,
  collapseUpdates,
  updateDiffHtml,
  updateDiffText,
  type NetworkUpdate,
  type PendingChangeRow,
} from "@/lib/digest/network-updates";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);

function update(over: Partial<NetworkUpdate> = {}): NetworkUpdate {
  return {
    displayName: "Ana Ruiz",
    field: "company",
    oldValue: "Stripe",
    newValue: "Figma",
    detectedAt: NOW,
    ...over,
  };
}

describe("changeAge", () => {
  it("rounds down, so a change from this morning is still today", () => {
    expect(changeAge(NOW - 90 * 60 * 1000, NOW)).toBe("today");
    expect(changeAge(NOW, NOW)).toBe("today");
  });

  it("never reads as the future when clocks disagree slightly", () => {
    expect(changeAge(NOW + 60_000, NOW)).toBe("today");
  });

  it("names the near days and then counts them", () => {
    expect(changeAge(NOW - DAY, NOW)).toBe("yesterday");
    expect(changeAge(NOW - 5 * DAY, NOW)).toBe("5d ago");
    expect(changeAge(NOW - 29 * DAY, NOW)).toBe("29d ago");
  });

  it("switches to months past 30 days", () => {
    expect(changeAge(NOW - 30 * DAY, NOW)).toBe("1mo ago");
    expect(changeAge(NOW - 95 * DAY, NOW)).toBe("3mo ago");
  });
});

describe("update diff", () => {
  it("strikes the old value through and greens the new one", () => {
    const html = updateDiffHtml(update());
    expect(html).toContain("line-through");
    expect(html).toContain("Stripe");
    expect(html).toContain("Figma");
    // The struck-through half must come first, or it reads as a downgrade.
    expect(html.indexOf("Stripe")).toBeLessThan(html.indexOf("Figma"));
  });

  it("shows only the new value when there was nothing before", () => {
    const html = updateDiffHtml(update({ oldValue: null }));
    expect(html).not.toContain("line-through");
    expect(html).toContain("Figma");
    expect(updateDiffText(update({ oldValue: null }))).toBe("Figma");
  });

  it("escapes values — a company name is untrusted import data", () => {
    const html = updateDiffHtml(
      update({ newValue: "<script>alert(1)</script>" })
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("collapseUpdates", () => {
  function row(over: Partial<PendingChangeRow>): PendingChangeRow {
    return { ...update(), id: 1, contactId: 1, ...over };
  }

  it("reports one move per contact+field, keeping the newest", () => {
    const { updates } = collapseUpdates([
      row({ id: 1, oldValue: "Stripe", newValue: "Figma", detectedAt: NOW - 7 * DAY }),
      row({ id: 2, oldValue: "Figma", newValue: "Linear", detectedAt: NOW }),
    ]);
    expect(updates).toHaveLength(1);
    expect(updates[0].newValue).toBe("Linear");
  });

  it("still stamps the superseded rows, or they resurface forever", () => {
    const { ids } = collapseUpdates([
      row({ id: 1, detectedAt: NOW - 7 * DAY }),
      row({ id: 2, detectedAt: NOW }),
    ]);
    expect(ids).toEqual([1, 2]);
  });

  it("keeps company and title moves for the same person separate", () => {
    const { updates } = collapseUpdates([
      row({ id: 1, field: "title", oldValue: "PM", newValue: "Director" }),
      row({ id: 2, field: "company" }),
    ]);
    expect(updates).toHaveLength(2);
    // Company first — "left Stripe for Figma" outranks "got promoted".
    expect(updates[0].field).toBe("company");
  });

  it("does not let row order decide which change wins", () => {
    const newestFirst = collapseUpdates([
      row({ id: 2, newValue: "Linear", detectedAt: NOW }),
      row({ id: 1, newValue: "Figma", detectedAt: NOW - 7 * DAY }),
    ]);
    expect(newestFirst.updates[0].newValue).toBe("Linear");
  });

  it("has nothing to say and nothing to stamp when there are no rows", () => {
    expect(collapseUpdates([])).toEqual({ ids: [], updates: [] });
  });
});

describe("buildNetworkUpdates", () => {
  it("names the person in a single-update subject", () => {
    const email = buildNetworkUpdates({
      updates: [update()],
      appUrl: "https://rolo.example",
      now: NOW,
    });
    expect(email.subject).toBe("Ana Ruiz changed jobs");
  });

  it("says 'role' for a title-only move", () => {
    const email = buildNetworkUpdates({
      updates: [update({ field: "title", oldValue: "PM", newValue: "Director" })],
      appUrl: "https://rolo.example",
      now: NOW,
    });
    expect(email.subject).toBe("Ana Ruiz changed role");
  });

  it("leads with a name and counts the rest", () => {
    const two = buildNetworkUpdates({
      updates: [update(), update({ displayName: "Bo Chen" })],
      appUrl: "https://rolo.example",
      now: NOW,
    });
    expect(two.subject).toBe(
      "Ana Ruiz and 1 other in your network changed jobs"
    );
    const three = buildNetworkUpdates({
      updates: [
        update(),
        update({ displayName: "Bo Chen" }),
        update({ displayName: "Cy Diaz" }),
      ],
      appUrl: "https://rolo.example",
      now: NOW,
    });
    expect(three.subject).toBe(
      "Ana Ruiz and 2 others in your network changed jobs"
    );
  });

  it("renders every update in both html and text, with its age", () => {
    const email = buildNetworkUpdates({
      updates: [
        update(),
        update({ displayName: "Bo Chen", detectedAt: NOW - 3 * DAY }),
      ],
      appUrl: "https://rolo.example",
      now: NOW,
    });
    for (const name of ["Ana Ruiz", "Bo Chen"]) {
      expect(email.html).toContain(name);
      expect(email.text).toContain(name);
    }
    expect(email.html).toContain("3d ago");
    expect(email.text).toContain("3d ago");
    expect(email.html).toContain("https://rolo.example/today");
    expect(email.text).toContain("https://rolo.example/today");
  });
});
