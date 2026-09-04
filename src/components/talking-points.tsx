"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

// AI talking points inside a pre-meeting brief (SPEC §9e/§11): shown
// with the same "AI-drafted, check first" framing as openers, each with a
// copy button. Never sent anywhere.
export function TalkingPoints({ points }: { points: string[] }) {
  const [copied, setCopied] = useState<number | null>(null);
  if (points.length === 0) return null;
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
        Talking points{" "}
        <span className="normal-case tracking-normal italic">
          — AI-drafted, check before you use them
        </span>
      </p>
      <ol className="mt-1 space-y-1">
        {points.map((p, i) => (
          <li key={i} className="flex items-start gap-2 text-[12px] leading-relaxed">
            <span className="flex-1">{p}</span>
            <button
              type="button"
              aria-label="Copy talking point"
              className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
              onClick={async () => {
                await navigator.clipboard.writeText(p);
                setCopied(i);
                setTimeout(() => setCopied(null), 1500);
              }}
            >
              {copied === i ? (
                <Check className="size-3 text-emerald-500" />
              ) : (
                <Copy className="size-3" />
              )}
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
