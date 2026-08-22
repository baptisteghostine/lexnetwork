// "Ask your network" (SPEC §11, owner request 2026-08-20): the model
// ranks and argues over a candidate shortlist the DATABASE selected —
// it never picks from people it wasn't shown, enforced by validating
// every recommended id against the sent set (same invented-reference
// rejection the NL search uses for filter fields).

export type AskCandidate = {
  id: number;
  name: string;
  title: string | null;
  company: string | null;
  location: string | null;
  tags: string[];
  /** Whole days since the last counting interaction; null = never. */
  lastContactDays: number | null;
  /** "Title @ Company (2019–2022)" lines, newest first, max 2. */
  history: string[];
  starred: boolean;
};

export const ASK_SYSTEM = [
  "You advise the owner of a personal professional network.",
  "You are given their question and a numbered list of candidate contacts pulled from their own database.",
  "Recommend ONLY people from the candidate list, referenced by their exact id.",
  "Rank by how directly each person helps with the stated goal; weigh title, company, work history, tags, and how recently the owner spoke to them (a warm contact beats an equally relevant cold one).",
  "Give a concrete, specific reason per pick — what to ask them for and why they can deliver. Never restate their job title as the reason.",
  "If few candidates genuinely fit, return fewer picks and say so in the summary. Do not pad.",
].join(" ");

export function buildAskPrompt(
  question: string,
  candidates: AskCandidate[]
): string {
  const lines = candidates.map((c) => {
    const parts = [
      `#${c.id} ${c.name}`,
      [c.title, c.company].filter(Boolean).join(" @ ") || "no title on file",
      c.location ?? undefined,
      c.tags.length > 0 ? `tags: ${c.tags.join(", ")}` : undefined,
      c.lastContactDays === null
        ? "never spoken"
        : `last contact ${c.lastContactDays}d ago`,
      c.history.length > 0 ? `history: ${c.history.join("; ")}` : undefined,
      c.starred ? "starred" : undefined,
    ].filter(Boolean);
    return parts.join(" — ");
  });
  return `Question: ${question}\n\nCandidates:\n${lines.join("\n")}`;
}

export function askOutputFormat(): Record<string, unknown> {
  return {
    type: "json_schema",
    schema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        picks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              contactId: { type: "integer" },
              reason: { type: "string" },
            },
            required: ["contactId", "reason"],
            additionalProperties: false,
          },
        },
      },
      required: ["summary", "picks"],
      additionalProperties: false,
    },
  };
}

export type AskAnswer = {
  summary: string;
  picks: { contactId: number; reason: string }[];
};

export const MAX_PICKS = 8;

export function validateAskAnswer(
  raw: unknown,
  allowedIds: Set<number>
): { ok: true; answer: AskAnswer } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, errors: ["response was not an object"] };
  }
  const obj = raw as Record<string, unknown>;
  const summary =
    typeof obj.summary === "string" ? obj.summary.trim().slice(0, 2000) : null;
  if (summary === null) errors.push("summary must be a string");

  const picks: AskAnswer["picks"] = [];
  if (!Array.isArray(obj.picks)) {
    errors.push("picks must be an array");
  } else {
    const seen = new Set<number>();
    for (const p of obj.picks) {
      const pick = p as Record<string, unknown>;
      const id = pick?.contactId;
      const reason = pick?.reason;
      if (typeof id !== "number" || !Number.isInteger(id)) {
        errors.push("pick contactId must be an integer");
        continue;
      }
      if (!allowedIds.has(id)) {
        // The load-bearing check: the model may not invent people.
        errors.push(`contactId ${id} was not in the candidate list`);
        continue;
      }
      if (seen.has(id)) continue;
      if (typeof reason !== "string" || reason.trim().length === 0) {
        errors.push(`pick ${id} needs a reason`);
        continue;
      }
      seen.add(id);
      picks.push({ contactId: id, reason: reason.trim().slice(0, 600) });
      if (picks.length >= MAX_PICKS) break;
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, answer: { summary: summary!, picks } };
}
