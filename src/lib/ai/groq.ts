// Groq adapter (SPEC §11, owner-amended 2026-08-20): implements the same
// AiClientLike surface the call core consumes, over Groq's
// OpenAI-compatible chat/completions API. No SDK — one endpoint, plain
// JSON, through the outbound allowlist. Everything downstream (one
// ai_calls row per call, Zod validation, retry-on-invalid) is unchanged
// and provider-blind.

import type { AiClientLike, AiResponseLike } from "./call";

export const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

type GroqResponse = {
  choices?: {
    message?: { content?: string | null; refusal?: string | null };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
};

/**
 * Translate the call core's Anthropic-shaped params into an OpenAI-style
 * request body. Exported for tests — the translation rules ARE the
 * adapter's contract.
 */
export function toGroqBody(params: Record<string, unknown>): Record<string, unknown> {
  const messages: { role: string; content: unknown }[] = [];
  if (typeof params.system === "string" && params.system) {
    messages.push({ role: "system", content: params.system });
  }
  for (const m of (params.messages as { role: string; content: unknown }[]) ?? []) {
    messages.push(m);
  }
  const body: Record<string, unknown> = {
    model: params.model,
    max_completion_tokens: params.max_tokens,
    messages,
  };
  // {type:"json_schema", schema} (Anthropic output_config.format) →
  // {type:"json_schema", json_schema:{name, schema, strict}} (OpenAI).
  const format = (params.output_config as { format?: Record<string, unknown> } | undefined)
    ?.format;
  if (format && format.type === "json_schema" && format.schema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "output", schema: format.schema, strict: true },
    };
  }
  return body;
}

export function toAiResponse(groq: GroqResponse): AiResponseLike {
  const choice = groq.choices?.[0];
  if (choice?.message?.refusal) {
    return {
      content: [{ type: "text", text: choice.message.refusal }],
      usage: {
        input_tokens: groq.usage?.prompt_tokens,
        output_tokens: groq.usage?.completion_tokens,
      },
      stop_reason: "refusal",
    };
  }
  return {
    content: [{ type: "text", text: choice?.message?.content ?? "" }],
    usage: {
      input_tokens: groq.usage?.prompt_tokens,
      output_tokens: groq.usage?.completion_tokens,
    },
    stop_reason: choice?.finish_reason ?? null,
  };
}

/**
 * The client the call core consumes. `fetcher` is injected so tests run
 * without a network; production passes outboundFetch, which enforces the
 * api.groq.com allowlist entry.
 */
export function groqClient(opts: {
  apiKey: string;
  fetcher: FetchLike;
}): AiClientLike {
  return {
    messages: {
      async create(params) {
        const res = await opts.fetcher(GROQ_ENDPOINT, {
          method: "POST",
          headers: {
            authorization: `Bearer ${opts.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(toGroqBody(params)),
        });
        const json = (await res.json().catch(() => ({}))) as GroqResponse;
        if (!res.ok) {
          // 429 = the free tier's per-minute/day caps; say so plainly.
          const detail = json.error?.message ?? `HTTP ${res.status}`;
          throw new Error(
            res.status === 429
              ? `Groq rate limit hit (free tier): ${detail}`
              : `Groq request failed: ${detail}`
          );
        }
        return toAiResponse(json);
      },
    },
  };
}
