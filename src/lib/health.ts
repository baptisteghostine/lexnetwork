// App-wide health (SPEC §13 "failure banner", widened 2026-09-19): the
// pure decisions behind the red bar at the top of every page. The server
// reader in server/health.ts feeds these rows; keeping the logic here makes
// "what counts as failing" unit-testable without a database.
//
// Why widen it: a Google connection dying (Google expires refresh tokens
// every seven days for an OAuth app in "Testing" status), an SMTP server
// refusing the network-updates email, or a scheduled sync going dead were
// all visible only inside Settings → Integrations. The owner found out
// weeks later, when the data was missing. Data safety was already not
// allowed to fail silently; neither is capture.

export type TerminalJobRow = {
  kind: string;
  status: string; // 'success' | 'dead' (callers pre-filter to terminal rows)
  finishedAt: number | null;
  lastError: string | null;
};

export type HealthIssue = {
  /** Stable id so the UI can key and tests can assert. */
  id: string;
  message: string;
  /** Where the fix lives. */
  href: string;
};

/** Human labels for the recurring job kinds worth a banner. Kinds not
 * listed here (ai_batch_tag, reminder sweeps, backup — which has its own
 * status reader) never surface through this path. */
export const JOB_LABELS: Record<string, string> = {
  gmail_sync: "Gmail sync",
  calendar_sync: "Calendar sync",
  linkedin_sync: "LinkedIn API sync",
  dedupe_scan: "Duplicate scan",
  digest: "Daily digest email",
  network_updates: "Network-updates email",
  meeting_prep: "Pre-meeting brief",
  geocode: "City placement",
};

/**
 * Per kind, the newest terminal row decides: dead → failing, success →
 * fine. A dead row that a later success has already superseded is history,
 * not a problem. Rows of unlabelled kinds are ignored.
 */
export function failingJobs(rows: TerminalJobRow[]): { kind: string; error: string | null }[] {
  const newest = new Map<string, TerminalJobRow>();
  for (const row of rows) {
    if (!(row.kind in JOB_LABELS)) continue;
    const seen = newest.get(row.kind);
    if (!seen || (row.finishedAt ?? 0) > (seen.finishedAt ?? 0)) newest.set(row.kind, row);
  }
  return [...newest.values()]
    .filter((r) => r.status === "dead")
    .sort((a, b) => a.kind.localeCompare(b.kind))
    .map((r) => ({ kind: r.kind, error: r.lastError }));
}

export type AccountHealthRow = {
  provider: string;
  status: string; // 'active' | 'error' | 'revoked'
  lastError: string | null;
};

const PROVIDER_LABELS: Record<string, string> = {
  google: "Google",
  linkedin: "LinkedIn API",
};

/** Bound so one long stack trace can't become the whole banner. */
function shortError(error: string | null): string {
  if (!error) return "";
  const oneLine = error.replace(/\s+/g, " ").trim();
  return oneLine.length > 160 ? oneLine.slice(0, 157) + "…" : oneLine;
}

export function buildHealthIssues(input: {
  backupFailing: boolean;
  accounts: AccountHealthRow[];
  jobs: TerminalJobRow[];
}): HealthIssue[] {
  const issues: HealthIssue[] = [];
  if (input.backupFailing) {
    issues.push({
      id: "backup",
      message: "The last backup failed. See details in Settings → Data.",
      href: "/settings?tab=data",
    });
  }
  for (const a of input.accounts) {
    if (a.status !== "error" && a.status !== "revoked") continue;
    const label = PROVIDER_LABELS[a.provider] ?? a.provider;
    const detail = shortError(a.lastError);
    issues.push({
      id: `account:${a.provider}`,
      message: `${label} is disconnected${detail ? ` — ${detail}` : "."} Reconnect in Settings → Integrations.`,
      href: "/settings?tab=integrations",
    });
  }
  for (const f of failingJobs(input.jobs)) {
    const detail = shortError(f.error);
    issues.push({
      id: `job:${f.kind}`,
      message: `${JOB_LABELS[f.kind]} is failing${detail ? `: ${detail}` : "."}`,
      href: "/settings?tab=integrations",
    });
  }
  return issues;
}
