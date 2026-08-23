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
  // A page that adds nobody new usually means `start` isn't advancing the
  // window and LinkedIn is re-serving the first page. One such page could
  // be a coincidence at the tail; two in a row is a paging failure worth
  // naming, not a silent early stop that looks like success.
  let noNewStreak = 0;
  let stopReason = `hit the ${MAX_PAGES}-page cap`;

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

    const elements = Array.isArray(payload?.elements) ? payload.elements.length : 0;
    if (elements === 0 && (ack.parsed ?? 0) === 0) {
      stopReason = `page ${page + 1} came back empty`;
      break;
    }
    if (seen === before) {
      noNewStreak += 1;
      if (noNewStreak >= 2) {
        stopReason =
          `pages ${page} and ${page + 1} added nobody new — LinkedIn is re-serving the same window, so 'start' is not paging`;
        break;
      }
    } else {
      noNewStreak = 0;
    }
    if (total !== null && seen >= total) {
      stopReason = `reached the reported total of ${total}`;
      break;
    }

    await sleep(PAGE_DELAY_MS);
  }

  const done = await chrome.runtime.sendMessage({
    type: "done",
    sessionId,
    stopReason,
  });
  if (!done?.ok) throw new Error(done?.error ?? "Rolo rejected the import.");
  return { ...done.result, stopReason };
}

// ---------- profile-location enrichment (SPEC §9d) ----------
//
// The connections endpoint carries no geography at all — verified against
// a live payload, every key at every depth. Location only exists on the
// individual profile, so it costs one request per person. That cost is the
// entire design: this runs slowly, a capped number of profiles a day, in
// priority order, so the traffic looks like someone reading LinkedIn
// rather than a crawler emptying it.

const PROFILE_DELAY_MS = 4000; // slower than the list sync: more requests
const ENRICH_BATCH = 10;

// LinkedIn has moved this endpoint before and will again, so try the known
// forms and remember whichever answers. Each candidate builds a URL for a
// public identifier.
const PROFILE_ENDPOINTS = [
  (id) =>
    `/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(id)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-6`,
  (id) => `/voyager/api/identity/profiles/${encodeURIComponent(id)}/profileView`,
  (id) =>
    `/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(id)}`,
];
let workingEndpoint = null;

async function fetchProfile(id, csrf) {
  const candidates = workingEndpoint ? [workingEndpoint] : PROFILE_ENDPOINTS;
  let lastStatus = null;
  for (const build of candidates) {
    const res = await fetch(build(id), {
      credentials: "include",
      headers: {
        accept: "application/vnd.linkedin.normalized+json+2.1",
        "csrf-token": csrf,
        "x-restli-protocol-version": "2.0.0",
      },
    });
    // Rate limiting is never something to route around — stop the whole run.
    if (res.status === 429) {
      throw new Error("LinkedIn rate-limited the request. Try again later.");
    }
    lastStatus = res.status;
    if (!res.ok) continue;
    workingEndpoint = build;
    return await res.json();
  }
  // A single 404 is just a profile that moved or a member who left; only a
  // total failure across every candidate is worth reporting upward.
  return { __unreachable: lastStatus };
}

async function runEnrich(report) {
  const csrf = csrfToken();
  if (!csrf) {
    throw new Error(
      "No JSESSIONID cookie on this page — are you logged in to LinkedIn?"
    );
  }

  let located = 0;
  let attempted = 0;
  let warning = null;

  for (;;) {
    const batch = await chrome.runtime.sendMessage({
      type: "enrichNext",
      batchSize: ENRICH_BATCH,
    });
    if (!batch?.ok) throw new Error(batch?.error ?? "Rolo wouldn't hand out work.");
    const profiles = batch.profiles ?? [];
    // Empty means either the queue is drained or today's budget is spent.
    // Both are a clean stop, not a failure.
    if (profiles.length === 0) {
      return {
        attempted,
        located,
        queued: batch.queued ?? 0,
        stopReason:
          (batch.queued ?? 0) > 0
            ? "today's budget is spent — it picks up again tomorrow"
            : "every contact has been checked",
        warning,
      };
    }

    const results = [];
    for (const p of profiles) {
      const payload = await fetchProfile(p.publicIdentifier, csrf);
      results.push({
        publicIdentifier: p.publicIdentifier,
        location: payload?.__unreachable ? null : extractLocationFrom(payload),
      });
      attempted += 1;
      report({ attempted, located, queued: batch.queued ?? 0 });
      await sleep(PROFILE_DELAY_MS);
    }

    const ack = await chrome.runtime.sendMessage({ type: "enrichResult", results });
    if (!ack?.ok) throw new Error(ack?.error ?? "Rolo rejected the results.");
    located += ack.summary?.located ?? 0;
    if (ack.warning) warning = ack.warning;
    report({ attempted, located, queued: batch.queued ?? 0 });
  }
}

// Structural, like the connections parser: look for keys that mean a place
// anywhere in the response rather than walking a fixed path a rename would
// break. Kept in sync with LOCATION_KEYS in src/lib/linkedin/enrich.ts.
const LOCATION_KEYS = [
  "geoLocationName",
  "locationName",
  "defaultLocalizedName",
  "geoRegionName",
  "displayName",
  "location",
  "geoLocation",
  "geoRegion",
  "country",
  "countryName",
];

function extractLocationFrom(payload) {
  const found = new Map();
  const usable = (v) =>
    typeof v === "string" &&
    v.trim().length >= 2 &&
    v.trim().length <= 120 &&
    !/^urn:/i.test(v.trim()) &&
    !/^[0-9]+$/.test(v.trim());
  const walk = (v, d) => {
    if (d > 10 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, d + 1));
    for (const key of LOCATION_KEYS) {
      if (!found.has(key) && usable(v[key])) found.set(key, v[key].trim());
    }
    Object.values(v).forEach((x) => walk(x, d + 1));
  };
  walk(payload, 0);
  for (const key of LOCATION_KEYS) {
    if (found.has(key)) return found.get(key);
  }
  return null;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "startSync") {
    runSync((progress) =>
      chrome.runtime.sendMessage({ type: "progress", progress })
    )
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) =>
        sendResponse({ ok: false, error: String(err.message ?? err) })
      );
    return true; // async response
  }
  if (msg?.type === "startEnrich") {
    runEnrich((progress) =>
      chrome.runtime.sendMessage({ type: "enrichProgress", progress })
    )
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) =>
        sendResponse({ ok: false, error: String(err.message ?? err) })
      );
    return true;
  }
  return false;
});
