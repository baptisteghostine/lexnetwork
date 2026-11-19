// Outreach (SPEC §16): the links that open a draft in the owner's own
// mail program, already filled in. Rolo never sends mail — the owner
// presses Send, in Outlook, from their own account.

export const DRAFT_KINDS = ["first", "nudge", "reply", "other"] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];

export const DRAFT_KIND_LABEL: Record<DraftKind, string> = {
  first: "First email",
  nudge: "Follow-up",
  reply: "Reply",
  other: "Email",
};

export const DRAFT_SUBJECT_MAX = 300;
export const DRAFT_BODY_MAX = 6000;

/**
 * Windows hands a mailto: link to the mail program through a call that
 * gives up at about 2,000 characters, so a longer one silently opens
 * nothing. Past this, the link is not offered and Copy is the way.
 */
export const MAILTO_MAX = 2000;
/** Outlook on the web reads its compose link from the address bar, which holds far more. */
export const WEB_COMPOSE_MAX = 7500;

// Deliberately narrow: the address is placed in a link, so anything that
// could mean something to a URL (& = ? # %) is not an address here. An
// unusual but valid address simply gets no link, and Copy still works.
const EMAIL = /^[A-Za-z0-9._+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

export function isEmailAddress(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length <= 320 && EMAIL.test(value);
}

export type ComposeInput = {
  to: string | null;
  subject: string;
  body: string;
  /** The owner's own capture address, so the sent mail reaches Rolo's mailbox with its real headers. */
  bcc?: string | null;
};

/** Mail programs expect CRLF line ends inside a link. */
function wire(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n");
}

function query(pairs: [string, string | null | undefined][]): string {
  return pairs
    .filter((p): p is [string, string] => typeof p[1] === "string" && p[1] !== "")
    // encodeURIComponent, not URLSearchParams: a "+" for a space is read
    // literally by mail programs, and the text would arrive full of pluses.
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
}

/** A mailto: link for the desktop mail program, or null when it cannot work. */
export function mailtoLink(input: ComposeInput): string | null {
  if (!isEmailAddress(input.to)) return null;
  const q = query([
    ["subject", input.subject],
    ["body", wire(input.body)],
    ["bcc", isEmailAddress(input.bcc) ? input.bcc : null],
  ]);
  const link = `mailto:${input.to}${q ? `?${q}` : ""}`;
  return link.length <= MAILTO_MAX ? link : null;
}

/** Outlook on the web's compose page, filled in — or null when it cannot work. */
export function outlookWebLink(input: ComposeInput): string | null {
  if (!isEmailAddress(input.to)) return null;
  const q = query([
    ["to", input.to],
    ["subject", input.subject],
    ["body", wire(input.body)],
    ["bcc", isEmailAddress(input.bcc) ? input.bcc : null],
  ]);
  const link = `https://outlook.office.com/mail/deeplink/compose?${q}`;
  return link.length <= WEB_COMPOSE_MAX ? link : null;
}

/** What Copy puts on the clipboard: the whole email as text. */
export function draftAsText(input: ComposeInput): string {
  return [input.to ? `To: ${input.to}` : null, `Subject: ${input.subject}`, "", input.body.replace(/\r\n?/g, "\n")]
    .filter((line): line is string => line !== null)
    .join("\n");
}
