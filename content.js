(() => {
  // Prevent duplicate injections
  if (window.__XPATH_GRABBER_LOADED__) return;
  window.__XPATH_GRABBER_LOADED__ = true;

  let isInspectorActive = false;
  let hoveredElement = null;
  let overlayBadge = null;

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

    setTimeout(() => {
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

  function getRelativeXPath(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return "";
    if (element.id && !/\d{4,}/.test(element.id)) {
      return `//*[@id="${element.id}"]`;
    }

    const paths = [];
    for (; element && element.nodeType === Node.ELEMENT_NODE; element = element.parentNode) {
      let index = 0;
      let hasSameTagSiblings = false;
      const tag = (element.localName || element.nodeName).toLowerCase();

      for (let sibling = element.previousSibling; sibling; sibling = sibling.previousSibling) {
        if (sibling.nodeType === Node.DOCUMENT_TYPE_NODE) continue;
        const siblingTag = (sibling.localName || sibling.nodeName || "").toLowerCase();
        if (siblingTag === tag) {
          hasSameTagSiblings = true;
          index++;
        }
      }

      if (!hasSameTagSiblings) {
        for (let sibling = element.nextSibling; sibling; sibling = sibling.nextSibling) {
          const siblingTag = (sibling.localName || sibling.nodeName || "").toLowerCase();
          if (siblingTag === tag) {
            hasSameTagSiblings = true;
            break;
          }
        }
      }

      const pathIndex = hasSameTagSiblings ? `[${index + 1}]` : "";
      paths.unshift(tag + pathIndex);

      if (element.id && !/\d{4,}/.test(element.id)) {
        paths[0] = `*[@id="${element.id}"]`;
        break;
      }
    }
    return paths.length ? "//" + paths.join("/") : "";
  }

  function getAbsoluteXPath(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return "";
    const tag = (element.localName || element.nodeName).toLowerCase();
    if (tag === "html") return "/html[1]";
    if (element === document.body) return "/html[1]/body[1]";

    let index = 0;
    const siblings = element.parentNode ? element.parentNode.childNodes : [];
    for (let i = 0; i < siblings.length; i++) {
      const sibling = siblings[i];
      if (sibling === element) {
        return `${getAbsoluteXPath(element.parentNode)}/${tag}[${index + 1}]`;
      }
      if (sibling.nodeType === 1 && (sibling.localName || sibling.nodeName).toLowerCase() === tag) {
        index++;
      }
    }
    return "";
  }

  function onMouseMove(e) {
    if (!isInspectorActive) return;
    const target = e.target;
    if (target.id === "xpath-overlay-badge" || target.id === "xpath-toast") return;

    if (hoveredElement && hoveredElement !== target) {
      hoveredElement.classList.remove("xpath-highlight-target");
    }

    hoveredElement = target;
    hoveredElement.classList.add("xpath-highlight-target");

    const xpath = getRelativeXPath(target);
    overlayBadge.textContent = xpath;
    overlayBadge.style.display = "block";

    const x = Math.min(window.innerWidth - 320, Math.max(10, e.clientX + 10));
    const y = e.clientY - 40 > 0 ? e.clientY - 40 : e.clientY + 20;
    overlayBadge.style.left = `${x}px`;
    overlayBadge.style.top = `${y}px`;
  }

  async function handleCopy(target, absolute = false) {
    if (!target) return;
    const xpath = absolute ? getAbsoluteXPath(target) : getRelativeXPath(target);
    
    const copied = await copyTextToClipboard(xpath);
    if (copied) {
      showToast(`Copied XPath: ${xpath}`);
    } else {
      showToast("Clipboard copy failed. Please grant permission.", true);
    }
  }

  function onKeyDown(e) {
    if (!isInspectorActive) return;

    if (e.key === "Escape") {
      toggleInspector(false);
      return;
    }

    // Press 'C' for Relative XPath, 'Shift + C' for Absolute
    if (e.key.toLowerCase() === "c" && hoveredElement) {
      e.preventDefault();
      e.stopPropagation();
      handleCopy(hoveredElement, e.shiftKey);
    }
  }

  function onClick(e) {
    if (!isInspectorActive) return;
    e.preventDefault();
    e.stopPropagation();
    handleCopy(e.target, e.shiftKey);
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
      if (overlayBadge) overlayBadge.style.display = "none";
      document.removeEventListener("mousemove", onMouseMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKeyDown, true);
      showToast("XPath Inspector Disabled");
    }
    return isInspectorActive;
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "ping") {
      sendResponse({ status: "alive" });
    } else if (request.action === "toggleInspector") {
      const active = toggleInspector();
      sendResponse({ isActive: active });
    } else if (request.action === "getStatus") {
      sendResponse({ isActive: isInspectorActive });
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
  });
})();