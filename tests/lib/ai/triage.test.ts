import { describe, expect, it } from "vitest";

import {
  buildTriagePrompt,
  buildTriageSystem,
  clampHideBelow,
  isLowSignal,
  parseTriage,
} from "@/lib/ai/triage";

// SPEC §5/§11 job-change triage: the model's verdict is validated
// against the ids sent, quiet kinds carry no copy, and nothing here can
// dismiss a change — it only decides what Today folds away.

describe("buildTriagePrompt", () => {
  it("writes one compact line per change with the context Rolo has", () => {
    const p = buildTriagePrompt([
      {
        id: 7,
        displayName: "Sam Ford",
        field: "company",
        oldValue: "Barclays",
        newValue: "Santander",
        title: "Associate",
        company: "Santander",
        lastContactDays: 12,
        starred: true,
        lastNote: "wants intro to Priya",
        tags: ["LBS"],
      },
    ]);
    expect(p).toBe(
      "#7 Sam Ford — company: Barclays → Santander · now: Associate at Santander · last contact 12d ago · starred · tags: LBS · owner's note: wants intro to Priya"
    );
  });

  it("embeds the voice context in the system prompt", () => {
    expect(buildTriageSystem("<voice>short</voice>")).toContain("<voice>short</voice>");
  });
});

describe("parseTriage", () => {
  const allowed = new Set([1, 2, 3]);

  it("keeps sent ids only, once each, and clamps significance", () => {
    const out = parseTriage(
      JSON.stringify({
        items: [
          { id: 1, kind: "new_company", significance: 1.7, reason: "moved", opener: "Hi" },
          { id: 1, kind: "noise", significance: 0, reason: "", opener: "" },
          { id: 9, kind: "promotion", significance: 0.9, reason: "x", opener: "y" },
          { id: 2, kind: "promotion", significance: -1, reason: "up", opener: "Congrats" },
        ],
      }),
      allowed
    );
    expect([...out.keys()]).toEqual([1, 2]);
    expect(out.get(1)).toEqual({ kind: "new_company", significance: 1, reason: "moved", opener: "Hi" });
    expect(out.get(2)?.significance).toBe(0);
  });

  it("overrules copy on rename and noise and caps their significance", () => {
    const out = parseTriage(
      JSON.stringify({
        items: [{ id: 3, kind: "rename", significance: 0.8, reason: "should not show", opener: "nor this" }],
      }),
      allowed
    );
    expect(out.get(3)).toEqual({ kind: "rename", significance: 0.29, reason: "", opener: "" });
  });

  it("returns nothing on malformed output", () => {
    expect(parseTriage("nope", allowed).size).toBe(0);
    expect(parseTriage('{"items": [{"id": 1, "kind": "weird"}]}', allowed).size).toBe(0);
  });
});

describe("hide threshold", () => {
  it("clamps the setting and folds only below it", () => {
    expect(clampHideBelow(undefined)).toBe(0.3);
    expect(clampHideBelow(5)).toBe(0.9);
    expect(isLowSignal({ kind: "noise", significance: 0.1, reason: "", opener: "" }, 0.3)).toBe(true);
    expect(isLowSignal({ kind: "promotion", significance: 0.8, reason: "r", opener: "o" }, 0.3)).toBe(false);
    expect(isLowSignal(null, 0.3)).toBe(false);
  });
});
