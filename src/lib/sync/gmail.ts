// Gmail metadata sync — request builders and parsers, kept pure so unit
// tests can assert the privacy invariant (SPEC §9): every message fetch is
// format=metadata with an explicit header whitelist; nothing in this module
// can even express a body request. The `q` search parameter is likewise
// unavailable — the gmail.metadata scope rejects it, so backfill windowing
// happens client-side on internalDate.

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Exactly the headers the schema stores. Never Body, never a payload part. */
export const METADATA_HEADERS = ["From", "To", "Cc", "Subject"] as const;

export function buildProfileUrl(): string {
  return `${GMAIL_BASE}/profile`;
}

export function buildMessageListUrl(opts: {
  pageToken?: string;
  maxResults?: number;
}): string {
  const params = new URLSearchParams({
    maxResults: String(opts.maxResults ?? 500),
  });
  if (opts.pageToken) params.set("pageToken", opts.pageToken);
  return `${GMAIL_BASE}/messages?${params.toString()}`;
}

export function buildMessageMetadataUrl(messageId: string): string {
  const params = new URLSearchParams({ format: "metadata" });
  for (const h of METADATA_HEADERS) params.append("metadataHeaders", h);
  return `${GMAIL_BASE}/messages/${encodeURIComponent(messageId)}?${params.toString()}`;
}

export function buildHistoryListUrl(opts: {
  startHistoryId: string;
  pageToken?: string;
}): string {
  const params = new URLSearchParams({
    startHistoryId: opts.startHistoryId,
    historyTypes: "messageAdded",
    maxResults: "500",
  });
  if (opts.pageToken) params.set("pageToken", opts.pageToken);
  return `${GMAIL_BASE}/history?${params.toString()}`;
}

// ---------- parsing ----------

export type GmailMessageMeta = {
  id: string;
  threadId: string;
  internalDate: number;
  from: string | null;
  to: string[];
  cc: string[];
  subject: string | null;
};

type RawMessage = {
  id?: string;
  threadId?: string;
  internalDate?: string;
  payload?: { headers?: { name?: string; value?: string }[] };
};

export function parseMessageMeta(raw: unknown): GmailMessageMeta | null {
  const m = raw as RawMessage;
  if (!m?.id || !m.internalDate) return null;
  const headers = new Map<string, string>();
  for (const h of m.payload?.headers ?? []) {
    if (h.name && h.value !== undefined) {
      headers.set(h.name.toLowerCase(), h.value);
    }
  }
  return {
    id: m.id,
    threadId: m.threadId ?? m.id,
    internalDate: Number(m.internalDate),
    from: headers.get("from") ?? null,
    to: splitAddressList(headers.get("to")),
    cc: splitAddressList(headers.get("cc")),
    subject: headers.get("subject") ?? null,
  };
}

/**
 * Extract bare lowercase addresses from an RFC 5322 address-list header.
 * Handles `Name <a@b.c>`, bare addresses, and quoted display names with
 * commas; tolerant of the malformed variants real mailboxes contain.
 */
export function extractAddresses(headerValue: string | null): string[] {
  if (!headerValue) return [];
  const out: string[] = [];
  for (const part of splitAddressList(headerValue)) {
    const angled = part.match(/<([^<>\s]+@[^<>\s]+)>/);
    const candidate = angled
      ? angled[1]
      : (part.match(/([^\s"',;<>]+@[^\s"',;<>]+)/)?.[1] ?? null);
    if (candidate) out.push(candidate.toLowerCase().replace(/[.,;]+$/, ""));
  }
  return out;
}

/**
 * Addresses with their display names, from the same header grammar —
 * `"Silva, Ana" <ana@x.y>` → {email, name: "Silva, Ana"}. Feeds the
 * "People you met" queue (SPEC §9f); the sync never stores the header.
 */
export function extractAddressNames(
  headerValue: string | null
): { email: string; name: string | null }[] {
  if (!headerValue) return [];
  const out: { email: string; name: string | null }[] = [];
  for (const part of splitAddressList(headerValue)) {
    const angled = part.match(/^(.*?)<([^<>\s]+@[^<>\s]+)>\s*$/);
    if (angled) {
      const name = angled[1].trim().replace(/^"+|"+$/g, "").trim();
      out.push({ email: angled[2].toLowerCase(), name: name || null });
      continue;
    }
    const bare = part.match(/([^\s"',;<>]+@[^\s"',;<>]+)/)?.[1];
    if (bare) out.push({ email: bare.toLowerCase().replace(/[.,;]+$/, ""), name: null });
  }
  return out;
}

/** Split on commas that sit outside double quotes. */
function splitAddressList(headerValue: string | undefined | null): string[] {
  if (!headerValue) return [];
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of headerValue) {
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === "," && !inQuotes) {
      if (current.trim()) parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

export type ParsedDirection = {
  direction: "inbound" | "outbound";
  /** The non-owner side(s) of the message, lowercase bare addresses. */
  counterparts: string[];
};

/**
 * Direction via the owner's address list (SPEC §9): sender is mine →
 * outbound to everyone else; otherwise inbound from the sender. Messages
 * where no side matches mine (mailing lists to aliases we don't know)
 * resolve as inbound with all recipients as counterparts — matching
 * against contacts filters them later.
 */
export function resolveDirection(
  meta: GmailMessageMeta,
  myAddresses: string[]
): ParsedDirection {
  const mine = new Set(myAddresses.map((a) => a.toLowerCase()));
  const fromAddrs = extractAddresses(meta.from);
  const recipientAddrs = [
    ...extractAddresses(meta.to.join(", ")),
    ...extractAddresses(meta.cc.join(", ")),
  ];
  if (fromAddrs.some((a) => mine.has(a))) {
    return {
      direction: "outbound",
      counterparts: [...new Set(recipientAddrs.filter((a) => !mine.has(a)))],
    };
  }
  return { direction: "inbound", counterparts: [...new Set(fromAddrs)] };
}

// ---------- history parsing ----------

type RawHistoryPage = {
  history?: { messagesAdded?: { message?: { id?: string } }[] }[];
  nextPageToken?: string;
  historyId?: string;
};

export function parseHistoryPage(raw: unknown): {
  messageIds: string[];
  nextPageToken: string | null;
  historyId: string | null;
} {
  const page = raw as RawHistoryPage;
  const ids = new Set<string>();
  for (const h of page.history ?? []) {
    for (const added of h.messagesAdded ?? []) {
      if (added.message?.id) ids.add(added.message.id);
    }
  }
  return {
    messageIds: [...ids],
    nextPageToken: page.nextPageToken ?? null,
    historyId: page.historyId ?? null,
  };
}
