import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../../client/build/', import.meta.url)));
const require = createRequire(new URL('../../client/package.json', import.meta.url));
const { chromium } = require('playwright-core');

export async function openBrowserHarness(t) {
  const browserBinary = process.env.SCRYER_BROWSER_BIN || chromium.executablePath();
  assert.ok(existsSync(browserBinary), `BROWSER_UNAVAILABLE: ${browserBinary}`);
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>Scryer browser test</title>');
      return;
    }
    const target = resolve(root, `.${pathname}`);
    if (!target.startsWith(`${root}${sep}`)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const bytes = await readFile(target);
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      response.end(bytes);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  let browser = null;
  t.after(async () => {
    if (browser) await browser.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  browser = await chromium.launch({ headless: true, executablePath: browserBinary });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`);
  return { page, browser, context };
}
