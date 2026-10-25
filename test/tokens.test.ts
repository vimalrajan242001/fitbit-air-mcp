import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createHealthApi, healthUrl } from '../src/health.js';
import { readTokenFile, writeTokenFile } from '../src/tokens.js';

test('health URLs stay on the Health API host', () => {
  assert.equal(healthUrl('/users/me/identity').href, 'https://health.googleapis.com/v4/users/me/identity');
  assert.throws(() => healthUrl('https://api.fitbit.com/1/user/-/profile.json'));
});

test('an expired access token refreshes once and keeps the refresh time', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fitbit-air-refresh-'));
  const now = new Date('2026-03-04T12:00:00.000Z');
  writeFileSync(join(dir, 'env'), 'GOOGLE_OAUTH_CLIENT_ID=client-id\nGOOGLE_OAUTH_CLIENT_SECRET=c-secret\n');
  writeTokenFile(dir, {
    accessToken: 'old-acc',
    expiry: new Date(now.getTime() - 60_000).toISOString(),
    refreshToken: 'r-sent',
    scopes: ['https://www.googleapis.com/auth/googlehealth.profile.readonly'],
    refreshObtainedAt: '2026-03-03T12:00:00.000Z',
  });
  try {
    const api = createHealthApi({
      configDir: dir,
      now: () => now,
      fetchImpl: async (input, init) => {
        const url = input instanceof URL ? input.href : String(input);
        if (url === 'https://oauth2.googleapis.com/token') {
          const params = new URLSearchParams(String(init?.body));
          assert.equal(params.get('grant_type'), 'refresh_token');
          assert.equal(params.get('refresh_token'), 'r-sent');
          return Response.json({ access_token: 'new-acc', expires_in: 3600, token_type: 'Bearer' });
        }
        if (url === 'https://health.googleapis.com/v4/users/me/identity') {
          assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer new-acc');
          return Response.json({ name: 'users/me/identity' });
        }
        throw new Error(`unexpected ${url}`);
      },
    });
    await api.get('/users/me/identity');
    const saved = readTokenFile(dir);
    assert.equal(saved?.accessToken, 'new-acc');
    assert.equal(saved?.refreshToken, 'r-sent');
    assert.equal(saved?.refreshObtainedAt, '2026-03-03T12:00:00.000Z');
    assert.equal(saved?.expiry, '2026-03-04T13:00:00.000Z');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
