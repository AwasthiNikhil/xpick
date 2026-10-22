// Popup: start the inspector, test a locator, see recent copies and the shortcuts.

const $ = (id) => document.getElementById(id);

const TAGS = { XPath: "xpath", "absolute XPath": "full", "CSS selector": "css" };
const COPY_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/></svg>';
const CHECK_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>';

async function showShortcuts() {
  $("shortcutChange").addEventListener("click", () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }));
  // Missing until the extension is reloaded after an update from 1.0
  if (!chrome.commands) return;
  const commands = await chrome.commands.getAll();
  const key = (name) => commands.find((c) => c.name === name)?.shortcut;
  const inspect = key("toggle-inspector");
  if (inspect) {
    $("toggleKey").textContent = inspect;
    $("toggleKey").hidden = false;
  }
  $("testKey").textContent = key("test-query") || "not set";
}

function timeAgo(at) {
  const min = Math.floor((Date.now() - at) / 60000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  if (min < 24 * 60) return `${Math.floor(min / 60)}h`;
  const days = Math.floor(min / (24 * 60));
  return days === 1 ? "yesterday" : `${days}d`;
}

async function showHistory() {
  const list = $("history");
  const { history = [] } = await chrome.storage.local.get("history");
  $("clearHistory").hidden = !history.length;
  if (!history.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Locators you copy show up here.";
    list.replaceChildren(li);
    return;
  }
  list.replaceChildren(
    ...history.map((item) => {
      let host = "";
      try {
        host = new URL(item.url).host;
      } catch {}
      const metaText = [host, timeAgo(item.at)].filter(Boolean).join(" · ");

      const btn = document.createElement("button");
      btn.title = "Copy again";
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.dataset.tag = TAGS[item.type] || "xpath";
      tag.textContent = tag.dataset.tag;
      const entry = document.createElement("span");
      entry.className = "entry";
      const value = document.createElement("span");
      value.className = "value";
      value.textContent = item.value;
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = metaText;
      entry.append(value, meta);
      const icon = document.createElement("span");
      icon.className = "icon";
      icon.innerHTML = COPY_ICON;
      btn.append(tag, entry, icon);

      btn.addEventListener("click", async () => {
        await navigator.clipboard.writeText(item.value);
        meta.textContent = "Copied";
        icon.innerHTML = CHECK_ICON;
        btn.dataset.copied = "";
        clearTimeout(btn.timer);
        btn.timer = setTimeout(() => {
          meta.textContent = metaText;
          icon.innerHTML = COPY_ICON;
          delete btn.dataset.copied;
        }, 1200);
      });
      const li = document.createElement("li");
      li.append(btn);
      return li;
    }),
  );
}

// The result sits in the input as a chip; the line below says what kind of query it was.
function setResult(chip = "", note = "", state) {
  $("queryChip").textContent = chip;
  $("queryNote").textContent = note;
  if (state) $("queryField").dataset.state = state;
  else delete $("queryField").dataset.state;
}

function showOn(on) {
  $("status").dataset.on = String(on);
  $("status").textContent = on ? "Inspecting" : "Off";
  $("toggleBtn").dataset.on = String(on);
  $("toggleLabel").textContent = on ? "Stop inspecting" : "Inspect";
}

document.addEventListener("DOMContentLoaded", async () => {
  showShortcuts();
  showHistory();
  $("clearHistory").addEventListener("click", async () => {
    await chrome.storage.local.remove("history");
    await showHistory();
    $("queryInput").focus(); // the Clear button is gone now
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const disable = (message) => {
    $("notice").textContent = message;
    $("notice").hidden = false;
    for (const id of ["toggleBtn", "freezeBtn", "queryInput"]) $(id).disabled = true;
  };

  // Chrome does not allow extensions on its own pages or the Web Store
  if (!tab || !canInspect(tab.url)) {
    disable("Chrome pages can't be inspected. Open a website.");
    return;
  }

  // Is the inspector already on in this tab? (No answer means it isn't loaded yet.)
  chrome.tabs.sendMessage(tab.id, { action: "getStatus" }).then(
    (res) => showOn(!!res?.isActive),
    () => {},
  );

  // Loads the inspector into the page if needed. False (with a notice) if it can't.
  async function ready() {
    try {
      await ensureInjected(tab.id);
      return true;
    } catch (err) {
      disable(
        err instanceof StaleInspectorError
          ? err.message
          : 'This page blocks extensions. For local files, turn on "Allow access to file URLs" for this extension.',
      );
      return false;
    }
  }

  async function send(action) {
    if (!(await ready())) return;
    await chrome.tabs.sendMessage(tab.id, { action });
    window.close();
  }
  $("toggleBtn").addEventListener("click", () => send("toggleInspector"));
  $("freezeBtn").addEventListener("click", () => send("delayedFreeze"));

  // Results while you type; matches are outlined on the page.
  let timer;
  async function runQuery() {
    const query = $("queryInput").value.trim();
    if (!query) return setResult();
    if (!(await ready())) return;
    let res;
    try {
      res = await chrome.tabs.sendMessage(tab.id, { action: "testQuery", query });
    } catch {}
    if (!res) setResult("Error", "The page didn't answer. Reload it and try again.", "error");
    else if (res.error) setResult("Invalid", res.error === "Invalid XPath" ? "Not a valid XPath" : "Not a valid CSS selector", "error");
    else if (res.count === 0) setResult("No match", res.kind, "error");
    else setResult(res.count === 1 ? "1 match" : `${res.count} matches`, `${res.kind} · outlined on the page`, "ok");
  }
  $("queryInput").addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(runQuery, 250);
  });
  $("queryInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      clearTimeout(timer);
      runQuery();
    }
  });
});
