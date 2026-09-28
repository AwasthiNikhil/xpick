document.addEventListener('DOMContentLoaded', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // Chrome does not allow content scripts on chrome:// or webstore pages
  if (!tab || !tab.url || tab.url.startsWith("chrome://") || tab.url.startsWith("https://chromewebstore.google.com")) {
    document.body.innerHTML = "<p style='color:red;padding:10px;'>Cannot run on Chrome system pages. Please open a normal website.</p>";
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