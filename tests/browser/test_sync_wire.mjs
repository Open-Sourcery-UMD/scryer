import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { openBrowserHarness } from './harness.mjs';

test('actual browser outbox chunks assemble under the independent Python transport parser', async (t) => {
  const { page } = await openBrowserHarness(t);
  const fixture = await page.evaluate(async (dbName) => {
    const { createAccountKeys } = await import('/crypto/keys.js');
    const { openLocalRepository } = await import('/storage/repository.js');
    const created = await createAccountKeys('acct-wire');
    const repo = await openLocalRepository({ dbName, session: created.session,
      recoveryEnvelope: created.recoveryEnvelope, recoverySecret: created.recoverySecret,
      validateCase: async () => {} });
    const caseData = { schemaVersion: '1', caseId: 'case-wire', currency: 'USD',
      institutions: [], accountRefs: [], terms: [], aidItems: [], artifacts: [],
      proposals: [], events: [] };
    await repo.commitReviewed({ case: caseData, ledger: { schemaVersion: '1', reviews: [] },
      revisionId: 'rev-wire', operationId: 'op-wire', expectedLocalRevision: null,
      serverRevision: null });
    const outbox = await repo.prepareSync('case-wire');
    const snapshot = await repo.encryptedSnapshot();
    repo.close();
    return { accountId: 'acct-wire', steps: outbox[0].steps, package: snapshot.cases[0].package };
  }, `scryer-wire-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const digest = createHash('sha256').update(JSON.stringify(fixture.package)).digest('hex');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const check = spawnSync('python3', ['tests/sync/check_browser_wire.py'], {
    cwd: root, env: { ...process.env, PYTHONPATH: root },
    input: JSON.stringify({ accountId: fixture.accountId, steps: fixture.steps,
      expectedPackageDigest: digest }), encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(check.status, 0, check.stderr);
});
