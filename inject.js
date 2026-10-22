// Shared by the popup and the background worker.

// Pages Chrome never lets extensions script.
const RESTRICTED = [/^chrome:/, /^edge:/, /^about:/, /^chrome-extension:/, /^devtools:/, /^view-source:/,
  /^https:\/\/chromewebstore\.google\.com/, /^https:\/\/chrome\.google\.com\/webstore/];

function canInspect(url) {
  return !!url && !RESTRICTED.some((re) => re.test(url));
}

class StaleInspectorError extends Error {
  constructor() {
    super("This page is running an older copy of the inspector. Reload the page, then try again.");
  }
}

// The inspector is injected on demand (activeTab), not into every page.
// If an older version already answers on the page (tabs opened before an
// update), both copies would react to every message, so ask for a reload.
async function ensureInjected(tabId) {
  let reply;
  try {
    reply = await chrome.tabs.sendMessage(tabId, { action: "ping" });
  } catch {
    // nothing listening yet
  }
  if (reply?.version === chrome.runtime.getManifest().version) return;
  if (reply) throw new StaleInspectorError();
  await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ["xpath.js", "content.js"] });
}
