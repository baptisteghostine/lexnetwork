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
  if (msg?.type === "logConversation") {
    callRolo("/api/linkedin/extension/messages", { body: { conversation: msg.conversation } }).then(sendResponse);
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

// ---------- scheduled weekly sync (opt-in) ----------
//
// "Remember to click" is the failure mode of a manual sync. With the
// toggle on, a chrome.alarms alarm fires weekly and runs the connection
// sync in a LinkedIn tab — an existing one, or a background one it opens
// at the connections page. Pacing is the content script's and unchanged.
// If the owner isn't logged in, the content script fails on the missing
// session cookie and the badge goes red; nothing retries, nothing works
// around it. Off by default: opening a tab unprompted is a bigger ask
// than answering a click.

const ALARM = "rolo-weekly-sync";
const WEEK_MINUTES = 7 * 24 * 60;
const CONNECTIONS_URL = "https://www.linkedin.com/mynetwork/invite-connect/connections/";

async function applyAutoSync(enabled) {
  if (!enabled) {
    await chrome.alarms.clear(ALARM);
    return null;
  }
  const existing = await chrome.alarms.get(ALARM);
  if (existing) return existing.scheduledTime;
  // First run a minute out — a toggle flip should visibly do something —
  // then weekly.
  await chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: WEEK_MINUTES });
  return (await chrome.alarms.get(ALARM))?.scheduledTime ?? null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** A tab whose content script answers, or null. */
async function contentReady(tabId) {
  for (let i = 0; i < 20; i++) {
    const r = await chrome.tabs.sendMessage(tabId, { type: "isRunning" }).catch(() => null);
    if (r?.ok) return r;
    await sleep(1000);
  }
  return null;
}

async function runScheduledSync() {
  const { autoSync, run } = await chrome.storage.local.get(["autoSync", "run"]);
  if (!autoSync) return;
  if (run?.status === "running") return; // never stack a second run
  const { token } = await settings();
  if (!token) return;

  let [tab] = await chrome.tabs.query({ url: "https://www.linkedin.com/*" });
  let opened = false;
  if (!tab) {
    tab = await chrome.tabs.create({ url: CONNECTIONS_URL, active: false });
    opened = true;
  }
  const ready = await contentReady(tab.id);
  if (!ready) {
    await chrome.storage.local.set({
      run: {
        kind: "sync",
        status: "error",
        error: "Scheduled sync couldn't reach the LinkedIn tab — reload linkedin.com once and it will pick up next week.",
        updatedAt: Date.now(),
      },
    });
    return;
  }
  if (ready.active) return; // the owner started one by hand — leave it
  // Fire and forget: the run reports through the `run` record.
  chrome.tabs.sendMessage(tab.id, { type: "startSync" }).catch(() => {});
  await chrome.storage.local.set({ autoSyncLastAt: Date.now(), autoSyncOpenedTab: opened ? tab.id : null });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) runScheduledSync().catch((err) => console.error("[rolo] scheduled sync:", err));
});

// A scheduled run that opened its own tab closes it again once done, so
// the owner doesn't wake up to a stray LinkedIn tab.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || !changes.run) return;
  const run = changes.run.newValue;
  if (!run || run.status === "running") return;
  const { autoSyncOpenedTab } = await chrome.storage.local.get("autoSyncOpenedTab");
  if (autoSyncOpenedTab && run.kind === "sync" && run.status !== "error") {
    await chrome.tabs.remove(autoSyncOpenedTab).catch(() => {});
    await chrome.storage.local.set({ autoSyncOpenedTab: null });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "setAutoSync") {
    chrome.storage.local
      .set({ autoSync: Boolean(msg.enabled) })
      .then(() => applyAutoSync(Boolean(msg.enabled)))
      .then((next) => sendResponse({ ok: true, next }));
    return true;
  }
  if (msg?.type === "autoSyncStatus") {
    chrome.storage.local.get(["autoSync", "autoSyncLastAt"]).then(async ({ autoSync, autoSyncLastAt }) => {
      const alarm = autoSync ? await chrome.alarms.get(ALARM) : null;
      sendResponse({ ok: true, enabled: Boolean(autoSync), next: alarm?.scheduledTime ?? null, last: autoSyncLastAt ?? null });
    });
    return true;
  }
  return false;
});

// Alarms survive browser restarts but not an extension reload; re-arm
// from the stored toggle on every worker start.
chrome.storage.local.get("autoSync").then(({ autoSync }) => applyAutoSync(Boolean(autoSync))).catch(() => {});
