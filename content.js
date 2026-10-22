// Injected on demand (popup button or keyboard shortcut), together with xpath.js.
(() => {
  // One live copy per page. A copy left over from an older version, or one
  // cut off from the extension by a reload or update (it can still copy, but
  // can't save history or receive messages), is shut down and replaced.
  const runtime = chrome.runtime;
  const VERSION = runtime.getManifest().version;
  const previous = window.__XPICK__;
  if (previous && previous.version === VERSION && previous.alive()) return;
  try {
    previous?.shutdown();
  } catch {
    // an old copy that can't be shut down cleanly; ours takes over anyway
  }

  const { relativeXPath, absoluteXPath, cssSelector, find } = window.XPick;
  const HISTORY_SIZE = 10;

  let isInspectorActive = false;
  let hoveredElement = null;
  let overlayBadge = null;
  let lastMouse = { x: 0, y: 0 };

  function createBadge() {
    if (overlayBadge) return;
    overlayBadge = document.createElement("div");
    overlayBadge.id = "xpath-overlay-badge";
    overlayBadge.style.display = "none";
    document.documentElement.appendChild(overlayBadge);
  }

  function showToast(text, isError = false) {
    let toast = document.getElementById("xpath-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "xpath-toast";
      document.documentElement.appendChild(toast);
    }
    toast.textContent = text;
    toast.style.background = isError ? "#ef4444" : "#10b981";
    toast.style.display = "block";
    toast.style.opacity = "1";
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => {
      toast.style.opacity = "0";
      setTimeout(() => (toast.style.display = "none"), 300);
    }, 2200);
  }

  // Bulletproof clipboard copy (handles focus issues & insecure origins)
  async function copyTextToClipboard(text) {
    // 1. Try modern Async Clipboard API
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (err) {
        // Fall back below
      }
    }

    // 2. Reliable fallback: hidden textarea
    try {
      const textArea = document.createElement("textarea");
      textArea.value = text;
      textArea.style.position = "fixed";
      textArea.style.top = "0";
      textArea.style.left = "0";
      textArea.style.width = "2em";
      textArea.style.height = "2em";
      textArea.style.padding = "0";
      textArea.style.border = "none";
      textArea.style.outline = "none";
      textArea.style.boxShadow = "none";
      textArea.style.background = "transparent";
      document.documentElement.appendChild(textArea);
      textArea.focus();
      textArea.select();

      const successful = document.execCommand("copy");
      document.documentElement.removeChild(textArea);
      return successful;
    } catch (err) {
      return false;
    }
  }

  function isOurs(el) {
    return el.id === "xpath-overlay-badge" || el.id === "xpath-toast" || el.classList?.contains("xpath-match-box") || el === tester;
  }

  // Highlight an element and show its best XPath in the badge.
  function select(el, inShadow = false) {
    if (!el || isOurs(el)) return;
    if (hoveredElement && hoveredElement !== el) hoveredElement.classList.remove("xpath-highlight-target");
    hoveredElement = el;
    el.classList.add("xpath-highlight-target");

    const best = relativeXPath(el);
    overlayBadge.textContent = best
      ? `${best.xpath}   · ${best.kind}${inShadow ? " · shadow DOM: this is its host" : ""}`
      : "No XPath for this element";
    overlayBadge.style.display = "block";

    // Keep the badge on screen: measure it after filling it in.
    const r = el.getBoundingClientRect();
    const anchor = lastMouse.x || lastMouse.y ? lastMouse : { x: r.left, y: r.top };
    const width = overlayBadge.offsetWidth;
    const x = Math.min(window.innerWidth - width - 10, Math.max(10, anchor.x + 10));
    const y = anchor.y - 40 > 0 ? anchor.y - 40 : anchor.y + 20;
    overlayBadge.style.left = `${x}px`;
    overlayBadge.style.top = `${y}px`;
  }

  // After the extension reloads or updates, this copy is cut off from it.
  function stillConnected() {
    if (runtime?.id) return true;
    shutdown();
    showToast("XPick was updated. Press its shortcut again.", true);
    return false;
  }

  function onMouseMove(e) {
    if (!isInspectorActive || !stillConnected()) return;
    lastMouse = { x: e.clientX, y: e.clientY };
    // Inside a shadow root, events report the host; XPath can't reach further in.
    const inShadow = e.composedPath()[0] !== e.target;
    if (e.target !== hoveredElement) select(e.target, inShadow);
  }

  async function remember(value, type) {
    try {
      const { history = [] } = await chrome.storage.local.get("history");
      history.unshift({ value, type, url: location.href, at: Date.now() });
      await chrome.storage.local.set({ history: history.slice(0, HISTORY_SIZE) });
    } catch {
      // history is a convenience; never block a copy on it
    }
  }

  async function handleCopy(target, type = "XPath") {
    if (!target) return;
    const value =
      type === "absolute XPath" ? absoluteXPath(target) : type === "CSS selector" ? cssSelector(target) : relativeXPath(target)?.xpath;
    if (!value) {
      showToast(`Couldn't make a ${type} for this element.`, true);
      return;
    }
    const copied = await copyTextToClipboard(value);
    if (copied) {
      await remember(value, type);
      showToast(`Copied ${type}: ${value}`);
    } else {
      showToast("Clipboard copy failed. Please grant permission.", true);
    }
  }

  // Arrow keys move the selection through the page's structure.
  function moveSelection(key) {
    const el = hoveredElement;
    if (!el) return;
    const next = {
      ArrowUp: el.parentElement !== document.documentElement ? el.parentElement : null,
      ArrowDown: el.firstElementChild,
      ArrowLeft: el.previousElementSibling,
      ArrowRight: el.nextElementSibling,
    }[key];
    if (next && !isOurs(next)) select(next);
  }

  function onKeyDown(e) {
    if (!isInspectorActive || isOurs(e.target)) return; // typing in the test bar isn't a command
    if (!stillConnected()) return;

    if (e.key === "Escape") {
      toggleInspector(false);
      return;
    }
    if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      e.stopPropagation();
      moveSelection(e.key);
      return;
    }
    // C: best XPath, Shift + C: absolute XPath, S: CSS selector
    const key = e.key.toLowerCase();
    if ((key === "c" || key === "s") && hoveredElement && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      handleCopy(hoveredElement, key === "s" ? "CSS selector" : e.shiftKey ? "absolute XPath" : "XPath");
    }
  }

  function onClick(e) {
    if (!isInspectorActive || isOurs(e.target)) return;
    if (!stillConnected()) return;
    e.preventDefault();
    e.stopPropagation();
    handleCopy(hoveredElement || e.target, e.shiftKey ? "absolute XPath" : "XPath");
  }

  function toggleInspector(forceState) {
    isInspectorActive = typeof forceState === "boolean" ? forceState : !isInspectorActive;

    if (isInspectorActive) {
      createBadge();
      document.addEventListener("mousemove", onMouseMove, true);
      document.addEventListener("click", onClick, true);
      document.addEventListener("keydown", onKeyDown, true);
      showToast("XPath Inspector Active! Press 'C' or Click to grab.");
    } else {
      if (hoveredElement) hoveredElement.classList.remove("xpath-highlight-target");
      hoveredElement = null;
      if (overlayBadge) overlayBadge.style.display = "none";
      document.removeEventListener("mousemove", onMouseMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKeyDown, true);
      showToast("XPath Inspector Disabled");
    }
    return isInspectorActive;
  }

  // Outline elements. Boxes are placed in page coordinates, so they stay on
  // their element when the page scrolls.
  function clearBoxes() {
    document.querySelectorAll(".xpath-match-box").forEach((b) => b.remove());
  }

  function drawBoxes(elements, current = -1) {
    clearBoxes();
    elements.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      const box = document.createElement("div");
      box.className = "xpath-match-box" + (i === current ? " current" : "");
      Object.assign(box.style, { left: `${r.left + scrollX}px`, top: `${r.top + scrollY}px`, width: `${r.width}px`, height: `${r.height}px` });
      document.documentElement.appendChild(box);
    });
  }

  // The popup's Test box: outline every match for a few seconds.
  function testQuery(query) {
    const result = find(query);
    if (result.error) return { error: result.error };
    drawBoxes(result.elements);
    clearTimeout(testQuery.timer);
    testQuery.timer = setTimeout(clearBoxes, 4000);
    return { kind: result.kind, count: result.elements.length };
  }

  // The test bar (its own shortcut): paste an XPath or CSS selector and see its
  // matches while you type. Enter / ↓ for the next match, Shift+Enter / ↑ for
  // the previous, Tab moves between the bar's controls, Esc closes.
  // It lives in a shadow root so the page's CSS (user-select: none, input
  // resets) and its key handlers can't break editing.
  const TESTER_CSS = `
    /* !important so page rules can't move or restyle the bar itself */
    :host { all: initial !important; display: block !important; position: fixed !important; top: 12px !important; left: 50% !important;
      transform: translateX(-50%) !important; z-index: 2147483647 !important; width: min(600px, calc(100vw - 24px)) !important;
      font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important; }
    :host([hidden]) { display: none !important; }
    form { display: flex; align-items: center; gap: 6px; margin: 0; padding: 8px; background: rgba(17, 24, 39, 0.97);
      border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 8px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35); }
    input { flex: 1; min-width: 0; margin: 0; padding: 7px 9px; border: 1px solid #4b5563; border-radius: 6px; background: #111827;
      color: #fff; font: 12px ui-monospace, Menlo, monospace; user-select: text; -webkit-user-select: text; outline: none; }
    input:focus { border-color: #60a5fa; }
    output { flex: none; max-width: 40%; padding: 0 4px; color: #d1d5db; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    output[data-state="ok"] { color: #6ee7b7; }
    output[data-state="error"] { color: #fca5a5; }
    button { flex: none; width: 26px; height: 26px; margin: 0; padding: 0; border: 1px solid #4b5563; border-radius: 6px;
      background: #1f2937; color: #e5e7eb; font: 13px/1 sans-serif; cursor: pointer; }
    button:hover:not(:disabled) { background: #374151; }
    button:disabled { opacity: 0.4; cursor: default; }
    button:focus-visible, input:focus-visible { outline: 2px solid #60a5fa; outline-offset: 1px; }
  `;
  let tester = null; // the shadow host
  let ui = null; // { input, out, prev, next, close }
  let matches = [];
  let current = -1;
  let returnFocus = null;

  function buildTester() {
    tester = document.createElement("xpath-tester"); // a tag of its own, so page rules for div don't reach it
    tester.id = "xpath-tester";
    const root = tester.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${TESTER_CSS}</style>
      <form role="search" aria-label="Test an XPath or CSS selector">
        <input placeholder="Paste an XPath or CSS selector" spellcheck="false" autocomplete="off" aria-label="XPath or CSS selector to test">
        <output aria-live="polite"></output>
        <button type="button" data-step="-1" aria-label="Previous match" title="Previous match (Shift+Enter or ↑)" disabled>↑</button>
        <button type="button" data-step="1" aria-label="Next match" title="Next match (Enter or ↓)" disabled>↓</button>
        <button type="button" data-close aria-label="Close" title="Close (Esc)">✕</button>
      </form>`;
    const [prev, next] = root.querySelectorAll("[data-step]");
    ui = { input: root.querySelector("input"), out: root.querySelector("output"), prev, next, close: root.querySelector("[data-close]") };

    let timer;
    ui.input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => runTester(ui.input.value), 120);
    });
    root.querySelector("form").addEventListener("submit", (e) => e.preventDefault());
    for (const btn of [prev, next]) btn.addEventListener("click", () => step(Number(btn.dataset.step)));
    ui.close.addEventListener("click", closeTester);

    // Keys typed in the bar belong to the bar: the page and the inspector never see them.
    const keep = (e) => e.stopPropagation();
    for (const type of ["keydown", "keyup", "keypress", "input", "paste", "copy", "cut"]) tester.addEventListener(type, keep);
    root.addEventListener("keydown", onTesterKey);
    document.documentElement.appendChild(tester);
  }

  function onTesterKey(e) {
    const onInput = e.target === ui.input;
    if (e.key === "Escape") {
      e.preventDefault();
      closeTester();
    } else if (e.key === "Enter" && onInput) {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      step(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Tab") {
      // Keep focus inside the bar while it's open
      const stops = [ui.input, ui.prev, ui.next, ui.close].filter((el) => !el.disabled);
      const at = stops.indexOf(e.target);
      e.preventDefault();
      stops[(at + (e.shiftKey ? -1 : 1) + stops.length) % stops.length].focus();
    }
  }

  function openTester() {
    if (!tester || tester.hidden) {
      const active = document.activeElement;
      returnFocus = active && active !== tester ? active : null;
    }
    if (!tester) buildTester();
    clearTimeout(testQuery.timer);
    tester.hidden = false;
    ui.input.focus();
    ui.input.select();
    if (ui.input.value) runTester(ui.input.value);
  }

  function setStatus(text, state) {
    ui.out.textContent = text;
    if (state) ui.out.dataset.state = state;
    else delete ui.out.dataset.state;
  }

  function runTester(query) {
    matches = [];
    current = -1;
    clearBoxes();
    ui.prev.disabled = ui.next.disabled = true;
    if (!query.trim()) return setStatus("");
    const result = find(query);
    if (result.error) return setStatus(result.error, "error");
    matches = result.elements;
    if (!matches.length) return setStatus(`No matches (${result.kind})`, "error");
    tester.dataset.kind = result.kind;
    ui.prev.disabled = ui.next.disabled = matches.length < 2;
    showMatch(0);
  }

  function step(by) {
    if (matches.length) showMatch((current + by + matches.length) % matches.length);
  }

  function showMatch(i) {
    current = i;
    matches[i].scrollIntoView({ block: "center", behavior: "instant" });
    drawBoxes(matches, i);
    const n = matches.length;
    const kind = tester.dataset.kind;
    setStatus(n === 1 ? `1 match (${kind})` : `${i + 1} of ${n} matches (${kind}) · Enter for next`, "ok");
  }

  function closeTester() {
    if (!tester) return;
    tester.hidden = true;
    matches = [];
    clearBoxes();
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
  }

  // Remove everything this copy added, so a newer copy can take over cleanly.
  function shutdown() {
    isInspectorActive = false;
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
    hoveredElement?.classList.remove("xpath-highlight-target");
    hoveredElement = null;
    overlayBadge?.remove();
    overlayBadge = null;
    tester?.remove();
    tester = null;
    matches = [];
    clearBoxes();
    try {
      runtime.onMessage.removeListener(onMessage);
    } catch {
      // already cut off from the extension
    }
    if (window.__XPICK__?.shutdown === shutdown) delete window.__XPICK__;
  }

  window.__XPICK__ = { version: VERSION, alive: () => !!runtime?.id, shutdown };

  function onMessage(request, sender, sendResponse) {
    if (request.action === "ping") {
      sendResponse({ status: "alive", version: VERSION });
    } else if (request.action === "toggleInspector") {
      const active = toggleInspector();
      sendResponse({ isActive: active });
    } else if (request.action === "getStatus") {
      sendResponse({ isActive: isInspectorActive });
    } else if (request.action === "testQuery") {
      sendResponse(testQuery(request.query));
    } else if (request.action === "openTester") {
      openTester();
      sendResponse({ open: true });
    } else if (request.action === "delayedFreeze") {
      showToast("Freezing in 3 seconds... Hover over your menu now!");
      setTimeout(() => {
        toggleInspector(true);
        // Suppress events that cause tooltips/dropdowns to vanish
        window.addEventListener("blur", (e) => e.stopImmediatePropagation(), true);
        window.addEventListener("mouseleave", (e) => e.stopImmediatePropagation(), true);
        window.addEventListener("mouseout", (e) => e.stopImmediatePropagation(), true);
        showToast("Frozen! Hover over any item and press 'C' to copy.");
      }, 3000);
      sendResponse({ status: "timing" });
    }
  }
  runtime.onMessage.addListener(onMessage);
})();
