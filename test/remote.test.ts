import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { REDIRECT_MISMATCH_MESSAGE, SCOPES } from '../src/constants.js';
import { createHealthApi } from '../src/health.js';
import { createPkcePair, exchangeCode, googleAuthorizeUrl } from '../src/oauth.js';
import { connectionStatus } from '../src/status.js';
import { clientRegistrationCallback, ownerRefusal } from '../src/worker-auth.js';
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

test('a 503 is retried once after Retry-After, a second 503 is not', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (calls === 1) return new Response('', { status: 503, headers: { 'Retry-After': '0' } });
    return new Response(JSON.stringify({ ok: true }));
  }) as typeof fetch;
  const api = createHealthApi({ configDir: '/nonexistent', fetchImpl, now: () => new Date(), remote });
  assert.deepEqual(await api.get('/users/me/identity'), { ok: true });
  assert.equal(calls, 2);

  calls = 0;
  const failing = (async () => {
    calls += 1;
    return new Response('', { status: 503, headers: { 'Retry-After': '0' } });
  }) as typeof fetch;
  await assert.rejects(createHealthApi({ configDir: '/nonexistent', fetchImpl: failing, now: () => new Date(), remote }).get('/users/me/identity'));
  assert.equal(calls, 2);
});

test('connection_status reports from the remote token when there is no token file', async () => {
  const api = { get: async () => ({}), post: async () => ({}) };
  const status = await connectionStatus('/nonexistent', api, new Date('2026-03-01T00:30:00.000Z'), remote);
  assert.equal(status.healthAccountLinked, true);
  assert.equal(status.accessTokenExpiresAt, remote.expiry);
  assert.equal(status.loginDueAt, '2026-03-08T00:00:00.000Z');
  assert.equal(JSON.stringify(status).includes('remote-access'), false);
});

test('registration accepts known web hosts and loopback, and refuses any other redirect host', () => {
  const register = (...redirect_uris: string[]) => clientRegistrationCallback({ clientMetadata: { redirect_uris }, request: new Request('https://w.example/register') });
  assert.equal(register('https://claude.ai/api/mcp/auth_callback'), undefined);
  assert.equal(register('http://localhost:33418/callback', 'cursor://anysphere.cursor-mcp/oauth/callback'), undefined);
  assert.equal(register('https://chatgpt.com/connector_platform_oauth_redirect'), undefined);
  assert.equal(register('https://claude.ai/cb', 'https://evil.example/cb')?.status, 403);
  assert.equal(register('http://claude.ai/cb')?.status, 403);
});

test('only the owner Google account may finish the Worker sign-in', async () => {
  const fetchImpl = (async () => Response.json({ healthUserId: '111' })) as typeof fetch;
  const tokens = { ...remote, refreshToken: 'r' };
  assert.equal(await ownerRefusal(tokens, '111', fetchImpl), undefined);
  assert.match((await ownerRefusal(tokens, '222', fetchImpl))!, /not the owner/);
  assert.match((await ownerRefusal(tokens, undefined, fetchImpl))!, /OWNER_HEALTH_USER_ID is not set.*111/);
});

test('a PKCE pair is fresh each time and its challenge is the S256 of the verifier', () => {
  const first = createPkcePair();
  const second = createPkcePair();
  assert.notEqual(first.verifier, second.verifier);
  assert.match(first.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(createHash('sha256').update(first.verifier).digest('base64url'), first.challenge);
});

test('a failed code exchange explains a redirect mismatch and hides the client secret', async () => {
  const reply = (body: unknown) => (async () => Response.json(body, { status: 400 })) as typeof fetch;
  const input = { now: new Date(), clientId: 'cid', clientSecret: 'secret-value', code: 'code-value', verifier: 'verifier-value' };
  await assert.rejects(exchangeCode({ ...input, fetchImpl: reply({ error: 'redirect_uri_mismatch' }) }), new RegExp(REDIRECT_MISMATCH_MESSAGE.replace(/[.]/g, '\\.')));
  await assert.rejects(exchangeCode({ ...input, fetchImpl: reply({ error: 'invalid_grant', error_description: 'code-value used with secret-value' }) }), (error: Error) => {
    assert.equal(error.message, 'Token request failed ([redacted] used with [redacted]).');
    return true;
  });
});
