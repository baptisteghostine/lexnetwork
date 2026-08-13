import { describe, expect, it } from "vitest";

import {
  buildNlSearchSystem,
  extractJson,
  validateAiFilter,
  type FilterCatalog,
} from "@/lib/ai/nl-filter";

const CATALOG: FilterCatalog = {
  tags: [
    { id: 1, name: "investor" },
    { id: 2, name: "biotech" },
  ],
  groups: [{ id: 10, name: "College friends" }],
  customFields: [{ id: 5, name: "Fund size", kind: "number" }],
};

describe("validateAiFilter — SPEC §11 acceptance battery", () => {
  it("rejects an invented dimension, never executing it", () => {
    const result = validateAiFilter(
      { v: 1, clauses: [{ dim: "owesMeMoney", value: true }] },
      CATALOG
    );
    expect(result.ok).toBe(false);
  });

  it("rejects an invented field inside a known clause shape", () => {
    const result = validateAiFilter(
      { v: 1, clauses: [{ dim: "starred", value: true, secretField: 1 }] },
      CATALOG
    );
    expect(result.ok).toBe(false);
  });

  it("rejects tag/group/custom-field ids that don't exist", () => {
    expect(
      validateAiFilter({ v: 1, clauses: [{ dim: "tag", ids: [999] }] }, CATALOG)
        .ok
    ).toBe(false);
    expect(
      validateAiFilter(
        { v: 1, clauses: [{ dim: "group", ids: [11] }] },
        CATALOG
      ).ok
    ).toBe(false);
    expect(
      validateAiFilter(
        {
          v: 1,
          clauses: [{ dim: "customField", fieldId: 6, op: "gt", value: 100 }],
        },
        CATALOG
      ).ok
    ).toBe(false);
  });

  it("accepts the biotech-in-Boston-since-spring shape", () => {
    const spring = Date.UTC(2026, 2, 20);
    const result = validateAiFilter(
      {
        v: 1,
        clauses: [
          { dim: "titleContains", value: "biotech" },
          { dim: "locationRadius", lat: 42.36, lng: -71.06, km: 50 },
          { dim: "lastInteraction", op: "before", at: spring },
        ],
      },
      CATALOG
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filter.clauses).toHaveLength(3);
  });

  it("strips nulls the constrained output schema forces onto optionals", () => {
    const result = validateAiFilter(
      {
        v: 1,
        clauses: [{ dim: "lastInteraction", op: "never", at: null }],
      },
      CATALOG
    );
    expect(result.ok).toBe(true);
  });

  it("rejects before/after without a timestamp", () => {
    const result = validateAiFilter(
      { v: 1, clauses: [{ dim: "lastInteraction", op: "before" }] },
      CATALOG
    );
    expect(result.ok).toBe(false);
  });

  it("accepts an empty clause list (the honest couldn't-map result)", () => {
    const result = validateAiFilter({ v: 1, clauses: [] }, CATALOG);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filter.clauses).toHaveLength(0);
  });
});

describe("buildNlSearchSystem", () => {
  it("carries the owner's catalogs and only the catalogs", () => {
    const system = buildNlSearchSystem(CATALOG, Date.UTC(2026, 7, 13));
    expect(system).toContain('"investor"');
    expect(system).toContain('"College friends"');
    expect(system).toContain('"Fund size"');
    expect(system).toContain("2026-08-13");
  });
});

describe("extractJson", () => {
  it("tolerates prose and code fences around the object", () => {
    expect(
      extractJson('Here you go:\n```json\n{"v":1,"clauses":[]}\n```')
    ).toEqual({ v: 1, clauses: [] });
    expect(extractJson("no json here")).toBeNull();
  });
});
