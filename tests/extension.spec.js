// The real extension in Chromium: copy keys, arrow navigation, the test box,
// history, and the permissions it asks for.
const { test, expect, chromium } = require("@playwright/test");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ORIGIN = "http://127.0.0.1:4173";
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

let context;
let worker;

test.beforeAll(async () => {
  // In real use, clicking the button or pressing the shortcut grants activeTab.
  // Tests can't press an extension shortcut, so this copy is granted the
  // fixture origin up front instead. The shipped manifest is checked below.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xpath-grabber-"));
  for (const f of fs.readdirSync(ROOT)) {
    if (/\.(js|css|html|json)$/.test(f) && !["package.json", "package-lock.json", "playwright.config.js"].includes(f)) {
      fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
    }
  }
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ ...manifest, host_permissions: [`${ORIGIN}/*`] }));

  context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "profile-")), {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: ORIGIN });
  worker = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
});

test.afterAll(async () => {
  await context?.close();
});

async function openFixture() {
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/tricky.html`);
  return page;
}

// What the keyboard shortcut does: inject if needed, then toggle.
async function toggleInspector(page) {
  await page.bringToFront();
  await worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    await toggleInTab(tab);
  }, page.url());
  await expect(page.locator("#xpath-toast")).toContainText("Inspector Active");
}

async function hover(page, handle) {
  await page.locator(`[data-case="${handle}"]`).hover();
  await expect(page.locator("#xpath-overlay-badge")).toBeVisible();
}

const clipboard = (page) => page.evaluate(() => navigator.clipboard.readText());

test("the shipped manifest asks only for what it needs", () => {
  expect(manifest.permissions.sort()).toEqual(["activeTab", "scripting", "storage"]);
  expect(manifest.content_scripts).toBeUndefined(); // nothing runs on every page
  expect(manifest.host_permissions).toBeUndefined();
  expect(manifest.commands["toggle-inspector"].suggested_key.default).toBe("Alt+Shift+X");
  expect(manifest.commands["test-query"].suggested_key).toEqual({ default: "Ctrl+Shift+F", mac: "Command+Shift+F" });
});

test("C, Shift+C and S copy the best XPath, the absolute XPath and a CSS selector", async () => {
  const page = await openFixture();
  await toggleInspector(page);
  await hover(page, "testid");
  await expect(page.locator("#xpath-overlay-badge")).toContainText('//*[@data-testid="third"]');

  await page.keyboard.press("c");
  await expect.poll(() => clipboard(page)).toBe('//*[@data-testid="third"]');
  await page.keyboard.press("Shift+C");
  await expect.poll(() => clipboard(page)).toBe("/html[1]/body[1]/ul[1]/li[3]");
  await page.keyboard.press("s");
  await expect.poll(() => clipboard(page)).toBe('[data-testid="third"]');
  await page.close();
});

test("clicking copies, and SVG elements get an XPath that works", async () => {
  const page = await openFixture();
  await toggleInspector(page);
  await hover(page, "svg");
  await page.mouse.down();
  await page.mouse.up();
  const copied = await clipboard(page);
  expect(copied).toContain('local-name()="svg"');
  const matches = await page.evaluate((x) => document.evaluate(x, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotLength, copied);
  expect(matches).toBe(1);
  await page.close();
});

test("arrow keys move the selection to the parent, child and siblings", async () => {
  const page = await openFixture();
  await toggleInspector(page);
  await hover(page, "testid"); // the third <li>
  await page.keyboard.press("ArrowLeft"); // second <li>
  await page.keyboard.press("Shift+C");
  await expect.poll(() => clipboard(page)).toBe("/html[1]/body[1]/ul[1]/li[2]");
  await page.keyboard.press("ArrowUp"); // the <ul>
  await page.keyboard.press("Shift+C");
  await expect.poll(() => clipboard(page)).toBe("/html[1]/body[1]/ul[1]");
  await page.keyboard.press("ArrowDown"); // first <li>
  await page.keyboard.press("Shift+C");
  await expect.poll(() => clipboard(page)).toBe("/html[1]/body[1]/ul[1]/li[1]");
  await page.close();
});

test("the test box counts and outlines matches, and reports bad queries", async () => {
  const page = await openFixture();
  await toggleInspector(page);
  const ask = (query) =>
    worker.evaluate(async ({ url, query }) => {
      const [tab] = await chrome.tabs.query({ url });
      return chrome.tabs.sendMessage(tab.id, { action: "testQuery", query });
    }, { url: page.url(), query });

  expect(await ask("//li")).toEqual({ kind: "XPath", count: 3 });
  await expect(page.locator(".xpath-match-box")).toHaveCount(3);
  expect(await ask("section > div")).toEqual({ kind: "CSS", count: 2 });
  expect(await ask("//div[@id=")).toEqual({ error: "Invalid XPath" });
  expect(await ask("li[")).toEqual({ error: "Invalid selector" });
  await page.close();
});

test("copies are kept in a history of the last 10", async () => {
  const page = await openFixture();
  await worker.evaluate(() => chrome.storage.local.clear());
  await toggleInspector(page);
  for (const handle of ["plain-id", "text", "alt"]) {
    await hover(page, handle);
    await page.keyboard.press("c");
    await expect(page.locator("#xpath-toast")).toContainText("Copied");
  }
  const history = await worker.evaluate(async () => (await chrome.storage.local.get("history")).history);
  expect(history.map((h) => h.value)).toEqual(['//img[@alt="Company logo"]', '//button[normalize-space()="Sign in"]', '//*[@id="save"]']);
  expect(history[0]).toMatchObject({ type: "XPath", url: page.url() });
  await page.close();
});

test("an older copy already on the page gets a reload message, not a crash", async () => {
  const page = await openFixture();
  // What a tab opened before the update looks like: 1.0's script answers
  // "alive" without a version and ignores the newer messages.
  const outcome = await worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => chrome.runtime.onMessage.addListener((req, _s, send) => req.action === "ping" && send({ status: "alive" })),
    });
    try {
      await ensureInjected(tab.id);
      return "injected";
    } catch (err) {
      return err.message;
    }
  }, page.url());
  expect(outcome).toContain("older copy of the inspector. Reload the page");
  await page.close();
});

// What the Test shortcut (Cmd+Shift+F) does
async function openTester(page) {
  await page.bringToFront();
  await worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    await openTesterInTab(tab);
  }, page.url());
  const bar = page.locator("#xpath-tester");
  await expect(bar).toBeVisible();
  return { bar, input: bar.locator("input"), out: bar.locator("output") };
}

test("the Test shortcut opens a bar: paste, see matches, step through them, Esc closes", async () => {
  const page = await openFixture();
  const { bar, input, out } = await openTester(page);
  await expect(input).toBeFocused();

  await page.evaluate(() => navigator.clipboard.writeText("//li"));
  await page.keyboard.press("ControlOrMeta+V");
  await expect(input).toHaveValue("//li");
  await expect(out).toHaveText("1 of 3 matches (XPath) · Enter for next");
  await expect(page.locator(".xpath-match-box")).toHaveCount(3);
  await expect(page.locator(".xpath-match-box.current")).toHaveCount(1);

  await page.keyboard.press("Enter");
  await expect(out).toHaveText("2 of 3 matches (XPath) · Enter for next");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.press("Shift+Enter");
  await expect(out).toHaveText("3 of 3 matches (XPath) · Enter for next");

  await input.fill('[data-testid="third"]');
  await expect(out).toHaveText("1 match (CSS)");
  await input.fill("//div[@id=");
  await expect(out).toHaveText("Invalid XPath");
  await input.fill("//nav");
  await expect(out).toHaveText("No matches (XPath)");

  await page.keyboard.press("Escape");
  await expect(bar).toBeHidden();
  await expect(page.locator(".xpath-match-box")).toHaveCount(0);
  await page.close();
});

test("outlines stay on their element when the page scrolls", async () => {
  const page = await openFixture();
  await page.setViewportSize({ width: 800, height: 300 });
  const { input } = await openTester(page);
  await input.fill("//td");
  await expect(page.locator(".xpath-match-box")).toHaveCount(2);
  for (const y of [0, 400]) {
    await page.evaluate((y) => scrollTo(0, y), y);
    const off = await page.evaluate(() => {
      const box = document.querySelector(".xpath-match-box");
      const td = document.querySelectorAll("td")[0].getBoundingClientRect();
      return Math.abs(box.getBoundingClientRect().top - td.top);
    });
    expect(off).toBeLessThan(1);
  }
  await page.close();
});

test("typing in the test bar never triggers the inspector's copy keys", async () => {
  const page = await openFixture();
  await toggleInspector(page);
  await hover(page, "testid");
  await page.evaluate(() => navigator.clipboard.writeText("untouched"));
  const { input } = await openTester(page);
  await page.keyboard.type("//sc");
  await expect(input).toHaveValue("//sc");
  expect(await clipboard(page)).toBe("untouched");
  await page.close();
});

test("a copy cut off by an extension reload hands over to a fresh one, and history works again", async () => {
  const page = await openFixture();
  await toggleInspector(page);
  // After a reload Chrome can no longer reach the old copy, so a ping gets no
  // answer and ensureInjected injects again. Simulate exactly that.
  await worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => (window.__XPATH_GRABBER__.alive = () => false) });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["xpath.js", "content.js"] });
    await chrome.storage.local.clear();
  }, page.url());
  await toggleInspector(page);
  await hover(page, "plain-id");
  await expect(page.locator("#xpath-overlay-badge")).toHaveCount(1); // the old copy's badge is gone
  await page.keyboard.press("c");
  await expect(page.locator("#xpath-toast")).toContainText("Copied");
  // Saved once: by the new copy, not twice by two live copies
  const history = await worker.evaluate(async () => (await chrome.storage.local.get("history")).history);
  expect(history.map((h) => h.value)).toEqual(['//*[@id="save"]']);
  await page.close();
});

test("the test bar edits like a normal input, even on a page that blocks selection and editing keys", async () => {
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/hostile.html`);
  const { input, out } = await openTester(page);
  const box = await input.boundingBox();
  expect(box.height).toBeGreaterThan(20); // the page's input reset doesn't reach it

  await page.keyboard.type("//lix");
  await page.keyboard.press("Backspace");
  await expect(input).toHaveValue("//li");
  await expect(out).toHaveText("1 of 3 matches (XPath) · Enter for next");

  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("x");
  await expect(input).toHaveValue("//xli");
  await page.keyboard.press("Delete");
  await page.keyboard.press("Backspace");
  await expect(input).toHaveValue("//i");

  await page.keyboard.press("ControlOrMeta+A");
  expect(await input.evaluate((el) => [el.selectionStart, el.selectionEnd])).toEqual([0, 3]);
  await page.keyboard.press("Delete");
  await expect(input).toHaveValue("");
  await page.keyboard.type("li");
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await expect(input).toHaveValue("");
  await page.close();
});

test("the test bar is keyboard navigable: arrows step, Tab cycles its buttons, Esc returns focus", async () => {
  const page = await openFixture();
  await page.locator("input").first().focus().catch(() => {});
  const before = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 60));
  const { bar, input, out } = await openTester(page);
  const prev = bar.getByRole("button", { name: "Previous match" });
  const next = bar.getByRole("button", { name: "Next match" });
  const close = bar.getByRole("button", { name: "Close" });

  await page.keyboard.type("//li");
  await expect(out).toHaveText("1 of 3 matches (XPath) · Enter for next");
  await page.keyboard.press("ArrowDown");
  await expect(out).toHaveText("2 of 3 matches (XPath) · Enter for next");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(out).toHaveText("3 of 3 matches (XPath) · Enter for next");

  await page.keyboard.press("Tab");
  await expect(prev).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(next).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(out).toHaveText("1 of 3 matches (XPath) · Enter for next");
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(input).toBeFocused(); // focus stays in the bar
  await page.keyboard.press("Shift+Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(bar).toBeHidden();
  await expect(page.locator(".xpath-match-box")).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 60))).toBe(before);

  // One match: nothing to step through, so the arrows are disabled and skipped by Tab
  await openTester(page);
  await input.fill('[data-testid="third"]');
  await expect(out).toHaveText("1 match (CSS)");
  await expect(next).toBeDisabled();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.close();
});
