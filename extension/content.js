// Runs inside a linkedin.com tab, in your own logged-in Chrome.
//
// This is the whole reason the extension exists. A server-side scraper is
// blocked by Cloudflare's bot management before it sends a header — the
// TLS handshake alone gives it away. Here there is nothing to fake: the
// request IS Chrome's, from a real linkedin.com page, with the session
// cookies the browser already manages and the bot-check the browser
// already passed. Same API, same pacing, no impersonation anywhere.

const ENDPOINT =
  "https://www.linkedin.com/voyager/api/relationships/dash/connections";
const DECORATION =
  "com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithProfile-16";
const PAGE_SIZE = 40; // LinkedIn's own page size
const PAGE_DELAY_MS = 2500; // deliberately slow — see SPEC §9b pacing
const MAX_PAGES = 250; // safety net against a paging bug

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** JSESSIONID doubles as the CSRF token; it is not HttpOnly, by design. */
function csrfToken() {
  const match = document.cookie.match(/JSESSIONID="?([^;"]+)"?/);
  return match ? match[1] : null;
}

function pageUrl(start) {
  const params = new URLSearchParams({
    decorationId: DECORATION,
    count: String(PAGE_SIZE),
    q: "search",
    sortType: "RECENTLY_ADDED",
    start: String(start),
  });
  return `${ENDPOINT}?${params.toString()}`;
}

async function runSync(report) {
  const csrf = csrfToken();
  if (!csrf) {
    throw new Error(
      "No JSESSIONID cookie on this page — are you logged in to LinkedIn?"
    );
  }

  const sessionId = crypto.randomUUID();
  let total = null;
  let seen = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetch(pageUrl(page * PAGE_SIZE), {
      method: "GET",
      credentials: "include", // same-origin: the browser attaches everything
      headers: {
        accept: "application/vnd.linkedin.normalized+json+2.1",
        "csrf-token": csrf,
        "x-restli-protocol-version": "2.0.0",
      },
    });
    if (res.status === 429) {
      throw new Error("LinkedIn rate-limited the request. Try again later.");
    }
    if (!res.ok) {
      throw new Error(`LinkedIn returned HTTP ${res.status} on page ${page + 1}.`);
    }
    const payload = await res.json();

    // Hand the raw page to Rolo; the parsing lives there, with its tests.
    const ack = await chrome.runtime.sendMessage({
      type: "page",
      sessionId,
      payload,
    });
    if (!ack?.ok) throw new Error(ack?.error ?? "Rolo rejected the page.");

    const before = seen;
    seen = ack.received ?? seen;
    if (typeof ack.total === "number") total = ack.total;

    report({ page: page + 1, seen, total });

    // An empty page, or a page that added nobody new, is the end of the
    // list whatever the reported total claims.
    const elements = Array.isArray(payload?.elements) ? payload.elements.length : 0;
    if (elements === 0 || seen === before) break;

    await sleep(PAGE_DELAY_MS);
  }

  const done = await chrome.runtime.sendMessage({ type: "done", sessionId });
  if (!done?.ok) throw new Error(done?.error ?? "Rolo rejected the import.");
  return done.result;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "startSync") return;
  runSync((progress) =>
    chrome.runtime.sendMessage({ type: "progress", progress })
  )
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: String(err.message ?? err) }));
  return true; // async response
});
