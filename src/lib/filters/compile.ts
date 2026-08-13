// FilterSet → parameterized SQL over `contacts c` (pure — no DB import).
// Every SPEC §7 dimension compiles here; tests execute the output against
// an in-memory database built from the real migrations.

import { DAY_MS } from "@/lib/cadence/engine";
import type { FilterClause, FilterSet, SortSpec } from "@/lib/filters/types";
import { DEFAULT_SORT } from "@/lib/filters/types";

export type Catalog = {
  /** Existing ids, for dangling-reference warnings (deleted tag/field). */
  tagIds?: Set<number>;
  groupIds?: Set<number>;
  customFieldIds?: Set<number>;
  /** Whether a geocoder is configured; without one, radius is skipped. */
  geocoderConfigured?: boolean;
};

export type Compiled = {
  sql: string;
  params: unknown[];
  warnings: string[];
  /** Post-SQL refinement the executor must apply (haversine on radius). */
  radius: { lat: number; lng: number; km: number } | null;
};

function likeParam(value: string): string {
  return `%${value.toLowerCase().replaceAll(/[%_\\]/g, (c) => `\\${c}`)}%`;
}

const COMPANY_MATCH_CURRENT = `(
  LOWER(COALESCE(c.company,'')) LIKE ? ESCAPE '\\'
  OR EXISTS (SELECT 1 FROM work_history wh WHERE wh.contact_id = c.id
             AND wh.is_current = 1 AND LOWER(wh.company) LIKE ? ESCAPE '\\')
)`;
const COMPANY_MATCH_PAST = `EXISTS (
  SELECT 1 FROM work_history wh WHERE wh.contact_id = c.id
  AND wh.is_current = 0 AND LOWER(wh.company) LIKE ? ESCAPE '\\'
)`;

function compileClause(
  clause: FilterClause,
  now: number,
  catalog: Catalog,
  warnings: string[]
): { cond: string; params: unknown[] } | null {
  switch (clause.dim) {
    case "group": {
      let ids = clause.ids;
      if (catalog.groupIds) {
        const missing = ids.filter((id) => !catalog.groupIds!.has(id));
        if (missing.length) {
          warnings.push(`group:${missing.join(",")} no longer exists`);
        }
        ids = ids.filter((id) => catalog.groupIds!.has(id));
      }
      if (ids.length === 0) return null;
      const marks = ids.map(() => "?").join(",");
      return {
        cond: `c.id IN (
          SELECT gm.contact_id FROM group_members gm WHERE gm.group_id IN (
            WITH RECURSIVE gtree(id) AS (
              SELECT id FROM groups WHERE id IN (${marks})
              UNION
              SELECT g.id FROM groups g JOIN gtree t ON g.parent_id = t.id
            ) SELECT id FROM gtree
          )
        )`,
        params: ids,
      };
    }
    case "tag": {
      let ids = clause.ids;
      if (catalog.tagIds) {
        const missing = ids.filter((id) => !catalog.tagIds!.has(id));
        if (missing.length) {
          warnings.push(`tag:${missing.join(",")} no longer exists`);
        }
        ids = ids.filter((id) => catalog.tagIds!.has(id));
      }
      if (ids.length === 0) return null;
      const marks = ids.map(() => "?").join(",");
      return {
        cond: `c.id IN (SELECT contact_id FROM contact_tags WHERE tag_id IN (${marks}))`,
        params: ids,
      };
    }
    case "lastInteraction": {
      if (clause.op === "never") {
        return { cond: "c.last_interaction_at IS NULL", params: [] };
      }
      const at = clause.at ?? now;
      return clause.op === "before"
        ? {
            cond: "c.last_interaction_at IS NOT NULL AND c.last_interaction_at <= ?",
            params: [at],
          }
        : { cond: "c.last_interaction_at >= ?", params: [at] };
    }
    case "titleContains":
      return {
        cond: "LOWER(COALESCE(c.title,'')) LIKE ? ESCAPE '\\'",
        params: [likeParam(clause.value)],
      };
    case "company": {
      const p = likeParam(clause.value);
      switch (clause.mode) {
        case "current":
          return { cond: COMPANY_MATCH_CURRENT, params: [p, p] };
        case "past":
          return { cond: COMPANY_MATCH_PAST, params: [p] };
        case "any":
          return {
            cond: `(${COMPANY_MATCH_CURRENT} OR ${COMPANY_MATCH_PAST})`,
            params: [p, p, p],
          };
        case "ex":
          // Ex-employees: worked there before, not there now (SPEC §7 AC).
          return {
            cond: `(${COMPANY_MATCH_PAST} AND NOT ${COMPANY_MATCH_CURRENT})`,
            params: [p, p, p],
          };
      }
      break;
    }
    case "educationContains": {
      const p = likeParam(clause.value);
      return {
        cond: `EXISTS (SELECT 1 FROM education e WHERE e.contact_id = c.id AND (
          LOWER(e.school) LIKE ? ESCAPE '\\'
          OR LOWER(COALESCE(e.degree,'')) LIKE ? ESCAPE '\\'
          OR LOWER(COALESCE(e.field,'')) LIKE ? ESCAPE '\\'))`,
        params: [p, p, p],
      };
    }
    case "locationRadius": {
      if (!catalog.geocoderConfigured) {
        // SPEC §7 edge case: no geocoder → the filter is disabled with an
        // explanation, never silently empty.
        warnings.push("locationRadius skipped — no geocoder configured");
        return null;
      }
      // Bounding box in SQL; the executor refines with haversine app-side
      // (SCHEMA.md filter map — no R-tree needed at this scale).
      const dLat = clause.km / 111.32;
      const dLng =
        clause.km / (111.32 * Math.max(0.087, Math.cos((clause.lat * Math.PI) / 180)));
      return {
        cond: `(c.location_lat BETWEEN ? AND ? AND c.location_lng BETWEEN ? AND ?)`,
        params: [
          clause.lat - dLat,
          clause.lat + dLat,
          clause.lng - dLng,
          clause.lng + dLng,
        ],
      };
    }
    case "hasLinkedin":
      return {
        cond: `${clause.value ? "" : "NOT "}EXISTS (SELECT 1 FROM contact_socials s WHERE s.contact_id = c.id AND s.platform = 'linkedin')`,
        params: [],
      };
    case "createdAt": {
      const conds: string[] = [];
      const params: unknown[] = [];
      if (clause.from !== undefined) {
        conds.push("c.created_at >= ?");
        params.push(clause.from);
      }
      if (clause.to !== undefined) {
        conds.push("c.created_at <= ?");
        params.push(clause.to);
      }
      if (conds.length === 0) return null;
      return { cond: `(${conds.join(" AND ")})`, params };
    }
    case "starred":
      return { cond: `c.starred = ${clause.value ? 1 : 0}`, params: [] };
    case "archived":
      return {
        cond: clause.value
          ? "c.archived_at IS NOT NULL"
          : "c.archived_at IS NULL",
        params: [],
      };
    case "cadence":
      return {
        cond:
          clause.value === "set"
            ? "c.cadence_days IS NOT NULL"
            : "c.cadence_days IS NULL",
        params: [],
      };
    case "dueStatus":
      switch (clause.value) {
        case "due":
          return {
            cond: "c.next_touch_at IS NOT NULL AND c.next_touch_at <= ?",
            params: [now],
          };
        case "overdue":
          return {
            cond: "c.next_touch_at IS NOT NULL AND c.next_touch_at <= ?",
            params: [now - DAY_MS],
          };
        case "not_due":
          return {
            cond: "(c.next_touch_at IS NULL OR c.next_touch_at > ?)",
            params: [now],
          };
      }
      break;
    case "customField": {
      if (catalog.customFieldIds && !catalog.customFieldIds.has(clause.fieldId)) {
        warnings.push(`customField:${clause.fieldId} no longer exists`);
        return null;
      }
      const base = `EXISTS (SELECT 1 FROM custom_field_values v
        WHERE v.contact_id = c.id AND v.custom_field_id = ? AND `;
      switch (clause.op) {
        case "contains":
          return {
            cond: `${base}LOWER(COALESCE(v.value_text,'')) LIKE ? ESCAPE '\\')`,
            params: [clause.fieldId, likeParam(String(clause.value))],
          };
        case "equals":
          return typeof clause.value === "number"
            ? {
                cond: `${base}v.value_number = ?)`,
                params: [clause.fieldId, clause.value],
              }
            : {
                cond: `${base}LOWER(COALESCE(v.value_text,'')) = LOWER(?))`,
                params: [clause.fieldId, clause.value],
              };
        case "gt":
          return {
            cond: `${base}v.value_number > ?)`,
            params: [clause.fieldId, clause.value],
          };
        case "lt":
          return {
            cond: `${base}v.value_number < ?)`,
            params: [clause.fieldId, clause.value],
          };
        case "before":
          return {
            cond: `${base}v.value_date <= ?)`,
            params: [clause.fieldId, clause.value],
          };
        case "after":
          return {
            cond: `${base}v.value_date >= ?)`,
            params: [clause.fieldId, clause.value],
          };
        case "includes":
          // multi_select stores a JSON array of strings.
          return {
            cond: `${base}COALESCE(v.value_json,'') LIKE ? ESCAPE '\\')`,
            params: [
              clause.fieldId,
              `%"${String(clause.value).replaceAll(/[%_\\]/g, (c) => `\\${c}`)}"%`,
            ],
          };
      }
    }
  }
  return null;
}

function orderBy(sort: SortSpec): string {
  switch (sort.key) {
    case "name":
      return `c.display_name COLLATE NOCASE ${sort.dir}`;
    case "company":
      return `c.company COLLATE NOCASE ${sort.dir}, c.display_name COLLATE NOCASE ASC`;
    case "recent":
      return `c.created_at ${sort.dir}`;
    case "lastInteraction":
      return `c.last_interaction_at ${sort.dir === "asc" ? "ASC NULLS FIRST" : "DESC NULLS LAST"}`;
    case "nextTouch":
      return `c.next_touch_at ${sort.dir === "asc" ? "ASC NULLS LAST" : "DESC NULLS LAST"}`;
  }
}

/**
 * Compile to `SELECT c.* FROM contacts c WHERE … ORDER BY …`. Unless the
 * filter explicitly asks about archived contacts, results are active-only.
 */
export function compileFilter(
  filter: FilterSet,
  opts: { now: number; sort?: SortSpec; catalog?: Catalog }
): Compiled {
  const warnings: string[] = [];
  const catalog = opts.catalog ?? {};
  const conds: string[] = [];
  const params: unknown[] = [];
  let radius: Compiled["radius"] = null;

  for (const clause of filter.clauses) {
    const compiled = compileClause(clause, opts.now, catalog, warnings);
    if (!compiled) continue;
    conds.push(compiled.cond);
    params.push(...compiled.params);
    if (clause.dim === "locationRadius" && catalog.geocoderConfigured) {
      radius = { lat: clause.lat, lng: clause.lng, km: clause.km };
    }
  }
  if (!filter.clauses.some((cl) => cl.dim === "archived")) {
    conds.push("c.archived_at IS NULL");
  }

  const where = conds.length ? conds.join("\n  AND ") : "1=1";
  return {
    sql: `SELECT c.* FROM contacts c WHERE ${where} ORDER BY ${orderBy(opts.sort ?? DEFAULT_SORT)}`,
    params,
    warnings,
    radius,
  };
}

/** Haversine km — the executor's radius refinement. */
export function haversineKm(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number
): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLng = (bLng - aLng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}
