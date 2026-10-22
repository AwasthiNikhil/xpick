// Locator generation (xpath.js) against tricky markup, then two sweeps:
// every element of the fixture page, and every element of randomly built pages.
const { test, expect } = require("@playwright/test");
const path = require("path");

const XPATH_JS = path.join(__dirname, "..", "xpath.js");

// For one element (by data-case handle): every locator, and whether each one
// matches exactly that element in its own document.
async function locate(page, handle, frame = page.mainFrame()) {
  return frame.evaluate((handle) => {
    const { relativeXPath, absoluteXPath, cssSelector, pointsTo } = window.XPathGrabber;
    const el = document.querySelector(`[data-case="${handle}"]`);
    const rel = relativeXPath(el);
    const abs = absoluteXPath(el);
    const css = cssSelector(el);
    const cssOk = (() => {
      try {
        const found = document.querySelectorAll(css);
        return found.length === 1 && found[0] === el;
      } catch {
        return false;
      }
    })();
    return { kind: rel?.kind, xpath: rel?.xpath, relOk: !!rel && pointsTo(rel.xpath, el), abs, absOk: pointsTo(abs, el), css, cssOk };
  }, handle);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/tricky.html");
  await page.addScriptTag({ path: XPATH_JS });
});

const CASES = [
  // handle, expected kind (or a test on it), extra check on the XPath
  ["plain-id", "id", (x) => x === '//*[@id="save"]'],
  ["double-quote-id", "id", (x) => x === `//*[@id='say"hi"']`],
  ["both-quotes-id", "id", (x) => x.includes("concat(")],
  ["aria-label", "aria-label"],
  ["svg", (k) => k.startsWith("inside"), (x) => x.includes('local-name()="svg"')],
  ["svg-path", (k) => k.startsWith("inside"), (x) => x.includes('local-name()="path"')],
  ["mathml", (k) => k === "position" || k.startsWith("inside")],
  ["dup-first", (k) => k !== "id"],
  ["dup-second", (k) => k !== "id"],
  ["testid", "test id", (x) => x === '//*[@data-testid="third"]'],
  ["data-cy", "test id"],
  ["react-id", (k) => k !== "id"],
  ["react-prefixed-id", (k) => k !== "id"],
  ["ember-id", (k) => k !== "id"],
  ["uuid-id", (k) => k !== "id"],
  ["mui-id", (k) => k !== "id"],
  ["numeric-id", (k) => k !== "id"],
  ["input-name", (k) => k !== "name"], // a hidden input shares the name, so name isn't unique
  ["placeholder", "placeholder"],
  ["text", "text", (x) => x === '//button[normalize-space()="Sign in"]'],
  ["text-quotes", "text", (x) => x.includes("concat(")],
  ["long-text", (k) => k !== "text"],
  ["href", "text"], // its text is unique, which beats the shared href
  ["alt", "alt"],
  ["table-cell", () => true],
  ["deep-no-attrs", () => true],
];

for (const [handle, kind, check] of CASES) {
  test(`${handle}: every locator matches only this element`, async ({ page }) => {
    const r = await locate(page, handle);
    expect(r.relOk, `relative ${r.xpath}`).toBe(true);
    expect(r.absOk, `absolute ${r.abs}`).toBe(true);
    expect(r.cssOk, `css ${r.css}`).toBe(true);
    if (typeof kind === "string") expect(r.kind).toBe(kind);
    else expect(kind(r.kind), `kind was "${r.kind}"`).toBe(true);
    if (check) expect(check(r.xpath), `xpath was ${r.xpath}`).toBe(true);
  });
}

test("inside an iframe, locators are relative to the frame's document", async ({ page }) => {
  const frame = page.frames().find((f) => f !== page.mainFrame());
  await frame.addScriptTag({ path: XPATH_JS });
  const r = await locate(page, "iframe", frame);
  expect(r).toMatchObject({ kind: "id", xpath: '//*[@id="inside"]', relOk: true, absOk: true, cssOk: true });
});

test("generated-looking ids are recognised, ordinary ones aren't", async ({ page }) => {
  const result = await page.evaluate(() =>
    Object.fromEntries(["save", "h1", "step2", "main-nav", ":r1:", "react-:r9:", "ember412", "mui-12", "order-20231104", "3f2b8c1a-9d4e-4b7a-8c2d-1e5f6a7b8c9d"].map((id) => [id, window.XPathGrabber.isGeneratedId(id)])),
  );
  expect(result).toEqual({
    save: false, h1: false, step2: false, "main-nav": false,
    ":r1:": true, "react-:r9:": true, ember412: true, "mui-12": true, "order-20231104": true, "3f2b8c1a-9d4e-4b7a-8c2d-1e5f6a7b8c9d": true,
  });
});

test("XPath string literals are valid for any mix of quotes", async ({ page }) => {
  const ok = await page.evaluate(() => {
    const { literal } = window.XPathGrabber;
    return [`plain`, `it's`, `say "hi"`, `it's "both"`, `"`, `'`, `""''`].every((v) => document.evaluate(literal(v), document, null, XPathResult.STRING_TYPE, null).stringValue === v);
  });
  expect(ok).toBe(true);
});

test("sweep: every element on the page gets locators that match only it", async ({ page }) => {
  const failures = await page.evaluate(() => {
    const { relativeXPath, absoluteXPath, cssSelector, pointsTo } = window.XPathGrabber;
    const bad = [];
    for (const el of document.querySelectorAll("body *")) {
      if (el.localName === "script") continue;
      const rel = relativeXPath(el);
      const abs = absoluteXPath(el);
      const css = cssSelector(el);
      const cssOk = css && document.querySelectorAll(css).length === 1 && document.querySelector(css) === el;
      if (!rel || !pointsTo(rel.xpath, el)) bad.push(`relative ${rel?.xpath}`);
      if (!pointsTo(abs, el)) bad.push(`absolute ${abs}`);
      if (!cssOk) bad.push(`css ${css}`);
    }
    return bad;
  });
  expect(failures).toEqual([]);
});

test("sweep: 150 random pages, every element gets unique locators", async ({ page }) => {
  const report = await page.evaluate(() => {
    // Seeded random, so a failure reproduces
    let seed = 42;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const pick = (a) => a[Math.floor(rand() * a.length)];
    const TAGS = ["div", "span", "p", "a", "button", "li", "ul", "section", "label", "input", "svg", "path", "g"];
    const SVG = "http://www.w3.org/2000/svg";
    const ID_POOL = ["main", "dup", "dup", "save", ":r1:", 'q"uote', "it's", "ember12", "mui-3"];
    const TEXT_POOL = ["Save", "Save", "Cancel", "Sign in", 'It\'s "ok"', ""];

    function build(parent, depth, inSvg) {
      const n = 1 + Math.floor(rand() * 4);
      for (let i = 0; i < n; i++) {
        const tag = inSvg ? pick(["path", "g", "rect"]) : pick(TAGS);
        const svgish = inSvg || tag === "svg" || tag === "path" || tag === "g";
        const el = svgish ? document.createElementNS(SVG, tag) : document.createElement(tag);
        if (rand() < 0.3) el.setAttribute("id", pick(ID_POOL));
        if (rand() < 0.15) el.setAttribute("data-testid", pick(["row", "row", "cell"]));
        if (rand() < 0.15) el.setAttribute("aria-label", pick(["Close", "Close", "Open"]));
        if (rand() < 0.1) el.setAttribute("name", pick(["email", "email", "q"]));
        if (!svgish && rand() < 0.4) el.append(pick(TEXT_POOL));
        parent.append(el);
        if (depth < 4 && el.localName !== "input" && rand() < 0.6) build(el, depth + 1, svgish && el.localName !== "path");
      }
    }

    const { relativeXPath, absoluteXPath, cssSelector, pointsTo } = window.XPathGrabber;
    const stage = document.createElement("div");
    document.body.append(stage);
    let checked = 0;
    const bad = [];
    for (let round = 0; round < 150; round++) {
      stage.replaceChildren();
      build(stage, 0, false);
      for (const el of stage.querySelectorAll("*")) {
        checked++;
        const rel = relativeXPath(el);
        const abs = absoluteXPath(el);
        const css = cssSelector(el);
        let cssOk = false;
        try {
          cssOk = !!css && document.querySelectorAll(css).length === 1 && document.querySelector(css) === el;
        } catch {}
        if (!rel || !pointsTo(rel.xpath, el)) bad.push(`round ${round} relative ${rel?.xpath}`);
        if (!pointsTo(abs, el)) bad.push(`round ${round} absolute ${abs}`);
        if (!cssOk) bad.push(`round ${round} css ${css}`);
      }
    }
    return { checked, bad: bad.slice(0, 10) };
  });
  expect(report.checked).toBeGreaterThan(1000);
  expect(report.bad).toEqual([]);
});
