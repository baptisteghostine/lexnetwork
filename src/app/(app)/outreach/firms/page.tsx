import Link from "next/link";

import { AddFirmForm, FirmRowEditor } from "@/components/firm-forms";
import { requireAuth } from "@/lib/auth";
import { EMAIL_PATTERN_EXAMPLE, isEmailPattern } from "@/lib/outreach/email-pattern";
import { employers, listFirms, tierNames } from "@/server/firms-core";

export const dynamic = "force-dynamic";

// Firms (SPEC §17): what the owner has settled about employers — the
// tier each is in, and how each forms its email addresses.

function sourceLine(source: string | null, note: string | null): string {
  if (source === "user") return "set by you";
  if (source === "agent") return note ? `from Claude: ${note}` : "from Claude";
  return "";
}

export default async function FirmsPage() {
  // Pages guard themselves — see contacts/page.tsx for why.
  await requireAuth();
  const firms = listFirms();
  const tiers = tierNames();
  // The employers most worth settling: the largest that have no record yet.
  const settled = new Set(firms.map((f) => f.companyKey));
  const suggestions = [...employers().values()]
    .filter((e) => !settled.has(e.key))
    .sort((a, b) => b.contacts - a.contacts || (a.name < b.name ? -1 : 1))
    .slice(0, 400)
    .map((e) => e.name);
  const byTier = new Map<string, typeof firms>();
  for (const f of firms) byTier.set(f.tier ?? "", [...(byTier.get(f.tier ?? "") ?? []), f]);
  const order = [...tiers.map((t) => t.tier), ...(byTier.has("") ? [""] : [])];

  return (
    <div>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-5 py-2.5">
        <h1 className="text-sm font-semibold">
          <Link href="/outreach" className="text-muted-foreground hover:text-foreground">
            Outreach
          </Link>
          <span className="mx-1.5 text-muted-foreground">/</span>
          Firms
        </h1>
        <span className="text-xs text-muted-foreground">
          {firms.length} firm{firms.length === 1 ? "" : "s"} · {tiers.length} tier{tiers.length === 1 ? "" : "s"}
        </span>
      </header>
      <div className="max-w-4xl space-y-6 px-5 py-4">
        <p className="text-xs text-muted-foreground">
          A tier says which league a firm plays in, so &ldquo;the top firms&rdquo; means something exact when Claude picks people. An
          address format lets Rolo suggest an email for someone it has none for — as a guess you accept or not, never an address
          it uses by itself. Claude can propose tiers; each proposal waits for you on the{" "}
          <Link href="/agent-activity" className="underline underline-offset-2 hover:text-foreground">
            activity page
          </Link>
          .
        </p>

        {firms.length === 0 ? (
          <p className="text-xs text-muted-foreground">No firm has a tier or an address format yet. Add one below, or ask Claude to propose tiers for your banks.</p>
        ) : (
          order.map((tier) => (
            <section key={tier || "none"} className="space-y-1.5" aria-label={tier || "No tier"}>
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {tier || "No tier"} <span className="font-normal">{byTier.get(tier)?.length ?? 0}</span>
              </h2>
              <ol className="space-y-1">
                {(byTier.get(tier) ?? []).map((f) => (
                  <li key={f.id} className="rounded-md border border-border/60 px-3 py-2" data-testid="firm-row">
                    <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                      <span className="text-[13px] font-medium">{f.name}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {f.contacts} {f.contacts === 1 ? "person" : "people"}
                      </span>
                      {f.tier && f.tierSource ? <span className="text-[11px] text-muted-foreground">tier {sourceLine(f.tierSource, f.tierNote)}</span> : null}
                      <span className="flex-1" />
                      {f.emailDomain && isEmailPattern(f.emailPattern) ? (
                        <span className="text-[11px] text-muted-foreground" title={sourceLine(f.emailSource, f.emailNote)}>
                          <span className="font-mono">
                            {EMAIL_PATTERN_EXAMPLE[f.emailPattern]}@{f.emailDomain}
                          </span>{" "}
                          · {sourceLine(f.emailSource, f.emailNote)}
                        </span>
                      ) : (
                        <span className="text-[11px] text-muted-foreground">no address format</span>
                      )}
                    </div>
                    <FirmRowEditor
                      company={f.name}
                      tier={f.tier ?? ""}
                      domain={f.emailDomain ?? ""}
                      pattern={isEmailPattern(f.emailPattern) ? f.emailPattern : "first.last"}
                      tiers={tiers.map((t) => t.tier)}
                    />
                  </li>
                ))}
              </ol>
            </section>
          ))
        )}

        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Add a firm</h2>
          <AddFirmForm companies={suggestions} tiers={tiers.map((t) => t.tier)} />
        </section>
      </div>
    </div>
  );
}
