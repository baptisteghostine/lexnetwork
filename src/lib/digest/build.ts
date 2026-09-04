// Pure digest renderer: same data the Today page shows, as an email
// (SPEC §3 AC: digest contains exactly the items on Today at that moment).

export type DigestInput = {
  dateLabel: string;
  appUrl: string;
  reminders: { title: string; contactName: string | null; overdueDays: number }[];
  dueContacts: {
    displayName: string;
    title: string | null;
    company: string | null;
    daysOverdue: number;
    starred: boolean;
  }[];
  changes: {
    displayName: string;
    field: "company" | "title";
    oldValue: string | null;
    newValue: string | null;
  }[];
  birthdays: { displayName: string; daysUntil: number; turns: number | null }[];
  /** "Worth reconnecting" (SPEC §3) — optional so older callers/tests stand. */
  resurface?: {
    displayName: string;
    title: string | null;
    company: string | null;
    monthsSince: number | null;
    interactionCount: number;
  }[];
};

export type DigestEmail = {
  empty: boolean;
  subject: string;
  html: string;
  text: string;
};

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const INDIGO = "#4f46e5";
const MUTED = "#6b7280";
const RED = "#dc2626";

function section(title: string, rowsHtml: string): string {
  return `<h2 style="margin:20px 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:0.05em;color:${MUTED}">${title}</h2>
<table style="border-collapse:collapse;width:100%">${rowsHtml}</table>`;
}

function row(left: string, right: string): string {
  return `<tr>
<td style="padding:6px 0;border-bottom:1px solid #e5e7eb;font-size:14px">${left}</td>
<td style="padding:6px 0;border-bottom:1px solid #e5e7eb;font-size:12px;color:${MUTED};text-align:right;white-space:nowrap">${right}</td>
</tr>`;
}

export function buildDigest(input: DigestInput): DigestEmail {
  const counts = [
    input.dueContacts.length &&
      `${input.dueContacts.length} due`,
    input.reminders.length &&
      `${input.reminders.length} reminder${input.reminders.length > 1 ? "s" : ""}`,
    input.changes.length &&
      `${input.changes.length} job change${input.changes.length > 1 ? "s" : ""}`,
    input.birthdays.length &&
      `${input.birthdays.length} birthday${input.birthdays.length > 1 ? "s" : ""}`,
  ].filter(Boolean) as string[];
  const empty = counts.length === 0;

  const subject = empty
    ? `Rolo — all clear, ${input.dateLabel}`
    : `Rolo: ${counts.join(" · ")} — ${input.dateLabel}`;

  const parts: string[] = [];
  const textParts: string[] = [];

  if (input.reminders.length) {
    parts.push(
      section(
        "Reminders",
        input.reminders
          .map((r) =>
            row(
              `${esc(r.title)}${r.contactName ? ` <span style="color:${MUTED}">· ${esc(r.contactName)}</span>` : ""}`,
              r.overdueDays > 0
                ? `<span style="color:${RED}">${r.overdueDays}d overdue</span>`
                : "today"
            )
          )
          .join("")
      )
    );
    textParts.push(
      "REMINDERS\n" +
        input.reminders
          .map(
            (r) =>
              `- ${r.title}${r.contactName ? ` (${r.contactName})` : ""}${r.overdueDays > 0 ? ` — ${r.overdueDays}d overdue` : ""}`
          )
          .join("\n")
    );
  }

  if (input.dueContacts.length) {
    parts.push(
      section(
        "Keep in touch",
        input.dueContacts
          .map((c) =>
            row(
              `${c.starred ? "★ " : ""}${esc(c.displayName)}${
                c.title || c.company
                  ? ` <span style="color:${MUTED}">· ${esc([c.title, c.company].filter(Boolean).join(", "))}</span>`
                  : ""
              }`,
              c.daysOverdue === 0
                ? "due today"
                : `<span style="color:${c.daysOverdue > 7 ? RED : MUTED}">${c.daysOverdue}d overdue</span>`
            )
          )
          .join("")
      )
    );
    textParts.push(
      "KEEP IN TOUCH\n" +
        input.dueContacts
          .map(
            (c) =>
              `- ${c.starred ? "* " : ""}${c.displayName}${c.daysOverdue > 0 ? ` — ${c.daysOverdue}d overdue` : " — due today"}`
          )
          .join("\n")
    );
  }

  if (input.changes.length) {
    parts.push(
      section(
        "Job changes — reasons to reach out",
        input.changes
          .map((c) =>
            row(
              `${esc(c.displayName)} <span style="color:${MUTED}">${esc(c.oldValue ?? "—")} →</span> ${esc(c.newValue ?? "—")}`,
              c.field
            )
          )
          .join("")
      )
    );
    textParts.push(
      "JOB CHANGES\n" +
        input.changes
          .map(
            (c) =>
              `- ${c.displayName}: ${c.oldValue ?? "—"} → ${c.newValue ?? "—"} (${c.field})`
          )
          .join("\n")
    );
  }

  if (input.birthdays.length) {
    parts.push(
      section(
        "Birthdays this week",
        input.birthdays
          .map((b) =>
            row(
              esc(b.displayName) +
                (b.turns !== null
                  ? ` <span style="color:${MUTED}">turns ${b.turns}</span>`
                  : ""),
              b.daysUntil === 0
                ? "today 🎂"
                : b.daysUntil === 1
                  ? "tomorrow"
                  : `in ${b.daysUntil} days`
            )
          )
          .join("")
      )
    );
    textParts.push(
      "BIRTHDAYS THIS WEEK\n" +
        input.birthdays
          .map(
            (b) =>
              `- ${b.displayName}${b.turns !== null ? ` (turns ${b.turns})` : ""} — ${
                b.daysUntil === 0
                  ? "today"
                  : b.daysUntil === 1
                    ? "tomorrow"
                    : `in ${b.daysUntil} days`
              }`
          )
          .join("\n")
    );
  }

  // Suggestions, not obligations: they never make the digest non-empty
  // and never enter the subject-line counts.
  const resurface = input.resurface ?? [];
  if (resurface.length) {
    parts.push(
      section(
        "Worth reconnecting",
        resurface
          .map((c) =>
            row(
              `${esc(c.displayName)}${
                c.title || c.company
                  ? ` <span style="color:${MUTED}">· ${esc([c.title, c.company].filter(Boolean).join(", "))}</span>`
                  : ""
              }`,
              `${c.monthsSince !== null ? `${c.monthsSince}mo ago` : "—"} · ${c.interactionCount} interaction${c.interactionCount === 1 ? "" : "s"}`
            )
          )
          .join("")
      )
    );
    textParts.push(
      "WORTH RECONNECTING\n" +
        resurface
          .map(
            (c) =>
              `- ${c.displayName}${c.monthsSince !== null ? ` — last spoke ${c.monthsSince}mo ago` : ""}, ${c.interactionCount} interaction${c.interactionCount === 1 ? "" : "s"}`
          )
          .join("\n")
    );
  }

  const html = `<div style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111827">
<p style="margin:0;font-size:16px;font-weight:600;color:${INDIGO}">Rolo</p>
<p style="margin:4px 0 0;font-size:13px;color:${MUTED}">${esc(input.dateLabel)}</p>
${empty ? `<p style="margin:20px 0;font-size:14px">All clear — nobody is due today.</p>${parts.join("")}` : parts.join("")}
<p style="margin:24px 0 0;font-size:12px"><a href="${esc(input.appUrl)}/today" style="color:${INDIGO}">Open Today →</a></p>
</div>`;

  const text = empty
    ? `Rolo — ${input.dateLabel}\n\nAll clear — nobody is due today.${textParts.length ? `\n\n${textParts.join("\n\n")}` : ""}\n\n${input.appUrl}/today`
    : `Rolo — ${input.dateLabel}\n\n${textParts.join("\n\n")}\n\n${input.appUrl}/today`;

  return { empty, subject, html, text };
}
