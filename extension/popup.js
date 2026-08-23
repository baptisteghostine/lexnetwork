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
  if (msg?.type === "progress") {
    const { page, seen, total } = msg.progress;
    say(`Page ${page} · ${seen}${total ? ` of ${total}` : ""} connections…`);
    return;
  }
  if (msg?.type === "enrichProgress") {
    const { attempted, located, queued } = msg.progress;
    say(`Profiles read ${attempted}${queued ? ` of ${queued} queued` : ""} · ${located} located…`);
  }
});

/** Both buttons need the same "are we on LinkedIn" check and the same
 * disable-while-running dance; only the message and the summary differ. */
async function runInTab(button, message, describe) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.startsWith("https://www.linkedin.com/")) {
    say("Open a linkedin.com tab first, then click again.", "err");
    return;
  }
  $("sync").disabled = true;
  $("enrich").disabled = true;
  say("Starting…");
  try {
    const result = await chrome.tabs.sendMessage(tab.id, { type: message });
    if (!result?.ok) {
      say(result?.error ?? "Failed.", "err");
    } else {
      say(describe(result.result ?? {}), "ok");
    }
  } catch (err) {
    say(
      `Couldn't reach the page script: ${String(err.message ?? err)}. Reload the LinkedIn tab and retry.`,
      "err"
    );
  } finally {
    $("sync").disabled = false;
    $("enrich").disabled = false;
  }
}

$("enrich").addEventListener("click", () =>
  runInTab(
    $("enrich"),
    "startEnrich",
    (r) =>
      `Read ${r.attempted ?? 0} profiles · ${r.located ?? 0} had a location.\n` +
      `Stopped: ${r.stopReason ?? "unknown"}` +
      // A drift warning matters more than the counts — surface it, never
      // let an all-placeless run look like a clean one.
      (r.warning ? `\n\n⚠ ${r.warning}` : "")
  )
);

$("sync").addEventListener("click", () =>
  runInTab($("sync"), "startSync", (r) => {
    const s = r.stats ?? {};
    return (
      `Done — ${r.connections ?? 0} connections over ${r.pages ?? 0} pages.\n` +
      `New ${s.new ?? 0} · updated ${s.updated ?? 0} · unchanged ${s.unchanged ?? 0}\n` +
      // Why it stopped is the difference between "that's everyone"
      // and "paging broke after one page".
      `Stopped: ${r.stopReason ?? "unknown"}`
    );
  })
);
