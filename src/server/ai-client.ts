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
import { outboundFetch } from "@/lib/net/fetch";

// Server glue for the AI layer (SPEC §11): resolves configuration from the
// environment (CLAUDE.md: model comes from ANTHROPIC_MODEL, never
// hardcoded), builds the SDK client on top of the outbound-host allowlist,
// and funnels every call through lib/ai/call's logging core.

export type AiConfig = { apiKey: string; model: string };

/** null = AI affordances hidden, not erroring (SPEC §11 edge case). */
export function aiConfig(): AiConfig | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL;
  if (!apiKey || !model) return null;
  return { apiKey, model };
}

export function aiEnabled(): boolean {
  return aiConfig() !== null;
}

declare global {
  // HMR-safe singleton, same pattern as db/client.ts.
  var __roloAnthropic: Anthropic | undefined;
}

function client(config: AiConfig): Anthropic {
  if (globalThis.__roloAnthropic) return globalThis.__roloAnthropic;
  const created = new Anthropic({
    apiKey: config.apiKey,
    // Every outbound HTTP call goes through the allowlist wrapper
    // (CLAUDE.md privacy invariant) — api.anthropic.com is on it.
    fetch: outboundFetch as typeof fetch,
  });
  if (process.env.NODE_ENV !== "production") {
    globalThis.__roloAnthropic = created;
  }
  return created;
}

/** Adapt the SDK's typed surface to the call core's structural interface. */
function asAiClient(sdk: Anthropic): AiClientLike {
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
      "AI is not configured — set ANTHROPIC_API_KEY and ANTHROPIC_MODEL."
    );
  }
  return runAiCall({
    db: rawDb,
    client: asAiClient(client(config)),
    feature: opts.feature,
    model: config.model,
    system: opts.system,
    prompt: opts.prompt,
    maxTokens: opts.maxTokens,
    outputFormat: opts.outputFormat,
  });
}
