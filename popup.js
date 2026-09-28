function formatHotkey(h) {
  if (!h) return "Not set";
  return [h.ctrlKey && "Ctrl", h.altKey && "Alt", h.shiftKey && "Shift", h.metaKey && "Cmd",
    h.code.replace(/^(Key|Digit)/, "")].filter(Boolean).join(" + ");
}

function setupHotkeySetting() {
  const btn = document.getElementById('hotkeyBtn');
  const clearBtn = document.getElementById('hotkeyClear');
  chrome.storage.sync.get("hotkey", (d) => (btn.textContent = formatHotkey(d.hotkey)));

  btn.addEventListener('click', () => {
    btn.textContent = "Press combo… (Esc cancels)";
    const onKey = (e) => {
      e.preventDefault();
      if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
      if (e.key === "Escape") {
        document.removeEventListener('keydown', onKey, true);
        chrome.storage.sync.get("hotkey", (d) => (btn.textContent = formatHotkey(d.hotkey)));
        return;
      }
      // Without a modifier the hotkey would fire while typing in page inputs
      if (!(e.ctrlKey || e.altKey || e.metaKey)) {
        btn.textContent = "Include Ctrl, Alt or Cmd";
        return;
      }
      document.removeEventListener('keydown', onKey, true);
      const hotkey = { code: e.code, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, metaKey: e.metaKey };
      chrome.storage.sync.set({ hotkey });
      btn.textContent = formatHotkey(hotkey);
    };
    document.addEventListener('keydown', onKey, true);
  });

  clearBtn.addEventListener('click', () => {
    chrome.storage.sync.remove("hotkey");
    btn.textContent = formatHotkey(null);
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  setupHotkeySetting();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // Chrome does not allow content scripts on chrome:// or webstore pages
  if (!tab || !tab.url || tab.url.startsWith("chrome://") || tab.url.startsWith("https://chromewebstore.google.com")) {
    document.getElementById('controls').innerHTML = "<p style='color:red;padding:10px;'>Cannot run on Chrome system pages. Please open a normal website.</p>";
    return;
  }

  const toggleBtn = document.getElementById('toggleBtn');
  const freezeBtn = document.getElementById('freezeBtn');

  // Ensure content script is running on the page even if user didn't refresh
  async function ensureInjected() {
    try {
      await chrome.tabs.sendMessage(tab.id, { action: "ping" });
    } catch (e) {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    }
  }

  await ensureInjected();

  chrome.tabs.sendMessage(tab.id, { action: "getStatus" }, (response) => {
    if (chrome.runtime.lastError) return;
    if (response && response.isActive) {
      toggleBtn.textContent = "Disable Inspector";
      toggleBtn.style.backgroundColor = "#dc2626";
    }
  });

  toggleBtn.addEventListener('click', async () => {
    await ensureInjected();
    chrome.tabs.sendMessage(tab.id, { action: "toggleInspector" });
    window.close();
  });

  freezeBtn.addEventListener('click', async () => {
    await ensureInjected();
    chrome.tabs.sendMessage(tab.id, { action: "delayedFreeze" });
    window.close();
  });
});