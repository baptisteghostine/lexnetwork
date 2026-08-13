// Versioned filter JSON (SPEC §7): AND across dimensions, OR within one.
// This exact object is what views store and what the AI layer will compile
// to in Phase 10 — keep it JSON-serializable and additive-only; a schema
// change bumps `v` with a rewrite migration (SCHEMA.md `views`).

export type CustomFieldOp =
  | "contains" // text
  | "equals" // text / number / single_select
  | "gt" // number
  | "lt" // number
  | "before" // date
  | "after" // date
  | "includes"; // multi_select

export type FilterClause =
  | { dim: "group"; ids: number[] } // OR within; includes descendants
  | { dim: "tag"; ids: number[] }
  | { dim: "lastInteraction"; op: "before" | "after" | "never"; at?: number }
  | { dim: "titleContains"; value: string }
  | { dim: "company"; mode: "current" | "past" | "ex" | "any"; value: string }
  | { dim: "educationContains"; value: string }
  | { dim: "locationRadius"; lat: number; lng: number; km: number }
  | { dim: "hasLinkedin"; value: boolean }
  | { dim: "createdAt"; from?: number; to?: number }
  | { dim: "starred"; value: boolean }
  | { dim: "archived"; value: boolean }
  | { dim: "cadence"; value: "set" | "unset" }
  | { dim: "dueStatus"; value: "due" | "overdue" | "not_due" }
  | {
      dim: "customField";
      fieldId: number;
      op: CustomFieldOp;
      value: string | number;
    };

export type FilterSet = { v: 1; clauses: FilterClause[] };

export type SortSpec = {
  key: "name" | "company" | "recent" | "lastInteraction" | "nextTouch";
  dir: "asc" | "desc";
};

export const DEFAULT_SORT: SortSpec = { key: "name", dir: "asc" };

export function emptyFilterSet(): FilterSet {
  return { v: 1, clauses: [] };
}

/** Lenient parse of stored/URL filter JSON; null when unusable. */
export function parseFilterSet(raw: unknown): FilterSet | null {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (
    typeof raw !== "object" ||
    raw === null ||
    (raw as { v?: unknown }).v !== 1 ||
    !Array.isArray((raw as { clauses?: unknown }).clauses)
  ) {
    return null;
  }
  return raw as FilterSet;
}
