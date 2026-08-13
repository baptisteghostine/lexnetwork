import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { runAiCall, type AiClientLike, type AiResponseLike } from "@/lib/ai/call";

// SPEC §11 AC: every AI feature use adds exactly one ai_calls row with
// token counts and latency — success, refusal, and hard error alike.
// Runs against the real migrations on an in-memory DB with a fake client.

const MIGRATIONS_DIR = path.join(__dirname, "../../../src/db/migrations");

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  const journal = JSON.parse(
    fs.readFileSync(path.join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8")
  ) as { entries: { tag: string }[] };
  for (const entry of journal.entries) {
    const sqlText = fs.readFileSync(
      path.join(MIGRATIONS_DIR, `${entry.tag}.sql`),
      "utf8"
    );
    for (const stmt of sqlText.split("--> statement-breakpoint")) {
      if (stmt.trim()) db.exec(stmt);
    }
  }
});

function fakeClient(
  respond: (params: Record<string, unknown>) => Promise<AiResponseLike>
): AiClientLike {
  return { messages: { create: respond } };
}

function ticker(start: number, step: number): () => number {
  let t = start - step;
  return () => (t += step);
}

function rows(): Record<string, unknown>[] {
  return db.prepare("SELECT * FROM ai_calls ORDER BY id").all() as Record<
    string,
    unknown
  >[];
}

describe("runAiCall", () => {
  it("logs exactly one row with tokens and latency on success", async () => {
    const result = await runAiCall({
      db,
      client: fakeClient(async () => ({
        content: [{ type: "text", text: '{"v":1,"clauses":[]}' }],
        usage: { input_tokens: 321, output_tokens: 45 },
        stop_reason: "end_turn",
      })),
      feature: "nl_search",
      model: "test-model",
      system: "sys",
      prompt: "find people",
      maxTokens: 1024,
      now: ticker(1000, 250),
    });

    expect(result.ok).toBe(true);
    const logged = rows();
    expect(logged).toHaveLength(1);
    expect(logged[0].feature).toBe("nl_search");
    expect(logged[0].model).toBe("test-model");
    expect(logged[0].status).toBe("success");
    expect(logged[0].input_tokens).toBe(321);
    expect(logged[0].output_tokens).toBe(45);
    expect(logged[0].latency_ms).toBe(250);
    // Prompt stored verbatim for the audit screen.
    expect(JSON.parse(logged[0].prompt as string)).toEqual({
      system: "sys",
      prompt: "find people",
    });
  });

  it("logs exactly one error row when the API call throws", async () => {
    const result = await runAiCall({
      db,
      client: fakeClient(async () => {
        throw new Error("rate limited");
      }),
      feature: "openers",
      model: "test-model",
      prompt: "p",
      maxTokens: 512,
    });
    expect(result.ok).toBe(false);
    const logged = rows();
    expect(logged).toHaveLength(1);
    expect(logged[0].status).toBe("error");
    expect(logged[0].error).toContain("rate limited");
  });

  it("treats a refusal as a logged error, not a success", async () => {
    const result = await runAiCall({
      db,
      client: fakeClient(async () => ({
        content: [],
        usage: { input_tokens: 10, output_tokens: 0 },
        stop_reason: "refusal",
      })),
      feature: "summarize",
      model: "test-model",
      prompt: "p",
      maxTokens: 512,
    });
    expect(result.ok).toBe(false);
    expect(rows()[0].status).toBe("error");
  });

  it("passes the structured output format through to the request", async () => {
    let seen: Record<string, unknown> | null = null;
    await runAiCall({
      db,
      client: fakeClient(async (params) => {
        seen = params;
        return { content: [{ type: "text", text: "{}" }] };
      }),
      feature: "auto_tag",
      model: "test-model",
      prompt: "p",
      maxTokens: 512,
      outputFormat: { type: "json_schema", schema: { type: "object" } },
    });
    expect(seen).not.toBeNull();
    expect(seen!.output_config).toEqual({
      format: { type: "json_schema", schema: { type: "object" } },
    });
    expect(seen!.model).toBe("test-model");
  });
});
