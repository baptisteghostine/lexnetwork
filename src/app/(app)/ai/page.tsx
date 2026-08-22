import { AiPanel } from "@/components/ai-panel";
import { AskPanel } from "@/components/ask-panel";
import { requireAuth } from "@/lib/auth";
import { readAiAudit, readSuggestions } from "@/server/ai";
import { aiEnabled } from "@/server/ai-client";

export const dynamic = "force-dynamic";

export default async function AiPage() {
  // Pages guard themselves — see contacts/page.tsx for why.
  await requireAuth();
  const enabled = aiEnabled();
  const suggestions = enabled ? await readSuggestions() : [];
  const audit = await readAiAudit();

  return (
    <div>
      <header className="flex items-center justify-between border-b border-border px-5 py-2.5">
        <h1 className="text-sm font-semibold">
          AI
          {suggestions.length > 0 && (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {suggestions.length} suggestion{suggestions.length === 1 ? "" : "s"} to review
            </span>
          )}
        </h1>
      </header>
      {!enabled ? (
        <div className="max-w-2xl space-y-2 px-5 py-4 text-sm text-muted-foreground">
          <p>
            AI features are off. Set <code>GROQ_API_KEY</code> and{" "}
            <code>GROQ_MODEL</code> (free tier at console.groq.com — e.g.{" "}
            <code>openai/gpt-oss-120b</code>), or{" "}
            <code>ANTHROPIC_API_KEY</code> and <code>ANTHROPIC_MODEL</code>,
            in the environment to enable natural-language search, tag
            suggestions, conversation starters, and note summaries.
          </p>
          <p>
            Everything below still shows the audit trail of past calls, if
            any.
          </p>
        </div>
      ) : null}
      {enabled && <AskPanel />}
      <AiPanel enabled={enabled} suggestions={suggestions} audit={audit} />
    </div>
  );
}
