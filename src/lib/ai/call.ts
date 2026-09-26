// The AI call core (SPEC §11): every model call goes through here, and
// every call — success or error — writes exactly one ai_calls row. Takes
// the SDK client and the raw DB handle as injectables so the logging
// contract is unit-testable against an in-memory DB with a fake client.

import type { Database } from "better-sqlite3";

export type AiFeature =
  | "nl_search"
  | "auto_tag"
  | "openers"
  | "summarize"
  // Ask-your-network (owner request 2026-08-20): stage 1 compiles the
  // question to a retrieval filter, stage 2 ranks the retrieved set.
  | "ask_plan"
  | "ask_answer"
  // Pre-meeting brief talking points (SPEC §9e, owner request 2026-09-04).
  | "meeting_prep"
  // Owner request 2026-09-26: the voice guide, job-change triage, drafts
  // in the owner's voice, the iterative Ask, profile enrichment, the
  // digest narrative and post-meeting follow-up.
  | "voice"
  | "change_triage"
  | "draft"
  | "ask_step"
  | "enrich"
  | "digest"
  | "followup";

// Structural subset of @anthropic-ai/sdk's client + response — enough to
// call and to fake in tests.
export type AiResponseLike = {
  content: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string | null;
};

export type AiClientLike = {
  messages: {
    create(params: Record<string, unknown>): Promise<AiResponseLike>;
  };
};

export type AiCallResult =
  | { ok: true; text: string; callId: number }
  | { ok: false; error: string; callId: number };

function logCall(
  db: Database,
  row: {
    feature: AiFeature;
    model: string;
    prompt: string;
    response: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    latencyMs: number;
    status: "success" | "error";
    error: string | null;
    createdAt: number;
  }
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO ai_calls (feature, model, prompt, response, input_tokens, output_tokens,
           latency_ms, status, error, created_at)
         VALUES (@feature, @model, @prompt, @response, @inputTokens, @outputTokens,
           @latencyMs, @status, @error, @createdAt)`
      )
      .run(row).lastInsertRowid
  );
}

/**
 * One model call, one audit row. The prompt is stored verbatim as
 * `{system, prompt}` JSON so the audit screen shows exactly what was sent.
 */
export async function runAiCall(opts: {
  db: Database;
  client: AiClientLike;
  feature: AiFeature;
  model: string;
  system?: string;
  prompt: string;
  maxTokens: number;
  /** Optional structured-output format (output_config.format). */
  outputFormat?: Record<string, unknown>;
  now?: () => number;
}): Promise<AiCallResult> {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const storedPrompt = JSON.stringify({
    system: opts.system ?? null,
    prompt: opts.prompt,
  });

  try {
    const response = await opts.client.messages.create({
      model: opts.model,
      max_tokens: opts.maxTokens,
      ...(opts.system ? { system: opts.system } : {}),
      ...(opts.outputFormat
        ? { output_config: { format: opts.outputFormat } }
        : {}),
      messages: [{ role: "user", content: opts.prompt }],
    });

    const text = response.content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("");

    // Anthropic says "max_tokens", the OpenAI-compatible providers "length":
    // the reply was cut off at the token cap. What came back is at best
    // unparseable JSON and at worst a truncated draft presented as whole,
    // so it is logged and reported as a failure, never as a success.
    if (response.stop_reason === "max_tokens" || response.stop_reason === "length") {
      const callId = logCall(opts.db, {
        feature: opts.feature,
        model: opts.model,
        prompt: storedPrompt,
        response: text || null,
        inputTokens: response.usage?.input_tokens ?? null,
        outputTokens: response.usage?.output_tokens ?? null,
        latencyMs: now() - startedAt,
        status: "error",
        error: `Reply cut off at the ${opts.maxTokens}-token limit.`,
        createdAt: startedAt,
      });
      return { ok: false, error: "The model's reply was cut off at the token limit.", callId };
    }

    if (response.stop_reason === "refusal") {
      const callId = logCall(opts.db, {
        feature: opts.feature,
        model: opts.model,
        prompt: storedPrompt,
        response: text || null,
        inputTokens: response.usage?.input_tokens ?? null,
        outputTokens: response.usage?.output_tokens ?? null,
        latencyMs: now() - startedAt,
        status: "error",
        error: "Model declined the request (refusal).",
        createdAt: startedAt,
      });
      return { ok: false, error: "The model declined this request.", callId };
    }

    const callId = logCall(opts.db, {
      feature: opts.feature,
      model: opts.model,
      prompt: storedPrompt,
      response: text,
      inputTokens: response.usage?.input_tokens ?? null,
      outputTokens: response.usage?.output_tokens ?? null,
      latencyMs: now() - startedAt,
      status: "success",
      error: null,
      createdAt: startedAt,
    });
    return { ok: true, text, callId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const callId = logCall(opts.db, {
      feature: opts.feature,
      model: opts.model,
      prompt: storedPrompt,
      response: null,
      inputTokens: null,
      outputTokens: null,
      latencyMs: now() - startedAt,
      status: "error",
      error: message,
      createdAt: startedAt,
    });
    return { ok: false, error: message, callId };
  }
}
