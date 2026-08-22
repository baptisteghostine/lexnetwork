// The network-updates email: "these people changed jobs since I last told
// you" (SPEC §5). Pure — the job in jobs/network-updates.ts feeds it rows
// and a clock, so the rendering is unit-testable without a DB or SMTP.
//
// Deliberately NOT the daily digest. The digest mirrors whatever Today
// shows at send time and will repeat a change every morning until it is
// dismissed or acted on; this email is edge-triggered — each change goes
// out exactly once, stamped by contact_changes.notified_at — so it stays
// quiet for weeks and then says something worth opening.

import { DAY_MS } from "@/lib/cadence/engine";

export type NetworkUpdate = {
  displayName: string;
  field: "company" | "title";
  oldValue: string | null;
  newValue: string | null;
  detectedAt: number;
};

/** One un-emailed row of contact_changes, joined to its contact. */
export type PendingChangeRow = NetworkUpdate & {
  id: number;
  contactId: number;
};

/**
 * Turn raw pending rows into what the email says, plus every row id the
 * send covers.
 *
 * Two imports a week apart can both move the same person; the owner should
 * read one move, not a chain. So the list collapses to the newest change
 * per contact+field — but `ids` still carries the superseded rows, because
 * they've had their say through the row that replaced them and must be
 * stamped too or they resurface in the next sweep forever.
 *
 * Order matches the Today list: company moves above title-only ones,
 * newest first.
 */
export function collapseUpdates(rows: PendingChangeRow[]): {
  ids: number[];
  updates: NetworkUpdate[];
} {
  const latest = new Map<string, PendingChangeRow>();
  for (const r of rows) {
    const key = `${r.contactId}:${r.field}`;
    const held = latest.get(key);
    if (!held || r.detectedAt >= held.detectedAt) latest.set(key, r);
  }
  const updates = [...latest.values()]
    .sort(
      (a, b) =>
        Number(b.field === "company") - Number(a.field === "company") ||
        b.detectedAt - a.detectedAt
    )
    .map(({ displayName, field, oldValue, newValue, detectedAt }) => ({
      displayName,
      field,
      oldValue,
      newValue,
      detectedAt,
    }));
  return { ids: rows.map((r) => r.id), updates };
}

export type NetworkUpdatesInput = {
  updates: NetworkUpdate[];
  appUrl: string;
  now: number;
};

export type NetworkUpdatesEmail = {
  subject: string;
  html: string;
  text: string;
};

/** Age label shared with the Today card, so the web row and the email row
 * read identically ("2d ago", not "2 days ago" in one and a date in the
 * other). Rounded down: something detected 90 minutes ago is still today. */
export function changeAge(detectedAt: number, now: number): string {
  const days = Math.floor((now - detectedAt) / DAY_MS);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const INDIGO = "#4f46e5";
const MUTED = "#6b7280";
const GREEN = "#15803d";

/** "Senior PM at Acme → Director at Globex" as a struck-through old value
 * beside a green new one — the same visual grammar as the Today card. */
export function updateDiffHtml(u: NetworkUpdate): string {
  const next = `<span style="color:${GREEN};font-weight:600">${esc(u.newValue ?? "—")}</span>`;
  if (!u.oldValue) return next;
  return `<span style="color:${MUTED};text-decoration:line-through">${esc(u.oldValue)}</span> ${next}`;
}

export function updateDiffText(u: NetworkUpdate): string {
  return u.oldValue
    ? `${u.oldValue} → ${u.newValue ?? "—"}`
    : (u.newValue ?? "—");
}

export function buildNetworkUpdates(
  input: NetworkUpdatesInput
): NetworkUpdatesEmail {
  const n = input.updates.length;
  // Naming the first person makes the subject line legible in a phone
  // notification, where "3 network updates" tells you nothing.
  const lead = input.updates[0]?.displayName ?? "";
  const subject =
    n === 1
      ? `${lead} changed ${input.updates[0].field === "company" ? "jobs" : "role"}`
      : `${lead} and ${n - 1} other${n > 2 ? "s" : ""} in your network changed jobs`;

  const rows = input.updates
    .map(
      (u) => `<tr>
<td style="padding:10px 0;border-bottom:1px solid #e5e7eb;font-size:14px">
<div style="font-weight:600">${esc(u.displayName)}</div>
<div style="margin-top:2px;font-size:13px">${updateDiffHtml(u)}</div>
</td>
<td style="padding:10px 0;border-bottom:1px solid #e5e7eb;font-size:12px;color:${MUTED};text-align:right;vertical-align:top;white-space:nowrap">${esc(changeAge(u.detectedAt, input.now))}</td>
</tr>`
    )
    .join("");

  const html = `<div style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111827">
<p style="margin:0;font-size:16px;font-weight:600;color:${INDIGO}">Rolo</p>
<p style="margin:4px 0 0;font-size:13px;color:${MUTED}">Network updates — ${n} ${n === 1 ? "person" : "people"} moved</p>
<table style="border-collapse:collapse;width:100%;margin-top:12px">${rows}</table>
<p style="margin:24px 0 0;font-size:12px"><a href="${esc(input.appUrl)}/today" style="color:${INDIGO}">Open Today →</a></p>
</div>`;

  const text = `Rolo — network updates\n\n${input.updates
    .map(
      (u) =>
        `- ${u.displayName}: ${updateDiffText(u)} (${u.field}, ${changeAge(u.detectedAt, input.now)})`
    )
    .join("\n")}\n\n${input.appUrl}/today`;

  return { subject, html, text };
}
