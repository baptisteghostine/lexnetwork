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
  | {
      dim: "lastInteraction";
      op: "before" | "after" | "never";
      at?: number;
      /** op:"before" only — also match contacts never spoken to. Without
       * it, "Founders I haven't talked to in 90 days" silently drops the
       * founders with zero interactions. */
      includeNever?: boolean;
    }
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

const isNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isIdArray = (v: unknown): v is number[] =>
  Array.isArray(v) && v.length > 0 && v.every(isNum);

/**
 * Per-clause shape validation (SCHEMA.md: "validated at read time" —
 * JSON-in-TEXT rots quietly). A clause failing this would crash the SQL
 * compiler (e.g. `ids: null`), so malformed clauses are dropped rather
 * than 500ing /contacts on a poison ?f= param or saved view.
 */
function isValidClause(raw: unknown): raw is FilterClause {
  if (typeof raw !== "object" || raw === null) return false;
  const c = raw as Record<string, unknown>;
  switch (c.dim) {
    case "group":
    case "tag":
      return isIdArray(c.ids);
    case "lastInteraction":
      return (
        (c.op === "before" || c.op === "after" || c.op === "never") &&
        (c.at === undefined || isNum(c.at)) &&
        (c.includeNever === undefined || isBool(c.includeNever))
      );
    case "titleContains":
    case "educationContains":
      return isStr(c.value) && c.value.length > 0;
    case "company":
      return (
        (c.mode === "current" || c.mode === "past" || c.mode === "ex" || c.mode === "any") &&
        isStr(c.value) &&
        c.value.length > 0
      );
    case "locationRadius":
      return isNum(c.lat) && isNum(c.lng) && isNum(c.km) && c.km > 0;
    case "hasLinkedin":
    case "starred":
    case "archived":
      return isBool(c.value);
    case "createdAt":
      return (
        (c.from === undefined || isNum(c.from)) &&
        (c.to === undefined || isNum(c.to))
      );
    case "cadence":
      return c.value === "set" || c.value === "unset";
    case "dueStatus":
      return c.value === "due" || c.value === "overdue" || c.value === "not_due";
    case "customField":
      return (
        isNum(c.fieldId) &&
        ["contains", "equals", "gt", "lt", "before", "after", "includes"].includes(
          c.op as string
        ) &&
        (isStr(c.value) || isNum(c.value))
      );
    default:
      return false;
  }
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
  const clauses = ((raw as { clauses: unknown[] }).clauses).filter(isValidClause);
  return { v: 1, clauses };
}
