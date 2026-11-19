// What the connector's write tools decide before they touch the database
// (SPEC §14, Phase 15). Pure: text hygiene, the signal-not-volume rule,
// and the near-duplicate test. The database side is in server/agent/.

// ---------- what kind of message this is ----------

/**
 * The owner's rule (2026-11-19): "it's good not to append everything
 * because sometimes there's noise — if it's a real answer then yes". An
 * exchange is logged only when a person wrote it. The caller has to say
 * what the message is; the automatic kinds exist in the vocabulary so
 * that naming one is a clean refusal rather than a mislabel.
 */
export const PERSONAL_CATEGORIES = [
  "outreach", // the owner's first message to someone
  "follow_up", // the owner nudging after silence
  "reply", // an answer, either direction
  "introduction", // someone introducing, or being introduced
  "scheduling", // arranging a call or meeting
  "decline", // a no, however polite
  "thanks", // a thank-you after a call or meeting
  "other_personal", // a person wrote it, and none of the above fits
] as const;

export const AUTOMATIC_CATEGORIES = [
  "newsletter",
  "notification",
  "auto_reply",
  "bounce",
] as const;

export type PersonalCategory = (typeof PERSONAL_CATEGORIES)[number];
export type MessageCategory = PersonalCategory | (typeof AUTOMATIC_CATEGORIES)[number];

export function isPersonalCategory(category: string): category is PersonalCategory {
  return (PERSONAL_CATEGORIES as readonly string[]).includes(category);
}

export const AUTOMATIC_REFUSAL =
  "Not logged: Rolo's timeline holds exchanges a person wrote. Newsletters, notifications, automatic replies and bounces are left out — an out-of-office or a bounce can still be worth a reminder or a note.";

// ---------- text an agent writes ----------

/**
 * Markdown an agent wrote, made safe to show the owner. One thing matters:
 * an image is fetched the moment a note is displayed, so `![](https://…)`
 * is a way to make the owner's browser call an address of someone else's
 * choosing — the classic route for text injected into an email to carry
 * data out. Every image becomes a plain link, which is only followed if
 * clicked. Raw HTML is already inert in Rolo's renderer.
 */
export function sanitizeAgentMarkdown(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    // Control characters other than tab and newline have no place in a note.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    // Every run of bangs before a bracket, not just one: "!![" would
    // otherwise come out as "![".
    .replace(/!+\[/g, "[")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

/** One line: whitespace collapsed, control characters gone, cut to `max`. */
export function cleanLine(text: string, max: number): string {
  const flat = text
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

// ---------- a profile link an agent supplies ----------

/**
 * A LinkedIn profile address in the one form Rolo stores, or null. The
 * stored value becomes a link on the contact's page, so "contains
 * linkedin.com" is not enough: the host has to be LinkedIn's and the path
 * a member profile. Anything else — another site with linkedin.com in its
 * path, a company page, a script: address — is refused.
 */
export function linkedinProfileUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return null;
  const match = /^\/in\/([^/]+)\/?$/.exec(url.pathname);
  if (!match) return null;
  return `https://www.linkedin.com/in/${match[1]}`;
}

// ---------- near-duplicates ----------

/**
 * A subject as two copies of the same message would share it: reply and
 * forward prefixes off (in the languages Outlook writes them), case and
 * spacing folded. "Fw: Re: Introduction – LBS" and "RE: introduction –
 * LBS" are one conversation's subject.
 */
export function normalizeSubject(subject: string | null | undefined): string {
  let s = (subject ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  for (;;) {
    const next = s.replace(/^(re|fw|fwd|tr|rv|aw|wg|sv|vs|antw|réf|ref)\s*(\[\d+\])?\s*:\s*/i, "");
    if (next === s) break;
    s = next;
  }
  return s;
}

/** How far apart two records of the same message may be dated. */
export const NEAR_DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

export type ExchangeFingerprint = {
  kind: string;
  direction: string | null;
  occurredAt: number;
  title: string | null;
};

/**
 * Are these two records the same real-world exchange? Same kind and
 * direction, within ten minutes, and — when both carry a subject — the
 * same subject once prefixes are off. This is what joins the copy the
 * owner forwarded days later to the send Rolo already recorded, and a
 * message the agent reads twice under two different ids.
 */
export function isSameExchange(a: ExchangeFingerprint, b: ExchangeFingerprint): boolean {
  if (a.kind !== b.kind) return false;
  if ((a.direction ?? null) !== (b.direction ?? null)) return false;
  if (Math.abs(a.occurredAt - b.occurredAt) > NEAR_DUPLICATE_WINDOW_MS) return false;
  const x = normalizeSubject(a.title);
  const y = normalizeSubject(b.title);
  return !x || !y || x === y;
}

// ---------- showing a proposal to the owner ----------

const ARG_LABELS: Record<string, string> = {
  kind: "Kind",
  direction: "Direction",
  category: "Category",
  occurredAt: "When",
  subject: "Subject",
  note: "Note",
  text: "Note",
  date: "Dated",
  title: "Title",
  dueAt: "Due",
  details: "Details",
  reminderId: "Reminder",
  firstName: "First name",
  lastName: "Last name",
  company: "Company",
  location: "Location",
  emails: "Email",
  linkedinUrl: "LinkedIn",
  confirmNew: "New person even if the name exists",
  contactIds: "Contacts",
  addTags: "Add tags",
  removeTags: "Remove tags",
  addToGroupIds: "Add to groups",
  removeFromGroupIds: "Remove from groups",
};

/**
 * A write call's arguments as labelled lines, for the page where the
 * owner approves or reviews it. Plain text only — the values came from an
 * agent, which may have copied them from someone's email.
 */
export function describeArgs(argsJson: string): { label: string; value: string }[] {
  let args: unknown;
  try {
    args = JSON.parse(argsJson);
  } catch {
    return [];
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) return [];
  const record = args as Record<string, unknown>;
  const out: { label: string; value: string }[] = [];
  for (const [key, label] of Object.entries(ARG_LABELS)) {
    const value = record[key];
    if (value === undefined || value === null) continue;
    // On a contact, `title` is their job; on a reminder, its name.
    const shown = key === "title" && ("firstName" in record || "lastName" in record || "company" in record) ? "Job title" : label;
    const text = Array.isArray(value)
      ? value.map((v) => String(v)).join(", ")
      : typeof value === "boolean"
        ? value
          ? "yes"
          : "no"
        : String(value);
    if (text) out.push({ label: shown, value: text.length > 600 ? `${text.slice(0, 600)}…` : text });
  }
  return out;
}
