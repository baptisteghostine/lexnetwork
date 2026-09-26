import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import { rawDb } from "@/db/client";
import {
  runAiCall,
  type AiCallResult,
  type AiClientLike,
  type AiFeature,
  type AiResponseLike,
} from "@/lib/ai/call";
import { geminiClient, groqClient, openAiClient } from "@/lib/ai/groq";
import { outboundFetch } from "@/lib/net/fetch";

// Server glue for the AI layer (SPEC §11): resolves configuration from the
// environment (model always from env, never hardcoded — CLAUDE.md), builds
// the provider client on top of the outbound-host allowlist, and funnels
// every call through lib/ai/call's logging core.
//
// Four providers: Anthropic (ANTHROPIC_API_KEY + ANTHROPIC_MODEL), OpenAI
// (OPENAI_API_KEY + OPENAI_MODEL; owner amendment 2026-09-26, paid), Groq's
// OpenAI-compatible API (GROQ_API_KEY + GROQ_MODEL — free tier, e.g.
// openai/gpt-oss-120b; owner amendment 2026-08-20) and Gemini's
// OpenAI-compatible API (GEMINI_API_KEY + GEMINI_MODEL — free tier, e.g.
// gemini-3.6-flash; owner amendment 2026-09-20). When several are
// configured, AI_PROVIDER=openai|gemini|groq|anthropic picks; otherwise
// the most recently adopted wins, since configuring one expresses the
// intent to use it.

export type AiConfig = {
  provider: "anthropic" | "groq" | "gemini" | "openai";
  apiKey: string;
  model: string;
};

/** null = AI affordances hidden, not erroring (SPEC §11 edge case). */
export function aiConfig(): AiConfig | null {
  const groq =
    process.env.GROQ_API_KEY && process.env.GROQ_MODEL
      ? {
          provider: "groq" as const,
          apiKey: process.env.GROQ_API_KEY,
          model: process.env.GROQ_MODEL,
        }
      : null;
  const anthropic =
    process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_MODEL
      ? {
          provider: "anthropic" as const,
          apiKey: process.env.ANTHROPIC_API_KEY,
          model: process.env.ANTHROPIC_MODEL,
        }
      : null;
  const gemini =
    process.env.GEMINI_API_KEY && process.env.GEMINI_MODEL
      ? {
          provider: "gemini" as const,
          apiKey: process.env.GEMINI_API_KEY,
          model: process.env.GEMINI_MODEL,
        }
      : null;
  const openai =
    process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL
      ? {
          provider: "openai" as const,
          apiKey: process.env.OPENAI_API_KEY,
          model: process.env.OPENAI_MODEL,
        }
      : null;
  const forced = process.env.AI_PROVIDER;
  if (forced === "openai") return openai;
  if (forced === "gemini") return gemini;
  if (forced === "groq") return groq;
  if (forced === "anthropic") return anthropic;
  return openai ?? gemini ?? groq ?? anthropic;
}

export function aiEnabled(): boolean {
  return aiConfig() !== null;
}

declare global {
  // HMR-safe singleton, same pattern as db/client.ts.
  var __roloAnthropic: Anthropic | undefined;
}

function anthropicClient(config: AiConfig): AiClientLike {
  if (!globalThis.__roloAnthropic) {
    const created = new Anthropic({
      apiKey: config.apiKey,
      // Every outbound HTTP call goes through the allowlist wrapper
      // (CLAUDE.md privacy invariant) — api.anthropic.com is on it.
      fetch: outboundFetch as typeof fetch,
    });
    if (process.env.NODE_ENV !== "production") {
      globalThis.__roloAnthropic = created;
    }
    return adaptAnthropic(created);
  }
  return adaptAnthropic(globalThis.__roloAnthropic);
}

/** Adapt the SDK's typed surface to the call core's structural interface. */
function adaptAnthropic(sdk: Anthropic): AiClientLike {
  return {
    messages: {
      async create(params) {
        return (await sdk.messages.create(
          params as unknown as Anthropic.MessageCreateParamsNonStreaming
        )) as unknown as AiResponseLike;
      },
    },
  };
}

function providerClient(config: AiConfig): AiClientLike {
  // api.groq.com and generativelanguage.googleapis.com are on the outbound
  // allowlist alongside the other owner-configured integrations.
  if (config.provider === "groq") {
    return groqClient({ apiKey: config.apiKey, fetcher: outboundFetch });
  }
  if (config.provider === "gemini") {
    return geminiClient({ apiKey: config.apiKey, fetcher: outboundFetch });
  }
  if (config.provider === "openai") {
    return openAiClient({ apiKey: config.apiKey, fetcher: outboundFetch });
  }
  return anthropicClient(config);
}

/**
 * One logged model call. Throws only on missing configuration — callers
 * gate on aiEnabled() first; model/API errors come back as {ok: false}.
 */
export async function callAi(opts: {
  feature: AiFeature;
  system?: string;
  prompt: string;
  maxTokens: number;
  outputFormat?: Record<string, unknown>;
}): Promise<AiCallResult> {
  const config = aiConfig();
  if (!config) {
    throw new Error(
      "AI is not configured — set OPENAI_API_KEY + OPENAI_MODEL, GEMINI_API_KEY + GEMINI_MODEL, GROQ_API_KEY + GROQ_MODEL, or ANTHROPIC_API_KEY + ANTHROPIC_MODEL."
    );
  }
  return runAiCall({
    db: rawDb,
    client: providerClient(config),
    feature: opts.feature,
    model: config.model,
    system: opts.system,
    prompt: opts.prompt,
    maxTokens: opts.maxTokens,
    outputFormat: opts.outputFormat,
  });
}
