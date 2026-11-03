import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openBrowserHarness } from "../browser/harness.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const prototype = pathToFileURL(path.join(root, "docs/foundation/prototype.html")).href;
const catalog = JSON.parse(await readFile(path.join(root, "docs/foundation/journeys.json"), "utf8"));
const screens = new Map(catalog.screens.map((screen) => [screen.id, screen]));

async function openState(page, id) {
  await page.getByLabel("Inspect any target state", { exact: true }).selectOption(id);
  await page.getByRole("button", { name: "Open selected state", exact: true }).click();
  assert.equal(await page.locator("#screen").getAttribute("data-screen-id"), id);
}

async function acknowledge(page, action) {
  for (const id of action.requires || []) await page.locator(`#field-${id}`).check();
}

test("foundation wireframes run directly from a local file with synthetic, recoverable states", async (t) => {
  const { page } = await openBrowserHarness(t);
  page.setDefaultTimeout(3_000);
  const requests = [];
  const errors = [];
  page.on("request", (request) => requests.push(request.url()));
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(prototype);

  await t.test("entry screen makes design and current-product limits visible", async () => {
    assert.equal(await page.locator("#screen").getAttribute("data-screen-id"), "welcome");
    assert.equal(await page.getByText("DESIGN PROTOTYPE · SYNTHETIC ONLY", { exact: true }).count(), 1);
    assert.match(await page.locator("aside").innerText(), /unreviewed, unsaved synthetic bank-CSV preview/);
    assert.match(await page.locator("aside").innerText(), /Two outside participants are still required/);
    assert.equal(await page.locator("input[type=file]").count(), 0);
    assert.equal(await page.locator("form").count(), 0);
    assert.equal(await page.locator("a[download]").count(), 0);
  });

  await t.test("every catalog state renders labelled controls and every action reaches its target", async () => {
    for (const screen of catalog.screens) {
      await openState(page, screen.id);
      assert.equal(await page.locator("h1").textContent(), screen.title, screen.id);
      assert.equal(await page.evaluate(() => document.activeElement?.id), "screen-title", screen.id);
      for (const field of screen.fields || []) {
        assert.equal(await page.getByLabel(field.label, { exact: true }).count(), 1, `${screen.id}: ${field.id}`);
      }
      if (screen.table) assert.equal(await page.locator("#screen tbody tr").count(), screen.table.rows.length);
      for (const action of screen.actions) {
        await openState(page, screen.id);
        await acknowledge(page, action);
        await page.locator(`#screen button[data-action-id="${action.id}"]`).click();
        assert.equal(await page.locator("#screen").getAttribute("data-screen-id"), action.to, `${screen.id}: ${action.id}`);
        assert.equal(await page.locator("h1").textContent(), screens.get(action.to).title);
      }
    }
  });

  await t.test("review and destructive-action acknowledgements block premature transitions", async () => {
    for (const screen of catalog.screens) {
      for (const action of screen.actions.filter((action) => action.requires?.length)) {
        await openState(page, screen.id);
        await page.locator(`#screen button[data-action-id="${action.id}"]`).click();
        assert.equal(await page.locator("#screen").getAttribute("data-screen-id"), screen.id);
        assert.match(await page.getByRole("alert").textContent(), /Review the acknowledgement/);
        assert.equal(await page.evaluate(() => document.activeElement?.id), `field-${action.requires[0]}`);
        await acknowledge(page, action);
        await page.locator(`#screen button[data-action-id="${action.id}"]`).click();
        assert.equal(await page.locator("#screen").getAttribute("data-screen-id"), action.to);
      }
    }
  });

  await t.test("exact insight, correction history, and missing-source recovery are inspectable", async () => {
    await openState(page, "insight");
    assert.match(await page.locator("#screen").innerText(), /Grant correction −\$300\.00 plus new school charge −\$300\.00 equals −\$600\.00 exactly/);
    await page.getByRole("button", { name: "Inspect exact source-linked explanation", exact: true }).click();
    assert.match(await page.locator("#screen table").innerText(), /aid-a \/ row:1 \(\$3,000\) → row:1-revised \(\$2,700\)/);
    await page.getByRole("button", { name: "Simulate missing original bytes", exact: true }).click();
    await page.getByRole("button", { name: "Reattach a matching synthetic source", exact: true }).click();
    await page.getByRole("button", { name: "Simulate source hash mismatch", exact: true }).click();
    assert.equal(await page.locator("#screen").getAttribute("data-screen-id"), "source-mismatch");
    assert.match(await page.locator("#screen").innerText(), /No source attachment or approved fact has changed/);
    await openState(page, "correction-confirm");
    assert.match(await page.locator("#screen").innerText(), /\$900\.00 → \$950\.00/);
    await page.getByLabel("I checked the synthetic source and the exact +$50.00 impact.", { exact: true }).check();
    await page.getByRole("button", { name: "Simulate append-only correction approved", exact: true }).click();
    assert.match(await page.locator("#screen table").innerText(), /Original approval retained/);
    await page.getByRole("button", { name: "Inspect corrected synthetic branch", exact: true }).click();
    assert.match(await page.locator("#screen").innerText(), /Corrected school surplus\s+\$950\.00/);
  });

  await t.test("keyboard transitions, previous view, and reset work without losing labels", async () => {
    await page.getByRole("button", { name: "Reset prototype", exact: true }).click();
    await page.getByRole("button", { name: "Choose local-only case", exact: true }).focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.locator("#screen").getAttribute("data-screen-id"), "local-setup");
    await page.getByRole("button", { name: "Continue local case setup", exact: true }).focus();
    await page.keyboard.press("Space");
    assert.equal(await page.locator("#screen").getAttribute("data-screen-id"), "case-setup");
    await page.getByRole("button", { name: "Previous viewed state", exact: true }).click();
    assert.equal(await page.locator("#screen").getAttribute("data-screen-id"), "local-setup");
    await page.getByLabel("Synthetic case label", { exact: true }).fill("<img src=x onerror=alert(1)>");
    assert.equal(await page.locator("#screen img").count(), 0);
    await page.getByRole("button", { name: "Reset prototype", exact: true }).click();
    assert.equal(await page.locator("#screen").getAttribute("data-screen-id"), "welcome");
    assert.equal(await page.getByRole("button", { name: "Previous viewed state", exact: true }).isDisabled(), true);
    await openState(page, "local-setup");
    assert.equal(await page.getByLabel("Synthetic case label", { exact: true }).inputValue(), "Fictional Fall 2026 aid trail");
  });

  await t.test("all states reflow at a narrow viewport", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const screen of catalog.screens) {
      await openState(page, screen.id);
      assert.deepEqual(await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]), [390, 390], screen.id);
      if (screen.table) {
        const caption = await page.locator("#screen caption").boundingBox();
        const table = await page.locator("#screen table").boundingBox();
        assert.ok(caption && table && caption.width >= table.width * 0.9,
          `${screen.id}: mobile caption collapsed: ${JSON.stringify({ caption, table })}`);
      }
      for (const button of await page.locator("#screen button").all()) {
        const bounds = await button.boundingBox();
        assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391, `${screen.id}: ${JSON.stringify(bounds)}`);
      }
    }
  });

  await t.test("complete navigation sends no network traffic and creates no browser storage", async () => {
    assert.deepEqual(errors, []);
    assert.ok(requests.every((url) => url === prototype), JSON.stringify(requests));
    assert.deepEqual(await page.evaluate(async () => ({
      databases: await indexedDB.databases(),
      localItems: localStorage.length,
      sessionItems: sessionStorage.length,
    })), { databases: [], localItems: 0, sessionItems: 0 });
    await page.reload();
    assert.equal(await page.locator("#screen").getAttribute("data-screen-id"), "welcome");
    assert.equal(await page.getByRole("button", { name: "Previous viewed state", exact: true }).isDisabled(), true);
  });
});
