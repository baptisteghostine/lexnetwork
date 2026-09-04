// Service worker: the only part that talks to Rolo.
//
// Content scripts are subject to CORS as the page's origin, so a request
// from linkedin.com to localhost would be blocked. Extension service
// workers with host_permissions are not, which is why the relay lives here.
//
// It also owns the toolbar badge, driven off the same `run` record the
// content script writes for the popup — one state, two readers.

const DEFAULTS = { roloUrl: "http://localhost:3000", token: "" };

async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
}

async function callRolo(path, { method = "POST", body } = {}) {
  const { roloUrl, token } = await settings();
  if (!token) {
    return { ok: false, unpaired: true, error: "No pairing token — set it in the extension popup." };
  }
  let res;
  try {
    res = await fetch(`${roloUrl.replace(/\/+$/, "")}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        authorization: `Bearer ${token}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    return { ok: false, unreachable: true, error: `Can't reach Rolo at ${roloUrl}. Is it running?` };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      unauthorized: res.status === 401,
      error:
        res.status === 401
          ? "Rolo rejected the pairing token — copy it again from Settings."
          : (data.error ?? `Rolo returned HTTP ${res.status}.`),
    };
  }
  return { ok: true, ...data };
}

const postToRolo = (body, path = "/api/linkedin/extension") => callRolo(path, { body });

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "status") {
    // Read-only: pairing check + last sync + location trickle progress.
    callRolo("/api/linkedin/extension", { method: "GET" }).then(sendResponse);
    return true;
  }
  if (msg?.type === "lookup") {
    callRolo(`/api/linkedin/extension/lookup?id=${encodeURIComponent(msg.id)}`, { method: "GET" }).then(
      sendResponse
    );
    return true;
  }
  if (msg?.type === "capture") {
    callRolo("/api/linkedin/extension/capture", { body: { profile: msg.profile } }).then(sendResponse);
    return true;
  }
  if (msg?.type === "page") {
    postToRolo({ sessionId: msg.sessionId, page: msg.payload }).then(sendResponse);
    return true;
  }
  if (msg?.type === "done") {
    postToRolo({ sessionId: msg.sessionId, done: true }).then((r) =>
      sendResponse(r.ok ? { ok: true, result: r } : r)
    );
    return true;
  }
  if (msg?.type === "enrichNext") {
    postToRolo({ action: "next", batchSize: msg.batchSize }, "/api/linkedin/enrich").then(
      sendResponse
    );
    return true;
  }
  if (msg?.type === "enrichResult") {
    postToRolo({ action: "result", results: msg.results }, "/api/linkedin/enrich").then(
      sendResponse
    );
    return true;
  }
  return false;
});

// ---------- toolbar badge ----------
//
// The popup is closed most of the time a sync runs. The badge is the
// glanceable version: a page count while it runs, a tick when it lands,
// a bang when it didn't. Cleared the next time the popup opens.

const BADGE = {
  running: "#4f46e5",
  done: "#059669",
  stopped: "#71717a",
  error: "#dc2626",
};

function badgeFor(run) {
  if (!run) return { text: "", color: BADGE.stopped };
  if (run.status === "running") {
    const p = run.progress ?? {};
    const n = run.kind === "sync" ? p.page : p.attempted;
    return { text: n ? String(n) : "…", color: BADGE.running };
  }
  if (run.status === "done") return { text: "✓", color: BADGE.done };
  if (run.status === "stopped") return { text: "■", color: BADGE.stopped };
  return { text: "!", color: BADGE.error };
}

async function paintBadge(run) {
  const { text, color } = badgeFor(run);
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.run) paintBadge(changes.run.newValue).catch(() => {});
});

// A service worker restarts often; repaint from stored state on wake so
// the badge never lies about a run that is still going.
chrome.storage.local.get("run").then(({ run }) => paintBadge(run)).catch(() => {});
