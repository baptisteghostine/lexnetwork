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

// ---------- run state ----------
//
// One record in chrome.storage.local, `run`, is the whole UI contract: the
// popup renders from it (so reopening mid-sync shows live progress, not a
// blank), and the service worker paints the badge from it. Written here
// because this is where the truth is.

let active = null; // "sync" | "enrich" while a run is going, else null
let stopRequested = false;

async function setRun(patch) {
  const { run } = await chrome.storage.local.get("run");
  await chrome.storage.local.set({
    run: { ...(run ?? {}), ...patch, updatedAt: Date.now() },
  });
}

async function beginRun(kind) {
  if (active) throw new Error(`A ${active} run is already going in this tab.`);
  active = kind;
  stopRequested = false;
  await setRun({ kind, status: "running", startedAt: Date.now(), progress: {}, result: null, error: null });
}

async function endRun(patch) {
  active = null;
  await setRun(patch);
}

class Stopped extends Error {}

/** Sleep that wakes early on Stop, so the button feels immediate instead
 * of waiting out a 4 s profile delay. */
async function sleep(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (stopRequested) throw new Stopped();
    await new Promise((r) => setTimeout(r, Math.min(250, until - Date.now())));
  }
}

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
    if (stopRequested) {
      stopReason = "stopped by you";
      break;
    }
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
    await setRun({ progress: { page: page + 1, seen, total } });

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

    try {
      await sleep(PAGE_DELAY_MS);
    } catch (err) {
      if (!(err instanceof Stopped)) throw err;
      stopReason = "stopped by you";
      break;
    }
  }

  // Stopping early still imports what was fetched: imports only ever add
  // or update, so a partial list is a smaller list, never a wrong one.
  // (An empty first page still goes to Rolo, which fails it loudly as a
  // shape change — that message is the useful one.)
  if (seen === 0 && stopReason === "stopped by you") {
    throw new Error("Stopped before the first page landed — nothing imported.");
  }
  const done = await chrome.runtime.sendMessage({
    type: "done",
    sessionId,
    stopReason,
  });
  if (!done?.ok) throw new Error(done?.error ?? "Rolo rejected the import.");
  return { ...done.result, stopReason, stopped: stopReason === "stopped by you" };
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

  // Everything the extension has learned but not yet handed back. Flushed
  // after each batch, and on Stop — a checked profile must be stamped
  // even when the run ends early, or the queue re-offers it tomorrow.
  let pending = [];
  const flush = async () => {
    if (pending.length === 0) return;
    const ack = await chrome.runtime.sendMessage({ type: "enrichResult", results: pending });
    pending = [];
    if (!ack?.ok) throw new Error(ack?.error ?? "Rolo rejected the results.");
    located += ack.summary?.located ?? 0;
    if (ack.warning) warning = ack.warning;
  };

  for (;;) {
    if (stopRequested) {
      await flush();
      return { attempted, located, stopReason: "stopped by you", stopped: true, warning };
    }
    const batch = await chrome.runtime.sendMessage({
      type: "enrichNext",
      batchSize: ENRICH_BATCH,
    });
    if (!batch?.ok) throw new Error(batch?.error ?? "Rolo wouldn't hand out work.");
    const profiles = batch.profiles ?? [];
    const queued = batch.queued ?? 0;
    const remainingToday = batch.remainingToday ?? 0;
    // Empty means either the queue is drained or today's budget is spent.
    // Both are a clean stop, not a failure.
    if (profiles.length === 0) {
      return {
        attempted,
        located,
        queued,
        stopReason:
          queued > 0
            ? "today's budget is spent — it picks up again tomorrow"
            : "every contact has been checked",
        warning,
      };
    }
    // How far this run can go: what's queued, bounded by today's budget
    // (which already excludes this batch, hence adding it back).
    const ceiling = attempted + Math.min(queued, remainingToday + profiles.length);

    for (const p of profiles) {
      if (stopRequested) break;
      const payload = await fetchProfile(p.publicIdentifier, csrf);
      pending.push({
        publicIdentifier: p.publicIdentifier,
        location: payload?.__unreachable ? null : extractLocationFrom(payload),
      });
      attempted += 1;
      const progress = { attempted, located, queued, ceiling };
      report(progress);
      await setRun({ progress });
      try {
        await sleep(PROFILE_DELAY_MS);
      } catch (err) {
        if (!(err instanceof Stopped)) throw err;
        break;
      }
    }

    await flush();
    const progress = { attempted, located, queued, ceiling };
    report(progress);
    await setRun({ progress });
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

// ---------- reading the page the owner is on (SPEC §9c capture) ----------
//
// Nothing here makes a request. A profile page already carries what Rolo
// needs — LinkedIn embeds its own API responses in <code> blocks for the
// SPA to hydrate from, and the visible heading is a fallback when it
// navigated client-side and those blocks are stale.

function profileIdFromLocation() {
  const m = location.pathname.match(/^\/in\/([^/]+)\/?/);
  return m ? decodeURIComponent(m[1]).toLowerCase() : null;
}

/** Find the profile record for `id` in an embedded API blob: an object
 * whose publicIdentifier matches, with at least a name part. */
function findProfileRecord(value, id, depth = 0) {
  if (depth > 12 || !value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const v of value) {
      const hit = findProfileRecord(v, id, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (
    typeof value.publicIdentifier === "string" &&
    value.publicIdentifier.toLowerCase() === id &&
    (typeof value.firstName === "string" || typeof value.lastName === "string")
  ) {
    return value;
  }
  for (const v of Object.values(value)) {
    const hit = findProfileRecord(v, id, depth + 1);
    if (hit) return hit;
  }
  return null;
}

function textOf(selector) {
  const el = document.querySelector(selector);
  const t = el?.textContent?.replace(/\s+/g, " ").trim();
  return t ? t : null;
}

function readProfile() {
  const publicIdentifier = profileIdFromLocation();
  if (!publicIdentifier) return null;

  let record = null;
  for (const code of document.querySelectorAll('code[id^="bpr-guid-"], code[id^="datalet-bpr-guid-"]')) {
    let data;
    try {
      data = JSON.parse(code.textContent);
    } catch {
      continue;
    }
    const hit = findProfileRecord(data, publicIdentifier);
    if (!hit) continue;
    record = { ...(record ?? {}), ...hit };
  }

  // The visible page, for client-side navigations where the blobs
  // describe whoever the tab was first opened on.
  const fullName = textOf("main h1");
  const headline = textOf("main .text-body-medium.break-words");
  const location = textOf("main .text-body-small.inline.t-black--light.break-words");

  const structuredName = record && (record.firstName || record.lastName);
  return {
    publicIdentifier,
    firstName: structuredName ? (record.firstName ?? null) : null,
    lastName: structuredName ? (record.lastName ?? null) : null,
    fullName,
    headline: record?.headline ?? record?.occupation ?? headline,
    location: (record ? extractLocationFrom(record) : null) ?? location,
  };
}

/** Start a run, keep the `run` record honest to the end, and answer the
 * popup if it is still open to hear. Progress reports go to the record
 * (the popup watches storage), not to the popup directly. */
function launch(kind, fn, sendResponse) {
  const noop = () => {};
  beginRun(kind)
    .then(() => fn(noop))
    .then(async (result) => {
      await endRun({ status: result?.stopped ? "stopped" : "done", result });
      sendResponse({ ok: true, result });
    })
    .catch(async (err) => {
      const error = String(err?.message ?? err);
      await endRun({ status: "error", error });
      sendResponse({ ok: false, error });
    });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "startSync") {
    launch("sync", runSync, sendResponse);
    return true; // async response
  }
  if (msg?.type === "startEnrich") {
    launch("enrich", runEnrich, sendResponse);
    return true;
  }
  if (msg?.type === "stop") {
    stopRequested = true;
    sendResponse({ ok: true, active });
    return false;
  }
  if (msg?.type === "isRunning") {
    sendResponse({ ok: true, active });
    return false;
  }
  if (msg?.type === "readProfile") {
    try {
      sendResponse({ ok: true, profile: readProfile() });
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message ?? err) });
    }
    return false;
  }
  return false;
});
