// Handles the keyboard shortcut. Pressing an extension shortcut grants
// activeTab for that tab, so no script has to run on every page beforehand.
importScripts("inject.js");

// Each shortcut sends one message to the page.
const ACTIONS = { "toggle-inspector": "toggleInspector", "test-query": "openTester" };

async function runInTab(tab, action) {
  if (!tab?.id || !canInspect(tab.url)) return;
  try {
    await ensureInjected(tab.id);
    await chrome.tabs.sendMessage(tab.id, { action });
  } catch {
    // e.g. a file:// page without "Allow access to file URLs", or an older
    // copy of the inspector still on the page
  }
}

const toggleInTab = (tab) => runInTab(tab, "toggleInspector");
const openTesterInTab = (tab) => runInTab(tab, "openTester");

chrome.commands.onCommand.addListener((command, tab) => {
  if (ACTIONS[command]) runInTab(tab, ACTIONS[command]);
});
