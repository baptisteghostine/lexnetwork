// Natural-language search → filter JSON (SPEC §11). Pure: prompt builder,
// constrained-output schema, and the strict validator that stands between
// the model and the filter engine. The model only ever sees the filter
// schema plus the owner's tag/group/custom-field names — never contact
// data. Unknown dimensions or ids are rejected here, never executed.

import { z } from "zod";

import type { FilterClause, FilterSet } from "@/lib/filters/types";

export type FilterCatalog = {
  tags: { id: number; name: string }[];
  groups: { id: number; name: string }[];
  customFields: { id: number; name: string; kind: string }[];
};

// ---------- prompt ----------

export function buildNlSearchSystem(
  catalog: FilterCatalog,
  nowMs: number
): string {
  const lines: string[] = [
    "You translate a natural-language query about the owner's personal contacts into a filter JSON object. You never see contact data — only the filter schema and the owner's own tag/group/field names below.",
    "",
    `Today's date: ${new Date(nowMs).toISOString().slice(0, 10)} (epoch ms: ${nowMs}). Timestamps in clauses are unix epoch milliseconds.`,
    "",
    "Filter semantics: clauses AND together; ids inside one clause OR together.",
    "Available clause shapes:",
    `- {"dim":"tag","ids":[...]} — tag ids from the list below`,
    `- {"dim":"group","ids":[...]} — group ids from the list below (includes subgroups)`,
    `- {"dim":"lastInteraction","op":"before"|"after"|"never","at":<epoch ms or null>} — 'never' needs no 'at'`,
    `- {"dim":"titleContains","value":"..."} — matches job title OR company text`,
    `- {"dim":"company","mode":"current"|"past"|"ex"|"any","value":"..."} — 'ex' = past but not current`,
    `- {"dim":"educationContains","value":"..."}`,
    `- {"dim":"locationRadius","lat":<number>,"lng":<number>,"km":<number>} — use your knowledge of city coordinates`,
    `- {"dim":"hasLinkedin","value":true|false}`,
    `- {"dim":"createdAt","from":<epoch ms or null>,"to":<epoch ms or null>}`,
    `- {"dim":"starred","value":true|false}`,
    `- {"dim":"archived","value":true|false}`,
    `- {"dim":"cadence","value":"set"|"unset"}`,
    `- {"dim":"dueStatus","value":"due"|"overdue"|"not_due"}`,
    `- {"dim":"customField","fieldId":<id>,"op":"contains"|"equals"|"gt"|"lt"|"before"|"after"|"includes","value":<string or number>}`,
    "",
    `Owner's tags: ${JSON.stringify(catalog.tags)}`,
    `Owner's groups: ${JSON.stringify(catalog.groups)}`,
    `Owner's custom fields: ${JSON.stringify(catalog.customFields)}`,
    "",
    "Rules:",
    "- Use only ids that appear in the lists above. Never invent ids, dimensions, or fields.",
    "- Map only what the query actually expresses. If a concept has no matching clause shape (e.g. \"who owes me money\"), leave it out.",
    '- If nothing in the query maps to any clause, return {"v":1,"clauses":[]}.',
    "- Vague dates resolve conservatively: \"since spring\" ≈ March 20 of the current year, \"recently\" ≈ 30 days.",
    'Respond with the filter JSON object only: {"v":1,"clauses":[...]}.',
  ];
  return lines.join("\n");
}

// ---------- constrained output schema (output_config.format) ----------

const obj = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const lit = (...values: string[]) => ({ type: "string", enum: values });
const nullable = (type: string) => ({ type: [type, "null"] });

/** JSON schema handed to the API so the model can only emit filter-shaped JSON. */
export function nlSearchOutputFormat(): Record<string, unknown> {
  const clause = {
    anyOf: [
      obj({ dim: lit("tag"), ids: { type: "array", items: { type: "integer" } } }),
      obj({ dim: lit("group"), ids: { type: "array", items: { type: "integer" } } }),
      obj({ dim: lit("lastInteraction"), op: lit("before", "after", "never"), at: nullable("integer") }),
      obj({ dim: lit("titleContains"), value: { type: "string" } }),
      obj({ dim: lit("company"), mode: lit("current", "past", "ex", "any"), value: { type: "string" } }),
      obj({ dim: lit("educationContains"), value: { type: "string" } }),
      obj({ dim: lit("locationRadius"), lat: { type: "number" }, lng: { type: "number" }, km: { type: "number" } }),
      obj({ dim: lit("hasLinkedin"), value: { type: "boolean" } }),
      obj({ dim: lit("createdAt"), from: nullable("integer"), to: nullable("integer") }),
      obj({ dim: lit("starred"), value: { type: "boolean" } }),
      obj({ dim: lit("archived"), value: { type: "boolean" } }),
      obj({ dim: lit("cadence"), value: lit("set", "unset") }),
      obj({ dim: lit("dueStatus"), value: lit("due", "overdue", "not_due") }),
      obj({
        dim: lit("customField"),
        fieldId: { type: "integer" },
        op: lit("contains", "equals", "gt", "lt", "before", "after", "includes"),
        value: { type: ["string", "number"] },
      }),
    ],
  };
  return {
    type: "json_schema",
    schema: obj({
      v: { type: "integer", enum: [1] },
      clauses: { type: "array", items: clause },
    }),
  };
}

// ---------- strict validation ----------

const clauseSchema = z.discriminatedUnion("dim", [
  z.strictObject({ dim: z.literal("tag"), ids: z.array(z.number().int()).min(1) }),
  z.strictObject({ dim: z.literal("group"), ids: z.array(z.number().int()).min(1) }),
  z.strictObject({
    dim: z.literal("lastInteraction"),
    op: z.enum(["before", "after", "never"]),
    at: z.number().int().optional(),
  }),
  z.strictObject({ dim: z.literal("titleContains"), value: z.string().min(1) }),
  z.strictObject({
    dim: z.literal("company"),
    mode: z.enum(["current", "past", "ex", "any"]),
    value: z.string().min(1),
  }),
  z.strictObject({ dim: z.literal("educationContains"), value: z.string().min(1) }),
  z.strictObject({
    dim: z.literal("locationRadius"),
    lat: z.number().gte(-90).lte(90),
    lng: z.number().gte(-180).lte(180),
    km: z.number().gt(0).lte(20000),
  }),
  z.strictObject({ dim: z.literal("hasLinkedin"), value: z.boolean() }),
  z.strictObject({
    dim: z.literal("createdAt"),
    from: z.number().int().optional(),
    to: z.number().int().optional(),
  }),
  z.strictObject({ dim: z.literal("starred"), value: z.boolean() }),
  z.strictObject({ dim: z.literal("archived"), value: z.boolean() }),
  z.strictObject({ dim: z.literal("cadence"), value: z.enum(["set", "unset"]) }),
  z.strictObject({
    dim: z.literal("dueStatus"),
    value: z.enum(["due", "overdue", "not_due"]),
  }),
  z.strictObject({
    dim: z.literal("customField"),
    fieldId: z.number().int(),
    op: z.enum(["contains", "equals", "gt", "lt", "before", "after", "includes"]),
    value: z.union([z.string(), z.number()]),
  }),
]);

const filterSchema = z.strictObject({
  v: z.literal(1),
  clauses: z.array(clauseSchema),
});

/** The structured-output schema requires every property, so optionals arrive as null — drop them. */
function stripNulls(raw: unknown): unknown {
  if (Array.isArray(raw)) return raw.map(stripNulls);
  if (typeof raw === "object" && raw !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v !== null) out[k] = stripNulls(v);
    }
    return out;
  }
  return raw;
}

/** Tolerates prose/code fences around the JSON object. */
export function extractJson(text: string): unknown | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export type ValidationResult =
  | { ok: true; filter: FilterSet }
  | { ok: false; errors: string[] };

/**
 * The gate between model output and the deterministic filter engine
 * (SPEC §11 AC): schema-invalid shapes, invented dimensions/fields, and
 * ids that don't exist in the owner's data are all rejected here.
 */
export function validateAiFilter(
  raw: unknown,
  catalog: FilterCatalog
): ValidationResult {
  const parsed = filterSchema.safeParse(stripNulls(raw));
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (i) => `${i.path.join(".") || "(root)"}: ${i.message}`
      ),
    };
  }

  const tagIds = new Set(catalog.tags.map((t) => t.id));
  const groupIds = new Set(catalog.groups.map((g) => g.id));
  const fieldIds = new Set(catalog.customFields.map((f) => f.id));
  const errors: string[] = [];
  for (const clause of parsed.data.clauses) {
    if (clause.dim === "tag") {
      for (const id of clause.ids) {
        if (!tagIds.has(id)) errors.push(`tag id ${id} does not exist`);
      }
    } else if (clause.dim === "group") {
      for (const id of clause.ids) {
        if (!groupIds.has(id)) errors.push(`group id ${id} does not exist`);
      }
    } else if (clause.dim === "customField") {
      if (!fieldIds.has(clause.fieldId)) {
        errors.push(`custom field id ${clause.fieldId} does not exist`);
      }
    } else if (clause.dim === "lastInteraction") {
      if (clause.op !== "never" && clause.at === undefined) {
        errors.push(`lastInteraction op '${clause.op}' requires 'at'`);
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  return { ok: true, filter: { v: 1, clauses: parsed.data.clauses as FilterClause[] } };
}
