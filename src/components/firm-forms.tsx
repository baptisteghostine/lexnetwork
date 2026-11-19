"use client";

import { useId, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EMAIL_PATTERN_EXAMPLE, EMAIL_PATTERNS, type EmailPattern } from "@/lib/outreach/email-pattern";
import { setFirmFormatAction, setFirmTierAction, type FirmActionResult } from "@/server/firms";

// The Firms page's forms (SPEC §17): a firm's tier and its address format.

function Result({ result }: { result: FirmActionResult | null }) {
  if (!result) return null;
  return (
    <p role={result.ok ? "status" : "alert"} className={`text-xs ${result.ok ? "text-muted-foreground" : "text-destructive"}`}>
      {result.ok ? result.message : result.error}
    </p>
  );
}

function Fields({
  tier,
  setTier,
  domain,
  setDomain,
  pattern,
  setPattern,
  tiers,
}: {
  tier: string;
  setTier: (v: string) => void;
  domain: string;
  setDomain: (v: string) => void;
  pattern: EmailPattern;
  setPattern: (v: EmailPattern) => void;
  tiers: string[];
}) {
  const id = useId();
  return (
    <>
      <div className="space-y-1">
        <Label htmlFor={`${id}-tier`} className="text-[11px]">Tier</Label>
        <Input id={`${id}-tier`} list={`${id}-tiers`} value={tier} onChange={(e) => setTier(e.target.value)} placeholder="Bulge bracket" maxLength={40} className="h-8 w-44" />
        <datalist id={`${id}-tiers`}>
          {tiers.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-domain`} className="text-[11px]">Email domain</Label>
        <Input id={`${id}-domain`} value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="gs.com" maxLength={253} className="h-8 w-44 font-mono text-[12px]" />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-pattern`} className="text-[11px]">Built like (for Ana Silva)</Label>
        <select
          id={`${id}-pattern`}
          value={pattern}
          onChange={(e) => setPattern(e.target.value as EmailPattern)}
          className="block h-8 rounded-md border border-input bg-background px-2 font-mono text-[12px]"
        >
          {EMAIL_PATTERNS.map((p) => (
            <option key={p} value={p}>
              {EMAIL_PATTERN_EXAMPLE[p]}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}

/** Save the tier, then the format: two facts, so one failing says which. */
async function save(company: string, tier: string, domain: string, pattern: EmailPattern, was: { tier: string; domain: string; pattern: EmailPattern }): Promise<FirmActionResult> {
  if (tier.trim() !== was.tier) {
    const res = await setFirmTierAction(company, tier);
    if (!res.ok) return res;
  }
  if (domain.trim() !== was.domain || pattern !== was.pattern) {
    const res = await setFirmFormatAction(company, domain, pattern);
    if (!res.ok) return res;
  }
  return { ok: true, message: "Saved." };
}

export function FirmRowEditor({ company, tier: tier0, domain: domain0, pattern: pattern0, tiers }: { company: string; tier: string; domain: string; pattern: EmailPattern; tiers: string[] }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<FirmActionResult | null>(null);
  const [tier, setTier] = useState(tier0);
  const [domain, setDomain] = useState(domain0);
  const [pattern, setPattern] = useState<EmailPattern>(pattern0);
  return (
    <details className="mt-1 text-xs">
      <summary className="cursor-pointer select-none text-[11px] text-muted-foreground hover:text-foreground">Edit</summary>
      <form
        className="mt-2 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => setResult(await save(company, tier, domain, pattern, { tier: tier0, domain: domain0, pattern: pattern0 })));
        }}
      >
        <Fields tier={tier} setTier={setTier} domain={domain} setDomain={setDomain} pattern={pattern} setPattern={setPattern} tiers={tiers} />
        <Button type="submit" size="sm" variant="outline" disabled={pending}>Save</Button>
      </form>
      <p className="mt-1 text-[11px] text-muted-foreground">Empty the tier or the domain to remove it. What you set here Claude cannot change.</p>
      <Result result={result} />
    </details>
  );
}

export function AddFirmForm({ companies, tiers }: { companies: string[]; tiers: string[] }) {
  const id = useId();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<FirmActionResult | null>(null);
  const [company, setCompany] = useState("");
  const [tier, setTier] = useState("");
  const [domain, setDomain] = useState("");
  const [pattern, setPattern] = useState<EmailPattern>("first.last");
  return (
    <form
      className="space-y-2 text-xs"
      onSubmit={(e) => {
        e.preventDefault();
        if (!tier.trim() && !domain.trim()) return setResult({ ok: false, error: "Give a tier, an email domain, or both." });
        start(async () => {
          const res = await save(company, tier, domain, pattern, { tier: "", domain: "", pattern });
          setResult(res);
          if (res.ok) {
            setCompany("");
            setTier("");
            setDomain("");
          }
        });
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor={`${id}-company`} className="text-[11px]">Firm (an employer of someone in Rolo)</Label>
          <Input id={`${id}-company`} list={`${id}-companies`} value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Goldman Sachs" maxLength={200} required className="h-8 w-64" />
          <datalist id={`${id}-companies`}>
            {companies.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </div>
        <Fields tier={tier} setTier={setTier} domain={domain} setDomain={setDomain} pattern={pattern} setPattern={setPattern} tiers={tiers} />
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "…" : "Add"}
        </Button>
      </div>
      <Result result={result} />
    </form>
  );
}
