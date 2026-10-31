import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { SCOPES } from '../src/constants.js';
import { createHealthApi } from '../src/health.js';
import { exchangeCode, googleAuthorizeUrl } from '../src/oauth.js';
import { connectionStatus } from '../src/status.js';
import type { RemoteToken } from '../src/tokens.js';

const remote: RemoteToken = {
  accessToken: 'remote-access',
  expiry: '2026-03-01T01:00:00.000Z',
  scopes: [...SCOPES],
  refreshObtainedAt: '2026-03-01T00:00:00.000Z',
};

test('Google consent URL carries the Worker redirect, five scopes, and PKCE S256', () => {
  const url = googleAuthorizeUrl({ clientId: 'cid', redirectUri: 'https://w.example/callback', challenge: 'ch', state: 'st' });
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://w.example/callback');
  assert.equal(url.searchParams.get('scope'), SCOPES.join(' '));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('access_type'), 'offline');
});

test('code exchange sends the given redirect URI', async () => {
  let sent = '';
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent = String(init?.body);
    return new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: SCOPES.join(' ') }));
  }) as typeof fetch;
  const tokens = await exchangeCode({
    fetchImpl,
    redirectUri: 'https://w.example/callback',
    now: new Date('2026-03-01T00:00:00.000Z'),
    clientId: 'cid',
    clientSecret: 'secret',
    code: 'code',
    verifier: 'verifier',
  });
  assert.equal(new URLSearchParams(sent).get('redirect_uri'), 'https://w.example/callback');
  assert.equal(tokens.refreshToken, 'r');
});

test('a remote token is used as-is, never touches the token file, and a 401 is not retried', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fitbit-air-remote-'));
  try {
    const seen: string[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('authorization') ?? '');
      return new Response(JSON.stringify({ error: { message: 'expired' } }), { status: 401 });
    }) as typeof fetch;
    const api = createHealthApi({ configDir: dir, fetchImpl, now: () => new Date(), remote });
    await assert.rejects(api.get('/users/me/identity'));
    assert.deepEqual(seen, ['Bearer remote-access']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('connection_status reports from the remote token when there is no token file', async () => {
  const api = { get: async () => ({}), post: async () => ({}) };
  const status = await connectionStatus('/nonexistent', api, new Date('2026-03-01T00:30:00.000Z'), remote);
  assert.equal(status.healthAccountLinked, true);
  assert.equal(status.accessTokenExpiresAt, remote.expiry);
  assert.equal(status.loginDueAt, '2026-03-08T00:00:00.000Z');
  assert.equal(JSON.stringify(status).includes('remote-access'), false);
});
