const DEFAULTS = { roloUrl: "http://localhost:3000", token: "" };
const $ = (id) => document.getElementById(id);

function say(text, kind) {
  const el = $("status");
  el.textContent = text;
  el.className = kind ?? "";
}

(async () => {
  const saved = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
  $("roloUrl").value = saved.roloUrl;
  $("token").value = saved.token;
})();

$("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    roloUrl: $("roloUrl").value.trim() || DEFAULTS.roloUrl,
    token: $("token").value.trim(),
  });
  say("Saved.", "ok");
});

// Progress arrives from the content script while the popup is open. It
// closing doesn't stop the sync — the tab keeps working.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "progress") return;
  const { page, seen, total } = msg.progress;
  say(`Page ${page} · ${seen}${total ? ` of ${total}` : ""} connections…`);
});

$("sync").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.startsWith("https://www.linkedin.com/")) {
    say("Open a linkedin.com tab first, then click Sync.", "err");
    return;
  }
  $("sync").disabled = true;
  say("Starting…");
  try {
    const result = await chrome.tabs.sendMessage(tab.id, { type: "startSync" });
    if (!result?.ok) {
      say(result?.error ?? "Sync failed.", "err");
    } else {
      const r = result.result ?? {};
      const s = r.stats ?? {};
      say(
        `Done — ${r.connections ?? 0} connections over ${r.pages ?? 0} pages.\n` +
          `New ${s.new ?? 0} · updated ${s.updated ?? 0} · unchanged ${s.unchanged ?? 0}\n` +
          // Why it stopped is the difference between "that's everyone"
          // and "paging broke after one page".
          `Stopped: ${r.stopReason ?? "unknown"}`,
        "ok"
      );
    }
  } catch (err) {
    say(
      `Couldn't reach the page script: ${String(err.message ?? err)}. Reload the LinkedIn tab and retry.`,
      "err"
    );
  } finally {
    $("sync").disabled = false;
  }
});
