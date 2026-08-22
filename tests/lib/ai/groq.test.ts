import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { runAiCall } from "@/lib/ai/call";
import { GROQ_ENDPOINT, groqClient, toAiResponse, toGroqBody } from "@/lib/ai/groq";
import { isAllowedOutboundUrl } from "@/lib/net/fetch";

// SPEC §11 (owner-amended): the Groq adapter must present exactly the
// surface the call core expects, so the one-ai_calls-row-per-call
// invariant and the Zod/retry pipeline stay provider-blind.

const MIGRATIONS_DIR = path.join(__dirname, "../../../src/db/migrations");

function migratedDb(): Database.Database {
  const db = new Database(":memory:");
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
  return db;
}

describe("request translation", () => {
  it("system + user + json schema become an OpenAI-shaped body", () => {
    const body = toGroqBody({
      model: "openai/gpt-oss-120b",
      max_tokens: 500,
      system: "You are a filter compiler.",
      output_config: {
        format: { type: "json_schema", schema: { type: "object" } },
      },
      messages: [{ role: "user", content: "biotech in Boston" }],
    });
    expect(body).toEqual({
      model: "openai/gpt-oss-120b",
      max_completion_tokens: 500,
      messages: [
        { role: "system", content: "You are a filter compiler." },
        { role: "user", content: "biotech in Boston" },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "output", schema: { type: "object" }, strict: true },
      },
    });
  });

  it("omits response_format when no schema was requested", () => {
    const body = toGroqBody({
      model: "m",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(body.response_format).toBeUndefined();
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });
});

describe("response translation", () => {
  it("maps content and token usage", () => {
    expect(
      toAiResponse({
        choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 5 },
      })
    ).toEqual({
      content: [{ type: "text", text: '{"ok":true}' }],
      usage: { input_tokens: 12, output_tokens: 5 },
      stop_reason: "stop",
    });
  });

  it("maps an OpenAI refusal onto the core's refusal stop_reason", () => {
    const r = toAiResponse({
      choices: [{ message: { content: null, refusal: "cannot do that" } }],
    });
    expect(r.stop_reason).toBe("refusal");
  });
});

describe("through the call core", () => {
  it("a successful Groq call writes one success ai_calls row", async () => {
    const db = migratedDb();
    const seen: { url: string; init: RequestInit }[] = [];
    const client = groqClient({
      apiKey: "gsk_test",
      fetcher: async (url, init) => {
        seen.push({ url, init: init! });
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "three openers" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 40, completion_tokens: 9 },
          }),
          { status: 200 }
        );
      },
    });
    const result = await runAiCall({
      db,
      client,
      feature: "openers",
      model: "openai/gpt-oss-120b",
      system: "s",
      prompt: "p",
      maxTokens: 300,
    });
    expect(result.ok).toBe(true);
    expect(seen[0].url).toBe(GROQ_ENDPOINT);
    expect(new Headers(seen[0].init.headers).get("authorization")).toBe(
      "Bearer gsk_test"
    );
    const rows = db
      .prepare("SELECT feature, model, status, input_tokens, output_tokens FROM ai_calls")
      .all();
    expect(rows).toEqual([
      {
        feature: "openers",
        model: "openai/gpt-oss-120b",
        status: "success",
        input_tokens: 40,
        output_tokens: 9,
      },
    ]);
  });

  it("a 429 (free-tier cap) logs one error row naming the rate limit", async () => {
    const db = migratedDb();
    const client = groqClient({
      apiKey: "gsk_test",
      fetcher: async () =>
        new Response(
          JSON.stringify({ error: { message: "Rate limit reached" } }),
          { status: 429 }
        ),
    });
    const result = await runAiCall({
      db,
      client,
      feature: "auto_tag",
      model: "openai/gpt-oss-120b",
      prompt: "p",
      maxTokens: 100,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/rate limit/i);
    const row = db.prepare("SELECT status, error FROM ai_calls").get() as {
      status: string;
      error: string;
    };
    expect(row.status).toBe("error");
    expect(row.error).toMatch(/free tier/);
  });
});

describe("allowlist", () => {
  it("api.groq.com is an allowed outbound host", () => {
    expect(isAllowedOutboundUrl(GROQ_ENDPOINT)).toBe(true);
  });
});
