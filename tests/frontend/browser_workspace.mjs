import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const frontend = path.join(root, "frontend");
const require = createRequire(path.join(root, "client/package.json"));
const { chromium } = require("playwright-core");
let browser;
let server;
let baseUrl;
let serverOutput = "";

async function availablePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolve) => probe.close(resolve));
  return address.port;
}

before(async () => {
  const binary = process.env.SCRYER_BROWSER_BIN || chromium.executablePath();
  assert.ok(existsSync(binary), `BROWSER_UNAVAILABLE: ${binary}`);
  const port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: frontend, stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [server.stdout, server.stderr]) {
    stream.on("data", (chunk) => { serverOutput += chunk.toString(); });
  }
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Next exited early: ${serverOutput}`);
    try {
      const response = await fetch(baseUrl);
      if (response.ok) break;
    } catch { /* Wait for the local server to start. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const response = await fetch(baseUrl);
  assert.equal(response.status, 200, `Next did not become ready: ${serverOutput}`);
  browser = await chromium.launch({ executablePath: binary, headless: true, args: ["--no-sandbox"] });
});

after(async () => {
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
  }
});

test("workspace opens a personal evidence preview without claiming a reviewed case", async (t) => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(`${baseUrl}/workspace`);
  assert.equal(await page.locator("h1").textContent(), "Preview your records on this device.");
  assert.equal(await page.getByText("Unreviewed preview", { exact: true }).count(), 1);
  assert.equal(await page.getByText("Development build: use synthetic test files only.", { exact: true }).count(), 1);
});

test("synthetic bank CSV is previewed by the browser worker without upload or persistence", async (t) => {
  const page = await browser.newPage();
  t.after(() => page.close());
  const requests = [];
  page.on("request", (request) => requests.push({ method: request.method(), url: request.url() }));
  await page.goto(`${baseUrl}/workspace`);
  await page.getByLabel("Bank CSV file").setInputFiles({
    name: "synthetic.csv", mimeType: "text/csv",
    buffer: Buffer.from("Date,Amount,Memo\n2026-09-08,90.00,BANK_SECRET_SENTINEL\n2026-09-09,-10.00,\n"),
  });
  await page.getByRole("button", { name: "Preview entries" }).click();
  await page.getByRole("heading", { name: "Proposed entries" }).waitFor();
  assert.equal(await page.getByText("$90.00", { exact: true }).count(), 1);
  assert.equal(await page.getByText("Debit is outside current bank-credit support.", { exact: true }).count(), 1);
  assert.equal(await page.getByText("No entry has been approved or saved.", { exact: true }).count(), 1);
  assert.ok(requests.length > 0);
  assert.ok(requests.every(({ method, url }) => method === "GET" && url.startsWith(baseUrl)), JSON.stringify(requests));
  assert.ok(requests.every(({ url }) => !url.includes("BANK_SECRET_SENTINEL")), JSON.stringify(requests));
  assert.deepEqual(await page.evaluate(async () => ({
    databases: await indexedDB.databases(), localStorageItems: localStorage.length,
  })), { databases: [], localStorageItems: 0 });
});

test("a large preview renders bounded pages instead of every candidate row", async (t) => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(`${baseUrl}/workspace`);
  const body = "Date,Amount\n" + Array.from({ length: 51 }, (_, index) =>
    `2026-09-08,${index + 1}.00\n`).join("");
  await page.getByLabel("Bank CSV file").setInputFiles({
    name: "synthetic-many.csv", mimeType: "text/csv", buffer: Buffer.from(body),
  });
  await page.getByRole("button", { name: "Preview entries" }).click();
  await page.getByRole("heading", { name: "Proposed entries" }).waitFor();
  assert.equal(await page.locator(".workspace-table tbody tr").count(), 50);
  assert.equal(await page.getByText("$1.00", { exact: true }).count(), 1);
  await page.getByRole("button", { name: "Next 50 entries" }).click();
  assert.equal(await page.locator(".workspace-table tbody tr").count(), 1);
  assert.equal(await page.getByText("$51.00", { exact: true }).count(), 1);
  assert.equal(await page.getByText("$1.00", { exact: true }).count(), 0);
});

test("the public home page links to the personal preview with its limits stated", async (t) => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(baseUrl);
  await page.getByRole("link", { name: "Preview personal records" }).click();
  await page.waitForURL("**/workspace");
  assert.equal(new URL(page.url()).pathname, "/workspace");
  assert.equal(await page.getByText("Unreviewed preview", { exact: true }).count(), 1);
});

test("separate credit and debit CSV columns keep the debit out of candidate amounts", async (t) => {
  const page = await browser.newPage();
  page.setDefaultTimeout(3000);
  t.after(() => page.close());
  await page.goto(`${baseUrl}/workspace`);
  await page.getByLabel("Bank CSV file").setInputFiles({
    name: "synthetic-split.csv", mimeType: "text/csv",
    buffer: Buffer.from("Date,Credit,Debit\n2026-09-08,90.00,\n2026-09-09,,10.00\n"),
  });
  await page.getByLabel("Separate credit and debit columns").check();
  await page.getByRole("textbox", { name: "Credit column", exact: true }).fill("Credit");
  await page.getByRole("textbox", { name: "Debit column", exact: true }).fill("Debit");
  await page.getByRole("button", { name: "Preview entries" }).click();
  await page.getByRole("heading", { name: "Proposed entries" }).waitFor();
  assert.equal(await page.getByText("$90.00", { exact: true }).count(), 1);
  assert.equal(await page.getByText("Debit is outside current bank-credit support.", { exact: true }).count(), 1);
  assert.equal(await page.locator(".workspace-table tbody tr").count(), 2);
});

test("column mapping preserves whitespace in an exact CSV header name", async (t) => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(`${baseUrl}/workspace`);
  await page.getByLabel("Bank CSV file").setInputFiles({
    name: "synthetic-headers.csv", mimeType: "text/csv",
    buffer: Buffer.from("Date,Amount, Amount \n2026-09-08,1.00,90.00\n"),
  });
  await page.getByRole("textbox", { name: "Amount column", exact: true }).fill(" Amount ");
  await page.getByRole("button", { name: "Preview entries" }).click();
  await page.getByRole("heading", { name: "Proposed entries" }).waitFor();
  assert.equal(await page.getByText("$90.00", { exact: true }).count(), 1);
  assert.equal(await page.getByText("$1.00", { exact: true }).count(), 0);
});

test("replacing a file or mapping clears stale proposals before another preview", async (t) => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(`${baseUrl}/workspace`);
  await page.getByLabel("Bank CSV file").setInputFiles({
    name: "synthetic-first.csv", mimeType: "text/csv",
    buffer: Buffer.from("Date,Amount\n2026-09-08,90.00\n"),
  });
  await page.getByRole("button", { name: "Preview entries" }).click();
  await page.getByRole("heading", { name: "Proposed entries" }).waitFor();
  await page.getByRole("textbox", { name: "Amount column", exact: true }).fill("Other");
  assert.equal(await page.getByRole("heading", { name: "Proposed entries" }).count(), 0);
  await page.getByLabel("Bank CSV file").setInputFiles({
    name: "synthetic-second.csv", mimeType: "text/csv",
    buffer: Buffer.from("Date,Other\n2026-09-09,25.00\n"),
  });
  assert.equal(await page.getByText("$90.00", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "Preview entries" }).click();
  await page.getByRole("heading", { name: "Proposed entries" }).waitFor();
  assert.equal(await page.getByText("$25.00", { exact: true }).count(), 1);
  assert.equal(await page.getByText("$90.00", { exact: true }).count(), 0);
});

test("a delayed worker response cannot restore a preview for a replaced file", async (t) => {
  const page = await browser.newPage();
  t.after(() => page.close());
  let signalFirstWorker;
  const firstWorkerRequest = new Promise((resolve) => { signalFirstWorker = resolve; });
  let releaseFirstWorker;
  const firstWorkerGate = new Promise((resolve) => { releaseFirstWorker = resolve; });
  t.after(() => releaseFirstWorker());
  let heldFirstWorker = false;
  await page.route("**/headless/import/worker.js", async (route) => {
    if (!heldFirstWorker) {
      heldFirstWorker = true;
      signalFirstWorker();
      await firstWorkerGate;
    }
    await route.continue().catch(() => {});
  });
  await page.goto(`${baseUrl}/workspace`);
  await page.getByLabel("Bank CSV file").setInputFiles({
    name: "synthetic-old.csv", mimeType: "text/csv", buffer: Buffer.from("Date,Amount\n2026-09-08,90.00\n"),
  });
  await page.getByRole("button", { name: "Preview entries" }).click();
  await firstWorkerRequest;
  await page.getByLabel("Bank CSV file").setInputFiles({
    name: "synthetic-new.csv", mimeType: "text/csv", buffer: Buffer.from("Date,Amount\n2026-09-09,25.00\n"),
  });
  releaseFirstWorker();
  await page.getByRole("button", { name: "Preview entries" }).click();
  await page.getByRole("heading", { name: "Proposed entries" }).waitFor();
  assert.equal(await page.getByText("$25.00", { exact: true }).count(), 1);
  assert.equal(await page.getByText("$90.00", { exact: true }).count(), 0);
  assert.equal(await page.getByText("synthetic-new.csv", { exact: false }).count(), 1);
});

test("invalid CSV and unverified PDF stay unsaved with clear diagnostics", async (t) => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(`${baseUrl}/workspace`);
  await page.getByLabel("Bank CSV file").setInputFiles({
    name: "synthetic-invalid.csv", mimeType: "text/csv", buffer: Buffer.from('Date,Amount\n"unclosed,1.00\n'),
  });
  await page.getByRole("button", { name: "Preview entries" }).click();
  await page.locator(".workspace-alert").getByText("This file is not a supported bank CSV.", { exact: true }).waitFor();
  assert.equal(await page.locator(".workspace-alert").getByText("This file is not a supported bank CSV.", { exact: true }).count(), 1);
  assert.equal(await page.getByRole("heading", { name: "Proposed entries" }).count(), 0);
  await page.getByLabel("Bank CSV file").setInputFiles({
    name: "synthetic.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\nsynthetic-only\n"),
  });
  await page.getByRole("button", { name: "Preview entries" }).click();
  await page.locator(".workspace-alert").getByText("PDF layout is unverified. This file was not parsed or saved.", { exact: true }).waitFor();
  assert.equal(await page.locator(".workspace-alert").getByText("PDF layout is unverified. This file was not parsed or saved.", { exact: true }).count(), 1);
  assert.equal(await page.getByRole("heading", { name: "Proposed entries" }).count(), 0);
});

test("worker loading failure does not leave a proposal and explains the failure", async (t) => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.route("**/headless/import/worker.js", (route) => route.abort());
  await page.goto(`${baseUrl}/workspace`);
  await page.getByLabel("Bank CSV file").setInputFiles({
    name: "synthetic.csv", mimeType: "text/csv", buffer: Buffer.from("Date,Amount\n2026-09-08,90.00\n"),
  });
  await page.getByRole("button", { name: "Preview entries" }).click();
  await page.locator(".workspace-alert").getByText("The local parser could not start. No entries were saved.", { exact: true }).waitFor();
  assert.equal(await page.locator(".workspace-alert").getByText("The local parser could not start. No entries were saved.", { exact: true }).count(), 1);
  assert.equal(await page.getByRole("heading", { name: "Proposed entries" }).count(), 0);
});

test("keyboard submission announces an unreviewed preview result", async (t) => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(`${baseUrl}/workspace`);
  await page.getByLabel("Bank CSV file").setInputFiles({
    name: "synthetic.csv", mimeType: "text/csv", buffer: Buffer.from("Date,Amount\n2026-09-08,90.00\n"),
  });
  await page.getByRole("button", { name: "Preview entries" }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: "Proposed entries" }).waitFor();
  assert.equal(await page.getByRole("status", { name: "Preview progress" }).textContent(),
    "Preview ready: 1 proposed entry. No entry has been approved or saved.");
});

test("a proposed entry exposes its original CSV fields for local inspection", async (t) => {
  const page = await browser.newPage();
  page.setDefaultTimeout(3000);
  t.after(() => page.close());
  await page.goto(`${baseUrl}/workspace`);
  await page.getByLabel("Bank CSV file").setInputFiles({
    name: "synthetic-source.csv", mimeType: "text/csv",
    buffer: Buffer.from("Date,Amount\n2026-09-08,90.00\n"),
  });
  await page.getByRole("button", { name: "Preview entries" }).click();
  await page.getByRole("heading", { name: "Proposed entries" }).waitFor();
  await page.getByText("Inspect original CSV row", { exact: true }).click();
  assert.match(await page.locator(".workspace-table tbody tr").innerText(), /Original fields:.*2026-09-08.*90\.00/s);
});

test("very long source fields are shortened in the rendered preview", async (t) => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(`${baseUrl}/workspace`);
  await page.getByLabel("Bank CSV file").setInputFiles({
    name: "synthetic-long.csv", mimeType: "text/csv",
    buffer: Buffer.from(`Date,Amount,Memo\n2026-09-08,90.00,${"X".repeat(1000)}\n`),
  });
  await page.getByRole("button", { name: "Preview entries" }).click();
  await page.getByRole("heading", { name: "Proposed entries" }).waitFor();
  await page.getByText("Inspect original CSV row", { exact: true }).click();
  const row = await page.locator(".workspace-table tbody tr").innerText();
  assert.match(row, /Long source field shortened for preview; original file unchanged\./);
  assert.ok(row.includes("X".repeat(200)));
  assert.ok(!row.includes("X".repeat(201)));
});

test("mobile preview keeps the amount and warning inside the viewport without table swiping", async (t) => {
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  t.after(() => page.close());
  await page.goto(`${baseUrl}/workspace`);
  await page.getByLabel("Bank CSV file").setInputFiles({
    name: "synthetic-mobile.csv", mimeType: "text/csv",
    buffer: Buffer.from("Date,Amount\n2026-09-08,90.00\n2026-09-09,-10.00\n"),
  });
  await page.getByRole("button", { name: "Preview entries" }).click();
  await page.getByRole("heading", { name: "Proposed entries" }).waitFor();
  for (const locator of [
    page.getByText("$90.00", { exact: true }),
    page.getByText("Debit is outside current bank-credit support.", { exact: true }),
  ]) {
    const bounds = await locator.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390, JSON.stringify(bounds));
  }
  assert.deepEqual(await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]), [390, 390]);
});

test("a header-only CSV reports that no transaction rows were found", async (t) => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(`${baseUrl}/workspace`);
  await page.getByLabel("Bank CSV file").setInputFiles({
    name: "synthetic-empty.csv", mimeType: "text/csv", buffer: Buffer.from("Date,Amount\n"),
  });
  await page.getByRole("button", { name: "Preview entries" }).click();
  await page.getByRole("heading", { name: "Proposed entries" }).waitFor();
  assert.equal(await page.getByText("No transaction rows were found in this CSV.", { exact: true }).count(), 1);
  assert.equal(await page.locator(".workspace-table tbody tr").count(), 0);
});
