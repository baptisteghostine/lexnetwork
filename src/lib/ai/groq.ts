// OpenAI-compatible adapters (SPEC §11): Groq (owner-amended 2026-08-20),
// Gemini (owner-amended 2026-09-20) and OpenAI itself (owner-amended
// 2026-09-26) all expose the same chat/completions shape, so one adapter
// implements the AiClientLike surface the call core consumes for all. No SDK — one endpoint, plain
// JSON, through the outbound allowlist. Everything downstream (one
// ai_calls row per call, Zod validation, retry-on-invalid) is unchanged
// and provider-blind.

import type { AiClientLike, AiResponseLike } from "./call";

export const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
export const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
export const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";

/** The per-provider differences — everything else is the same request. */
export type OpenAiCompatProvider = {
  name: "Groq" | "Gemini" | "OpenAI";
  endpoint: string;
  /** Groq follows current OpenAI naming; Gemini's compatibility layer takes the classic one. */
  maxTokensParam: "max_completion_tokens" | "max_tokens";
  /** OpenAI's `strict` flag; Gemini's layer documents json_schema without it. */
  strictSchema: boolean;
  /** Free tiers hit per-minute/day caps as a matter of course; say so in the error. */
  freeTier: boolean;
};

export const GROQ: OpenAiCompatProvider = {
  name: "Groq",
  endpoint: GROQ_ENDPOINT,
  maxTokensParam: "max_completion_tokens",
  strictSchema: true,
  freeTier: true,
};

export const GEMINI: OpenAiCompatProvider = {
  name: "Gemini",
  endpoint: GEMINI_ENDPOINT,
  maxTokensParam: "max_tokens",
  strictSchema: false,
  freeTier: true,
};

export const OPENAI: OpenAiCompatProvider = {
  name: "OpenAI",
  endpoint: OPENAI_ENDPOINT,
  maxTokensParam: "max_completion_tokens",
  strictSchema: true,
  freeTier: false,
};

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
export function toOpenAiBody(
  params: Record<string, unknown>,
  provider: OpenAiCompatProvider = GROQ
): Record<string, unknown> {
  const messages: { role: string; content: unknown }[] = [];
  if (typeof params.system === "string" && params.system) {
    messages.push({ role: "system", content: params.system });
  }
  for (const m of (params.messages as { role: string; content: unknown }[]) ?? []) {
    messages.push(m);
  }
  const body: Record<string, unknown> = {
    model: params.model,
    [provider.maxTokensParam]: params.max_tokens,
    messages,
  };
  // {type:"json_schema", schema} (Anthropic output_config.format) →
  // {type:"json_schema", json_schema:{name, schema, strict}} (OpenAI).
  const format = (params.output_config as { format?: Record<string, unknown> } | undefined)
    ?.format;
  if (format && format.type === "json_schema" && format.schema) {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: "output",
        schema: format.schema,
        ...(provider.strictSchema ? { strict: true } : {}),
      },
    };
  }
  return body;
}

export const toGroqBody = (params: Record<string, unknown>) => toOpenAiBody(params, GROQ);

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
 * provider's allowlist entry.
 */
export function openAiCompatClient(opts: {
  provider: OpenAiCompatProvider;
  apiKey: string;
  fetcher: FetchLike;
}): AiClientLike {
  const { provider } = opts;
  return {
    messages: {
      async create(params) {
        const res = await opts.fetcher(provider.endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${opts.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(toOpenAiBody(params, provider)),
        });
        const raw: unknown = await res.json().catch(() => ({}));
        // Gemini wraps error bodies in a one-element array.
        const json = (Array.isArray(raw) ? raw[0] : raw) as GroqResponse;
        if (!res.ok) {
          // 429 = the free tier's per-minute/day caps; say so plainly.
          const detail = json?.error?.message ?? `HTTP ${res.status}`;
          throw new Error(
            res.status === 429
              ? `${provider.name} rate limit hit${provider.freeTier ? " (free tier)" : ""}: ${detail}`
              : `${provider.name} request failed: ${detail}`
          );
        }
        return toAiResponse(json);
      },
    },
  };
}

export const groqClient = (opts: { apiKey: string; fetcher: FetchLike }) =>
  openAiCompatClient({ ...opts, provider: GROQ });

export const geminiClient = (opts: { apiKey: string; fetcher: FetchLike }) =>
  openAiCompatClient({ ...opts, provider: GEMINI });

export const openAiClient = (opts: { apiKey: string; fetcher: FetchLike }) =>
  openAiCompatClient({ ...opts, provider: OPENAI });
