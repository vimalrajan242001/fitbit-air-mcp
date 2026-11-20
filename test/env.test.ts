import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { loadOAuthClient, parseEnv } from '../src/env.js';

test('parseEnv skips comments and blank lines and strips matching quotes', () => {
  const values = parseEnv('# comment\n\nA=1\r\nB = "two words"\nC=\'3\'\nD="unbalanced\nnot a pair\nE=a=b\n');
  assert.deepEqual([...values], [
    ['A', '1'],
    ['B', 'two words'],
    ['C', '3'],
    ['D', '"unbalanced'],
    ['E', 'a=b'],
  ]);
});

test('loadOAuthClient explains a missing file, missing keys, and placeholders without the absolute path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fitbit-air-env-'));
  try {
    assert.throws(() => loadOAuthClient(dir), (error: Error) => error.message.startsWith('Missing env file at ~/.config/fitbit-air-mcp/env') && !error.message.includes(dir));
    writeFileSync(join(dir, 'env'), 'GOOGLE_OAUTH_CLIENT_ID=id\n');
    assert.throws(() => loadOAuthClient(dir), /Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET/);
    writeFileSync(join(dir, 'env'), 'GOOGLE_OAUTH_CLIENT_ID=<id>\nGOOGLE_OAUTH_CLIENT_SECRET=s\n');
    assert.throws(() => loadOAuthClient(dir), /Replace placeholder credentials/);
    writeFileSync(join(dir, 'env'), 'GOOGLE_OAUTH_CLIENT_ID=id\nGOOGLE_OAUTH_CLIENT_SECRET=your-google-oauth-client-secret\n');
    assert.throws(() => loadOAuthClient(dir), /Replace placeholder credentials/);
    writeFileSync(join(dir, 'env'), 'GOOGLE_OAUTH_CLIENT_ID=id\nGOOGLE_OAUTH_CLIENT_SECRET=s\n', { mode: 0o644 });
    assert.deepEqual(loadOAuthClient(dir), { clientId: 'id', clientSecret: 's' });
    if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'env')).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
