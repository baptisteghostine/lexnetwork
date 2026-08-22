// Service worker: the only part that talks to Rolo.
//
// Content scripts are subject to CORS as the page's origin, so a POST from
// linkedin.com to localhost would be blocked. Extension service workers
// with host_permissions are not, which is why the relay lives here.

const DEFAULTS = { roloUrl: "http://localhost:3000", token: "" };

async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
}

async function postToRolo(body) {
  const { roloUrl, token } = await settings();
  if (!token) {
    return { ok: false, error: "No pairing token — set it in the extension popup." };
  }
  let res;
  try {
    res = await fetch(`${roloUrl.replace(/\/+$/, "")}/api/linkedin/extension`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: `Can't reach Rolo at ${roloUrl}. Is it running?` };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false,
      error:
        res.status === 401
          ? "Rolo rejected the pairing token — copy it again from Settings."
          : (data.error ?? `Rolo returned HTTP ${res.status}.`),
    };
  }
  return { ok: true, ...data };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
  // 'progress' messages are for the popup; nothing to do here.
  return false;
});
