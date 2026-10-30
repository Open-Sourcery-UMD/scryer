import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(path.join(root, "client/package.json"));
const { chromium } = require("playwright-core");
const cssDir = path.join(root, "frontend/.next/static/css");
const cssName = readdirSync(cssDir).find((name) => name.endsWith(".css"));
if (!cssName) throw new Error("Build the frontend before running the browser accessibility test");
const css = readFileSync(path.join(cssDir, cssName), "utf8");

let browser;
before(async () => {
  const binary = process.env.SCRYER_BROWSER_BIN;
  if (!binary) throw new Error("Set SCRYER_BROWSER_BIN to an installed local Chrome executable");
  browser = await chromium.launch({ executablePath: binary, headless: true, args: ["--no-sandbox"] });
});
after(async () => { await browser?.close(); });

async function openStaticPage(t, route) {
  const page = await browser.newPage({ viewport: { width: 320, height: 900 } });
  t.after(async () => { await page.close(); });
  await page.route("**/*", (request) => request.abort());
  const file = route === "/" ? "index.html" : "demo.html";
  const html = readFileSync(path.join(root, "frontend/.next/server/app", file), "utf8")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
  await page.setContent(html);
  await page.addStyleTag({ content: css });
  return page;
}

async function axNodes(page) {
  const session = await page.context().newCDPSession(page);
  await session.send("Accessibility.enable");
  const tree = await session.send("Accessibility.getFullAXTree");
  await session.detach();
  return tree.nodes;
}

test("both static routes have named landmarks and no horizontal overflow at 320px", async (t) => {
  for (const [route, heading] of [
    ["/", "Trace financial aid from promise to deposit."],
    ["/demo", "A changed expectation, fully explained."],
  ]) {
    const page = await openStaticPage(t, route);
    assert.equal(await page.locator("h1").count(), 1);
    assert.equal(await page.locator("h1").textContent(), heading);
    const dimensions = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    assert.deepEqual(dimensions, [320, 320], `${route} overflows horizontally`);
    const nodes = await axNodes(page);
    assert.equal(nodes.filter((node) => node.role?.value === "main").length, 1);
    assert.ok(nodes.some((node) => node.role?.value === "navigation" && node.name?.value === "Main navigation"));
    assert.ok(nodes.some((node) => node.role?.value === "heading" && node.name?.value === heading));
  }
});

test("keyboard skip link moves focus into the main content", async (t) => {
  const page = await openStaticPage(t, "/demo");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Skip to content");
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "main-content");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Back to Scryer");
});

test("fact disclosures toggle by keyboard and expose corrected evidence", async (t) => {
  const page = await openStaticPage(t, "/demo");
  const row = page.locator("#fact-grant");
  assert.equal(await row.evaluate((element) => element.open), true);
  await row.locator("summary").focus();
  await page.keyboard.press("Enter");
  assert.equal(await row.evaluate((element) => element.open), false);
  await page.keyboard.press("Enter");
  assert.equal(await row.evaluate((element) => element.open), true);
  const names = (await axNodes(page)).map((node) => node.name?.value ?? "");
  assert.match(await row.innerText(), /aid-a · row:1-revised/);
  for (const value of ["aid-a", "row:1", "row:1-revised", "review-grant", "review-grant-correction"]) {
    assert.ok(names.includes(value), `Missing accessible correction detail: ${value}`);
  }
});

test("evidence links and observation cards have distinct accessible names", async (t) => {
  const page = await openStaticPage(t, "/demo");
  for (const name of [
    "Inspect revised grant source and approval",
    "Inspect new school charge source and approval",
    "Inspect refund evidence",
    "Inspect bank evidence",
  ]) {
    assert.equal(await page.getByRole("link", { name, exact: true }).count(), 1);
  }
  const names = (await axNodes(page)).map((node) => node.name?.value ?? "");
  assert.match(await page.locator("#observation-refund").innerText(), /refund-a · page:1/);
  assert.match(await page.locator("#observation-bank").innerText(), /bank-a · row:1/);
  for (const value of ["refund-a", "page:1", "review-issued-refund", "bank-a", "row:1", "review-bank-credit"]) {
    assert.ok(names.includes(value), `Missing accessible observation detail: ${value}`);
  }
});

test("source inspection links land on expanded evidence", async (t) => {
  const page = await openStaticPage(t, "/demo");
  for (const [name, id] of [
    ["Inspect revised grant source and approval", "fact-grant"],
    ["Inspect new school charge source and approval", "fact-extra-charge"],
  ]) {
    await page.getByRole("link", { name, exact: true }).click();
    assert.equal(await page.locator(`#${id}`).evaluate((element) => element.open), true, `${name} landed on hidden details`);
  }
});
