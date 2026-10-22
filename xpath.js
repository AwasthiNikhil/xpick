// Locator generation, shared by the extension (content.js) and the tests.
// No chrome.* APIs in here, so it runs in any page.
//
// Every XPath and CSS selector is checked against the live document before it
// is returned: it must match exactly the element it was made for.
(() => {
  const HTML_NS = "http://www.w3.org/1999/xhtml";

  // Attributes that test frameworks use as stable hooks, best first.
  const TEST_ATTRS = ["data-testid", "data-test-id", "data-test", "data-cy", "data-qa"];
  // Elements whose visible text makes a good locator.
  const TEXT_TAGS = new Set(["a", "button", "label", "summary", "option", "legend", "th", "h1", "h2", "h3", "h4", "h5", "h6"]);
  const MAX_TEXT = 40;

  // Ids that frameworks generate, which change between renders or builds.
  const GENERATED_ID = [
    /\d{4,}/, // long numbers
    /:r[0-9a-z]+:/i, // React useId, e.g. ":r1:"
    /^ember\d+$/i, // Ember
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i, // UUIDs
    /^(?:mui|rc|radix|headlessui|react-aria|chakra|downshift)[-:_]/i, // UI libraries
  ];

  function isGeneratedId(id) {
    return GENERATED_ID.some((re) => re.test(id));
  }

  // An XPath string literal for any value, including ones with both quote kinds.
  function literal(value) {
    if (!value.includes('"')) return `"${value}"`;
    if (!value.includes("'")) return `'${value}'`;
    return `concat(${value.split('"').map((part) => `"${part}"`).join(`, '"', `)})`;
  }

  // The name test for one step. Unprefixed names in an HTML document only
  // match HTML elements, so SVG and MathML elements need local-name().
  function nameTest(el) {
    const name = el.localName;
    return el.namespaceURI === HTML_NS ? name : `*[local-name()=${literal(name)}]`;
  }

  // 1-based position among element siblings with the same name and namespace,
  // and whether there are any such siblings at all.
  function position(el) {
    let index = 1;
    let others = false;
    for (let s = el.parentElement?.firstElementChild; s; s = s.nextElementSibling) {
      if (s === el) continue;
      if (s.localName === el.localName && s.namespaceURI === el.namespaceURI) {
        others = true;
        if (s.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) index++;
      }
    }
    return { index, others };
  }

  function step(el, alwaysIndex) {
    const { index, others } = position(el);
    return nameTest(el) + (alwaysIndex || others ? `[${index}]` : "");
  }

  function evaluate(xpath, root = document) {
    try {
      const res = root.evaluate(xpath, root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      return Array.from({ length: res.snapshotLength }, (_, i) => res.snapshotItem(i));
    } catch {
      return null; // invalid XPath
    }
  }

  // True if the XPath matches exactly this element and nothing else.
  function pointsTo(xpath, el) {
    const found = evaluate(xpath, el.ownerDocument);
    return !!found && found.length === 1 && found[0] === el;
  }

  function ownText(el) {
    const text = el.textContent.replace(/\s+/g, " ").trim();
    return text && text.length <= MAX_TEXT ? text : null;
  }

  // Attribute-based locators for one element, best first. Not yet checked.
  function attributeLocators(el) {
    const tag = nameTest(el);
    const out = [];
    if (el.id && !isGeneratedId(el.id)) out.push({ kind: "id", xpath: `//*[@id=${literal(el.id)}]` });
    for (const attr of TEST_ATTRS) {
      const v = el.getAttribute(attr);
      if (v) out.push({ kind: "test id", xpath: `//*[@${attr}=${literal(v)}]` });
    }
    const name = el.getAttribute("name");
    if (name && /^(input|select|textarea|button|form|iframe)$/.test(el.localName)) {
      out.push({ kind: "name", xpath: `//${tag}[@name=${literal(name)}]` });
    }
    const aria = el.getAttribute("aria-label");
    if (aria) out.push({ kind: "aria-label", xpath: `//${tag}[@aria-label=${literal(aria)}]` });
    if (TEXT_TAGS.has(el.localName)) {
      const text = ownText(el);
      if (text) out.push({ kind: "text", xpath: `//${tag}[normalize-space()=${literal(text)}]` });
    }
    for (const attr of ["placeholder", "alt", "title"]) {
      const v = el.getAttribute(attr);
      if (v && v.length <= MAX_TEXT) out.push({ kind: attr, xpath: `//${tag}[@${attr}=${literal(v)}]` });
    }
    const href = el.localName === "a" && el.getAttribute("href");
    if (href && href.length <= 80 && !href.startsWith("javascript:")) {
      out.push({ kind: "href", xpath: `//a[@href=${literal(href)}]` });
    }
    return out;
  }

  // Absolute XPath from the root, with every step indexed. Always unique.
  function absoluteXPath(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE || !el.isConnected) return null;
    const steps = [];
    for (let n = el; n && n.nodeType === Node.ELEMENT_NODE; n = n.parentElement) steps.unshift(step(n, true));
    return "/" + steps.join("/");
  }

  // The best XPath for an element: a stable attribute if one is unique,
  // otherwise a short path down from the nearest uniquely-locatable ancestor,
  // otherwise the absolute path. Returns { xpath, kind } or null.
  function relativeXPath(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE || !el.isConnected) return null;
    for (const loc of attributeLocators(el)) {
      if (pointsTo(loc.xpath, el)) return loc;
    }
    // Walk up until an ancestor has a unique attribute locator; path down from it.
    const steps = [step(el, false)];
    for (let a = el.parentElement; a && a !== el.ownerDocument.documentElement; a = a.parentElement) {
      const anchor = attributeLocators(a).find((loc) => pointsTo(loc.xpath, a));
      if (anchor) {
        const xpath = `${anchor.xpath}/${steps.join("/")}`;
        if (pointsTo(xpath, el)) return { kind: `inside ${anchor.kind}`, xpath };
        break;
      }
      steps.unshift(step(a, false));
    }
    return { kind: "position", xpath: absoluteXPath(el) };
  }

  // A CSS selector that matches only this element.
  function cssSelector(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE || !el.isConnected) return null;
    const doc = el.ownerDocument;
    const unique = (sel) => {
      try {
        const found = doc.querySelectorAll(sel);
        return found.length === 1 && found[0] === el;
      } catch {
        return false;
      }
    };
    const own = (n) => {
      if (n.id && !isGeneratedId(n.id) && unique(`#${CSS.escape(n.id)}`)) return `#${CSS.escape(n.id)}`;
      for (const attr of TEST_ATTRS) {
        const v = n.getAttribute(attr);
        if (v) {
          const sel = `[${attr}="${CSS.escape(v)}"]`;
          try {
            if (doc.querySelectorAll(sel).length === 1) return sel;
          } catch {
            /* ignore */
          }
        }
      }
      return null;
    };
    const first = own(el);
    if (first) return first;
    const parts = [];
    for (let n = el; n && n.nodeType === Node.ELEMENT_NODE; n = n.parentElement) {
      if (n !== el) {
        const anchor = own(n);
        if (anchor) {
          parts.unshift(anchor);
          break;
        }
      }
      const tag = CSS.escape(n.localName);
      const same = n.parentElement ? [...n.parentElement.children].filter((s) => s.localName === n.localName) : [n];
      parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(n) + 1})` : tag);
      const sel = parts.join(" > ");
      if (unique(sel)) return sel;
    }
    const sel = parts.join(" > ");
    return unique(sel) ? sel : null;
  }

  // For the "test an XPath" box: XPath if it looks like one, else CSS.
  function find(query, doc = document) {
    const q = query.trim();
    if (/^[(/.]/.test(q)) {
      const found = evaluate(q, doc);
      return found === null ? { error: "Invalid XPath" } : { kind: "XPath", elements: found.filter((n) => n.nodeType === 1) };
    }
    try {
      return { kind: "CSS", elements: [...doc.querySelectorAll(q)] };
    } catch {
      return { error: "Invalid selector" };
    }
  }

  window.XPathGrabber = { relativeXPath, absoluteXPath, cssSelector, find, literal, isGeneratedId, pointsTo };
})();
