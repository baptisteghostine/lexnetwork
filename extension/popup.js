// Popup controller. It owns no state of its own: pairing lives in
// chrome.storage.local, run progress lives in the `run` record the content
// script writes, and everything about Rolo comes from one GET on open. So
// closing and reopening mid-sync shows the same picture, not a blank.

const DEFAULTS = { roloUrl: "http://localhost:3000", token: "" };
const CONNECTIONS_URL = "https://www.linkedin.com/mynetwork/invite-connect/connections/";
const $ = (id) => document.getElementById(id);

let settings = { ...DEFAULTS };
let status = null; // last GET /api/linkedin/extension, or null
let liTab = null; // the active tab if it is linkedin.com
let runTabId = null; // the tab a run is alive in — not necessarily the active one
let stopping = false;

// ---------- small formatters ----------

const n = (v) => (typeof v === "number" ? v.toLocaleString() : "—");

function ago(ts) {
  if (!ts) return null;
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 14 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function setPill(text, kind) {
  $("pill").textContent = text;
  $("pill").className = `pill ${kind ?? ""}`;
}

// ---------- views ----------

function showSetup(cancellable) {
  $("setup").hidden = false;
  $("main").hidden = true;
  $("cancelSetup").hidden = !cancellable;
  $("roloUrl").value = settings.roloUrl;
  $("token").value = settings.token;
  $("setupMsg").textContent = "";
  $("setupMsg").className = "msg";
  ($("token").value ? $("roloUrl") : $("token")).focus();
}

function showMain() {
  $("setup").hidden = true;
  $("main").hidden = false;
}

function renderStats() {
  const last = status?.lastSync ?? null;
  const e = status?.enrich ?? null;

  $("sConn").textContent = e ? n(e.linkedInContacts) : "—";
  if (last) {
    const st = last.stats ?? {};
    const when = ago(last.finishedAt ?? last.startedAt);
    const delta =
      last.status === "success" || last.status === "partial"
        ? ` · +${n(st.new ?? 0)} new · ${n(st.updated ?? 0)} updated`
        : " · failed";
    $("sLast").textContent = `${when}${delta}`;
    $("sLast").className = `s${last.status === "failed" ? " warn" : ""}`;
  } else {
    $("sLast").textContent = "never synced";
    $("sLast").className = "s";
  }

  if (e) {
    $("sLoc").textContent = `${n(e.located)} / ${n(e.linkedInContacts)}`;
    if (!e.enabled) {
      $("sBudget").textContent = "off in Rolo settings";
      $("sBudget").className = "s warn";
    } else if (e.queued === 0) {
      $("sBudget").textContent = "everyone checked";
      $("sBudget").className = "s";
    } else {
      $("sBudget").textContent = `${n(e.queued)} queued · ${n(e.remainingToday)} left today`;
      $("sBudget").className = "s";
    }
  } else {
    $("sLoc").textContent = "—";
    $("sBudget").textContent = "";
  }
}

function renderTab() {
  const ctx = $("ctx");
  if (liTab) {
    ctx.className = "ctx ok";
    $("ctxText").textContent = "linkedin.com tab active";
    $("openLI").hidden = true;
  } else {
    ctx.className = "ctx";
    $("ctxText").textContent = "Not on LinkedIn";
    $("openLI").hidden = false;
  }
}

function describeResult(run) {
  const r = run.result ?? {};
  if (run.kind === "sync") {
    const s = r.stats ?? {};
    return (
      `${run.status === "stopped" ? "Stopped" : "Done"} — ${n(r.connections ?? 0)} connections over ${n(r.pages ?? 0)} pages.\n` +
      `New ${n(s.new ?? 0)} · updated ${n(s.updated ?? 0)} · unchanged ${n(s.unchanged ?? 0)}\n` +
      // Why it stopped is the difference between "that's everyone" and
      // "paging broke after one page" — unless it was the Stop button.
      (run.status === "stopped" ? "" : `Stopped: ${r.stopReason ?? "unknown"}`)
    ).trimEnd();
  }
  return (
    `${run.status === "stopped" ? "Stopped — read" : "Read"} ${n(r.attempted ?? 0)} profiles · ${n(r.located ?? 0)} had a location.\n` +
    (run.status === "stopped" ? "" : `Stopped: ${r.stopReason ?? "unknown"}`) +
    // A drift warning matters more than the counts — never let an
    // all-placeless run look like a clean one.
    (r.warning ? `\n\n⚠ ${r.warning}` : "")
  ).replace(/\n+(?=\n\n⚠)|\n$/g, "");
}

function renderRun(run) {
  const running = run?.status === "running";
  const progress = $("progress");
  const bar = progress.querySelector(".bar");
  const fill = bar.querySelector("i");
  const text = progress.querySelector(".ptext");
  const result = $("result");

  $("sync").hidden = running;
  $("enrich").hidden = running;
  $("stop").hidden = !running;
  if (!running) stopping = false;
  $("stop").disabled = stopping;
  $("stop").textContent = stopping ? "Stopping…" : "Stop";

  if (running) {
    setPill(run.kind === "sync" ? "Syncing…" : "Reading profiles…", "busy");
    progress.hidden = false;
    result.hidden = true;
    const p = run.progress ?? {};
    let pct = null;
    if (run.kind === "sync") {
      if (p.total) pct = Math.min(100, ((p.seen ?? 0) / p.total) * 100);
      text.textContent = p.page
        ? `Page ${n(p.page)} · ${n(p.seen ?? 0)}${p.total ? ` of ${n(p.total)}` : ""} connections`
        : "Starting…";
    } else {
      if (p.ceiling) pct = Math.min(100, ((p.attempted ?? 0) / p.ceiling) * 100);
      text.textContent = p.attempted
        ? `Profiles read ${n(p.attempted)}${p.ceiling ? ` of ${n(p.ceiling)}` : ""} · ${n(p.located ?? 0)} located`
        : "Asking Rolo who to look up…";
    }
    bar.classList.toggle("indeterminate", pct === null);
    fill.style.width = pct === null ? "" : `${pct}%`;
    return;
  }

  progress.hidden = true;
  if (run && (run.status === "done" || run.status === "stopped" || run.status === "error")) {
    result.hidden = false;
    const when = ago(run.updatedAt);
    if (run.status === "error") {
      result.className = "err";
      result.textContent = run.error ?? "Failed.";
    } else {
      result.className = run.result?.warning ? "warn" : "ok";
      result.textContent = describeResult(run);
    }
    if (when) {
      const w = document.createElement("span");
      w.className = "when";
      w.textContent = `${run.kind === "sync" ? "Sync" : "Locations"} · ${when}`;
      result.prepend(w);
    }
  } else {
    result.hidden = true;
  }
}

function renderHint() {
  const e = status?.enrich ?? null;
  const enrichBtn = $("enrich");
  if (!status) {
    // Whatever the pill says — rejected token, Rolo offline — a sync would
    // only fail on its first page. Say so here instead.
    $("hint").textContent = "Rolo isn't answering with this address and token — fix it via the gear, then try again.";
    $("sync").disabled = true;
    enrichBtn.disabled = true;
    return;
  }
  if (!liTab) {
    $("hint").textContent = "Open a linkedin.com tab, logged in, then sync. Leave the tab open; closing this popup doesn't stop it.";
    $("sync").disabled = true;
    enrichBtn.disabled = true;
    return;
  }
  $("sync").disabled = false;
  if (e && !e.enabled) {
    enrichBtn.disabled = true;
    enrichBtn.title = "Turn on 'Fill in locations from profiles' in Rolo → Settings → Integrations";
    $("hint").textContent = "Locations are read one profile at a time and are off until you turn them on in Rolo.";
  } else {
    enrichBtn.disabled = false;
    enrichBtn.title = "";
    $("hint").textContent = e && e.queued > 0
      ? `Locations trickle in: ${n(Math.min(e.queued, e.remainingToday))} more profiles today, most important people first.`
      : "";
  }
}

// ---------- the page the owner is on ----------
//
// On a profile page the popup answers the one question that matters
// before anything else: is this person in Rolo? Reading the page costs
// no LinkedIn request; the lookup is one GET to Rolo.

let pageProfile = null;

function dueLabel(nextTouchAt, now) {
  if (!nextTouchAt) return null;
  const d = Math.round((nextTouchAt - now) / 86400e3);
  if (d < 0) return `${-d}d overdue`;
  if (d === 0) return "due today";
  if (d === 1) return "due tomorrow";
  if (d < 14) return `due in ${d}d`;
  return `due ${new Date(nextTouchAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

function showPage(name, role, state, kind, { open = false, add = false } = {}) {
  $("page").hidden = false;
  $("pageName").textContent = name;
  $("pageRole").textContent = role ?? "";
  $("pageState").textContent = state;
  $("pageState").className = `state ${kind ?? ""}`;
  $("pageOpen").hidden = !open;
  $("pageAdd").hidden = !add;
  $("pageAdd").disabled = false;
  $("pageAdd").textContent = "Add to Rolo";
  $("pageMsg").hidden = true;
}

async function renderPage() {
  $("page").hidden = true;
  pageProfile = null;
  if (!liTab || !/^https:\/\/www\.linkedin\.com\/in\//.test(liTab.url ?? "")) return;
  const read = await chrome.tabs.sendMessage(liTab.id, { type: "readProfile" }).catch(() => null);
  const profile = read?.profile;
  if (!profile) return;
  pageProfile = profile;
  const name = [profile.firstName, profile.lastName].filter(Boolean).join(" ") || profile.fullName || profile.publicIdentifier;
  showPage(name, profile.headline, "Checking Rolo…");
  if (!status) {
    showPage(name, profile.headline, "Rolo isn't answering — pair first.");
    return;
  }
  const r = await chrome.runtime.sendMessage({ type: "lookup", id: profile.publicIdentifier }).catch(() => null);
  if (!r?.ok) {
    showPage(name, profile.headline, r?.error ?? "Lookup failed.");
    return;
  }
  if (r.found) {
    const c = r.contact;
    const now = Date.now();
    const bits = [
      `In Rolo since ${new Date(c.createdAt).toLocaleDateString(undefined, { month: "short", year: "numeric" })}`,
      c.lastInteractionAt ? `last spoke ${ago(c.lastInteractionAt)}` : "no recorded contact",
      c.cadenceDays ? dueLabel(c.nextTouchAt, now) : null,
      c.archivedAt ? "archived" : null,
    ].filter(Boolean);
    const overdue = c.cadenceDays && c.nextTouchAt && c.nextTouchAt <= now;
    showPage(c.displayName, [c.title, c.company].filter(Boolean).join(", ") || profile.headline, bits.join(" · "), overdue ? "due" : "in", { open: true });
    $("pageOpen").onclick = () => chrome.tabs.create({ url: `${settings.roloUrl}/contacts/${c.id}` });
  } else {
    showPage(name, profile.headline, "Not in Rolo", "out", { add: true });
  }
}

$("pageAdd").addEventListener("click", async () => {
  if (!pageProfile) return;
  $("pageAdd").disabled = true;
  $("pageAdd").textContent = "Adding…";
  const r = await chrome.runtime.sendMessage({ type: "capture", profile: pageProfile }).catch(() => null);
  const msg = $("pageMsg");
  msg.hidden = false;
  if (!r?.ok) {
    msg.className = "msg err";
    msg.textContent = r?.error ?? "Couldn't add.";
    $("pageAdd").disabled = false;
    $("pageAdd").textContent = "Add to Rolo";
    return;
  }
  msg.className = "msg ok";
  msg.textContent = r.created
    ? "Added to Rolo."
    : r.updated
      ? "Already in Rolo — updated from this page."
      : "Already in Rolo — nothing new.";
  if (r.jobChanges) msg.textContent += ` Job change detected.`;
  if (r.conflicts) msg.textContent += ` ${r.conflicts} field${r.conflicts > 1 ? "s" : ""} you'd edited kept as-is.`;
  await renderPage();
  await loadStatus();
  renderStats();
});

// ---------- data ----------

async function loadStatus() {
  setPill("Checking…");
  status = null;
  const r = await chrome.runtime.sendMessage({ type: "status" }).catch(() => null);
  if (r?.ok) {
    status = r;
    setPill("Paired", "ok");
  } else if (r?.unauthorized) {
    setPill("Token rejected", "err");
  } else if (r?.unreachable) {
    setPill("Rolo offline", "err");
  } else if (r?.unpaired) {
    setPill("Not paired", "warn");
  } else {
    setPill(r?.error ? "Error" : "Unknown", "err");
  }
  return r;
}

async function loadTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  liTab = tab?.url?.startsWith("https://www.linkedin.com/") ? tab : null;
}

/** Which linkedin.com tab, if any, has a run going. The owner may well
 * have switched tabs since starting it, so every LinkedIn tab is asked. */
async function findRunningTab() {
  const tabs = await chrome.tabs.query({ url: "https://www.linkedin.com/*" });
  const answers = await Promise.all(
    tabs.map((t) =>
      chrome.tabs.sendMessage(t.id, { type: "isRunning" }).then((r) => (r?.active ? t.id : null)).catch(() => null)
    )
  );
  return answers.find((id) => id !== null) ?? null;
}

async function currentRun() {
  const { run } = await chrome.storage.local.get("run");
  // A run record can outlive the tab that made it (tab closed mid-sync,
  // Chrome restarted). Ask around; if nobody answers, it isn't running.
  if (run?.status === "running") {
    runTabId = await findRunningTab();
    if (runTabId === null) {
      const stale = {
        ...run,
        status: "error",
        error: "The run was interrupted — the LinkedIn tab closed or reloaded. Run it again; nothing was half-written.",
        updatedAt: Date.now(),
      };
      await chrome.storage.local.set({ run: stale });
      return stale;
    }
  }
  return run ?? null;
}

async function refresh() {
  await loadTab();
  renderTab();
  const [, run] = await Promise.all([loadStatus(), currentRun()]);
  renderStats();
  renderRun(run);
  if (run?.status !== "running") renderHint();
  await renderPage();
  // Badge is for when the popup is closed; opening it is having looked.
  if (run?.status !== "running") chrome.action.setBadgeText({ text: "" }).catch(() => {});
}

// ---------- actions ----------

async function start(type) {
  if (!liTab) return;
  const kind = type === "startSync" ? "sync" : "enrich";
  $("sync").disabled = true;
  $("enrich").disabled = true;
  runTabId = liTab.id;
  // The content script answers when the run ends; the popup usually won't
  // be open by then. Progress — and the final result — arrive through the
  // `run` record instead, so the answer here only matters when nobody was
  // there to write that record: a tab with no content script (reloaded
  // since install) throws before anything starts.
  chrome.tabs.sendMessage(liTab.id, { type }).catch(async (err) => {
    await chrome.storage.local.set({
      run: {
        kind,
        status: "error",
        error: `Couldn't reach the page script: ${String(err.message ?? err)}. Reload the LinkedIn tab and retry.`,
        updatedAt: Date.now(),
      },
    });
  });
}

$("sync").addEventListener("click", () => start("startSync"));
$("enrich").addEventListener("click", () => start("startEnrich"));
$("stop").addEventListener("click", async () => {
  const id = runTabId ?? (await findRunningTab());
  if (id === null) return;
  stopping = true;
  $("stop").disabled = true;
  $("stop").textContent = "Stopping…";
  await chrome.tabs.sendMessage(id, { type: "stop" }).catch(() => {});
});

$("gear").addEventListener("click", () => showSetup(Boolean(settings.token)));
$("cancelSetup").addEventListener("click", () => { showMain(); });

$("save").addEventListener("click", async () => {
  settings = {
    roloUrl: $("roloUrl").value.trim().replace(/\/+$/, "") || DEFAULTS.roloUrl,
    token: $("token").value.trim(),
  };
  await chrome.storage.local.set(settings);
  const msg = $("setupMsg");
  msg.className = "msg";
  msg.textContent = "Testing…";
  const r = await loadStatus();
  if (r?.ok) {
    msg.className = "msg ok";
    msg.textContent = "Paired with Rolo.";
    setTimeout(async () => { showMain(); await refresh(); }, 500);
  } else {
    msg.className = "msg err";
    msg.textContent = r?.error ?? "Couldn't reach Rolo.";
  }
});

$("openLI").addEventListener("click", () => chrome.tabs.create({ url: CONNECTIONS_URL }));
$("openRolo").addEventListener("click", () => chrome.tabs.create({ url: settings.roloUrl }));
$("openSettings").addEventListener("click", () =>
  chrome.tabs.create({ url: `${settings.roloUrl}/settings?tab=integrations` })
);

// Live updates while open: the content script writes `run` as it goes.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.run) return;
  const run = changes.run.newValue;
  renderRun(run);
  if (run?.status !== "running") {
    // A finished run changes the numbers; re-read them.
    loadStatus().then(() => { renderStats(); renderHint(); });
  }
});

// ---------- boot ----------

(async () => {
  $("version").textContent = `v${chrome.runtime.getManifest().version}`;
  settings = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
  if (!settings.token) {
    setPill("Not paired", "warn");
    showSetup(false);
    return;
  }
  showMain();
  await refresh();
})();
