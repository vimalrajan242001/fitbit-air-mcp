import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createHealthApi, healthUrl } from '../src/health.js';
import { HealthCallError } from '../src/errors.js';
import { readTokenFile, refreshAccessToken, tokenFileFromResponse, writeTokenFile } from '../src/tokens.js';

test('health URLs stay on the Health API host', () => {
  assert.equal(healthUrl('/users/me/identity').href, 'https://health.googleapis.com/v4/users/me/identity');
  assert.throws(() => healthUrl('https://api.fitbit.com/1/user/-/profile.json'));
});

test('writing the token file replaces it and leaves no temp file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fitbit-air-write-'));
  const tokens = { accessToken: 'a1', expiry: '2026-03-04T12:00:00.000Z', refreshToken: 'r1', scopes: [], refreshObtainedAt: '2026-03-03T12:00:00.000Z' };
  try {
    writeTokenFile(dir, tokens);
    writeTokenFile(dir, { ...tokens, accessToken: 'a2' });
    assert.equal(readTokenFile(dir)?.accessToken, 'a2');
    assert.deepEqual(readdirSync(dir), ['tokens.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test('a refresh rejected with invalid_grant means login is due; other failures are sanitized', async () => {
  const current = { accessToken: 'a', expiry: '2026-03-04T12:00:00.000Z', refreshToken: 'r-secret-value', scopes: [], refreshObtainedAt: '2026-03-03T12:00:00.000Z' };
  const client = { clientId: 'cid', clientSecret: 'c-secret-value' };
  const now = new Date('2026-03-04T12:00:00.000Z');
  const reply = (body: unknown, status: number) => (async () => Response.json(body, { status })) as typeof fetch;
  await assert.rejects(refreshAccessToken(current, client, reply({ error: 'invalid_grant' }, 400), now), (error: unknown) => {
    assert.ok(error instanceof HealthCallError);
    assert.equal(error.kind, 'login_due');
    return true;
  });
  await assert.rejects(
    refreshAccessToken(current, client, reply({ error: 'invalid_client', error_description: 'bad c-secret-value' }, 401), now),
    /^HealthCallError: Token request failed \(bad \[redacted\]\)\.$/,
  );
  const notJson = (async () => new Response('<html>', { status: 502 })) as typeof fetch;
  await assert.rejects(refreshAccessToken(current, client, notJson, now), /non-JSON response \(HTTP 502\)/);
});

test('a token response must carry an access token, expires_in, and on login a refresh token', () => {
  const now = new Date('2026-03-04T12:00:00.000Z');
  assert.throws(() => tokenFileFromResponse({ expires_in: 3600 }, { now, requireRefreshToken: true }), /access token/);
  assert.throws(() => tokenFileFromResponse({ access_token: 'a' }, { now, requireRefreshToken: true }), /expires_in/);
  assert.throws(() => tokenFileFromResponse({ access_token: 'a', expires_in: 3600 }, { now, requireRefreshToken: true }), /refresh token/);
  const rotated = tokenFileFromResponse(
    { access_token: 'a2', expires_in: 60, refresh_token: 'r2', scope: 'x  y' },
    { now, requireRefreshToken: false, previous: { accessToken: 'a', expiry: '', refreshToken: 'r1', scopes: ['old'], refreshObtainedAt: '2026-03-01T00:00:00.000Z' } },
  );
  assert.equal(rotated.refreshObtainedAt, now.toISOString(), 'a new refresh token restarts the 7-day clock');
  assert.deepEqual(rotated.scopes, ['x', 'y']);
});
