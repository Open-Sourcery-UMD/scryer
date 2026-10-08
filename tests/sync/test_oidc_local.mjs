import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../client/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const root = fileURLToPath(new URL('../../', import.meta.url));
const issuer = 'http://127.0.0.1:8081/realms/scryer-local-test';
const usersPath = process.env.SCRYER_TEST_OIDC_USERS
  ?? resolve(root, '.backend-artifacts/keycloak-auth-test/users.json');
const redirectUri = 'http://127.0.0.1:39000/callback';

function b64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

async function discovery() {
  const response = await fetch(`${issuer}/.well-known/openid-configuration`);
  assert.equal(response.status, 200);
  const config = await response.json();
  assert.equal(config.issuer, issuer);
  for (const field of ['authorization_endpoint', 'token_endpoint', 'userinfo_endpoint']) {
    assert.ok(config[field].startsWith(`${issuer}/`));
  }
  return config;
}

async function login(browser, config, username, password, wrongVerifier = false) {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));
  const redirect = new URL(config.authorization_endpoint);
  redirect.search = new URLSearchParams({ response_type: 'code', client_id: 'scryer-browser',
    redirect_uri: redirectUri, scope: 'openid', state, code_challenge: challenge,
    code_challenge_method: 'S256' }).toString();
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const callback = page.waitForURL((url) => url.origin === 'http://127.0.0.1:39000'
      && url.pathname === '/callback', { timeout: 30_000 });
    await page.goto(redirect.href);
    await page.locator('#username').fill(username);
    await page.locator('#password').fill(password);
    await page.locator('#kc-login').click();
    await callback;
    const result = new URL(page.url());
    assert.equal(result.searchParams.get('state'), state);
    const code = result.searchParams.get('code');
    assert.ok(code);
    const tokenResponse = await fetch(config.token_endpoint, { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'scryer-browser',
        redirect_uri: redirectUri, code, code_verifier: wrongVerifier ? b64url(randomBytes(32)) : verifier }) });
    if (wrongVerifier) {
      assert.equal(tokenResponse.status, 400);
      return null;
    }
    assert.equal(tokenResponse.status, 200);
    const token = await tokenResponse.json();
    assert.equal(token.token_type, 'Bearer');
    assert.ok(typeof token.access_token === 'string' && token.access_token.length > 100);
    // This decodes an untrusted payload only to inspect provider configuration.
    // Signature validation by the Scryer API remains a separate blocked gate.
    const encodedPayload = token.access_token.split('.')[1];
    assert.ok(encodedPayload);
    const tokenFields = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    assert.equal(tokenFields.iss, issuer);
    const audiences = Array.isArray(tokenFields.aud) ? tokenFields.aud : [tokenFields.aud];
    assert.ok(audiences.includes('scryer-api'));
    assert.equal(tokenFields.azp, 'scryer-browser');
    assert.ok(tokenFields.exp > Math.floor(Date.now() / 1000));
    const userInfo = await fetch(config.userinfo_endpoint,
      { headers: { Authorization: `Bearer ${token.access_token}` } });
    assert.equal(userInfo.status, 200);
    const providerClaims = await userInfo.json();
    assert.ok(typeof providerClaims.sub === 'string' && providerClaims.sub.length > 0);
    assert.equal(providerClaims.sub, tokenFields.sub);
    return { subject: providerClaims.sub };
  } finally {
    await context.close();
  }
}

test('real local Keycloak supports two distinct PKCE browser users and rejects a wrong verifier',
  { skip: process.env.SCRYER_LOCAL_OIDC !== '1' }, async () => {
    const users = JSON.parse(await readFile(usersPath, 'utf8'));
    assert.equal(typeof users['student-one'], 'string');
    assert.equal(typeof users['student-two'], 'string');
    const config = await discovery();
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      response.end('OIDC local test callback');
    });
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(39000, '127.0.0.1', resolveListen);
    });
    let browser;
    try {
      browser = await chromium.launch({ headless: true,
        executablePath: process.env.SCRYER_BROWSER_BIN || chromium.executablePath() });
      const first = await login(browser, config, 'student-one', users['student-one']);
      const second = await login(browser, config, 'student-two', users['student-two']);
      assert.notEqual(first.subject, second.subject);
      await login(browser, config, 'student-one', users['student-one'], true);
    } finally {
      if (browser) await browser.close();
      server.closeAllConnections();
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  });
