import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { REDIRECT_MISMATCH_MESSAGE, REDIRECT_URI, SCOPES } from '../src/constants.js';
import { login } from '../src/oauth.js';
import { readTokenFile } from '../src/tokens.js';

test('loopback login uses PKCE S256 and stores only the token file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fitbit-air-login-'));
  const now = new Date('2026-03-04T12:00:00.000Z');
  writeEnv(dir);
  try {
    await assert.rejects(
      () =>
        login({
          configDir: dir,
          now: () => now,
          timeoutMs: 3000,
          fetchImpl: async () => {
            throw new Error('token exchange should not run');
          },
          openUrl: async (url) => {
            const parsed = new URL(url);
            const state = parsed.searchParams.get('state');
            assert.ok(state);
            await hitLoopback(`/?error=redirect_uri_mismatch&state=${state}`);
          },
        }),
      new RegExp(REDIRECT_MISMATCH_MESSAGE.replace(/[.]/g, '\\.')),
    );
    assert.equal(readTokenFile(dir), null);

    let tokenBody = '';
    let challenge = '';
    const result = await login({
      configDir: dir,
      now: () => now,
      timeoutMs: 3000,
      openUrl: async (url) => {
        const parsed = new URL(url);
        assert.equal(parsed.origin, 'https://accounts.google.com');
        assert.equal(parsed.searchParams.get('redirect_uri'), REDIRECT_URI);
        assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
        assert.equal(parsed.searchParams.get('access_type'), 'offline');
        assert.equal(parsed.searchParams.get('prompt'), 'consent');
        assert.equal(parsed.searchParams.get('response_type'), 'code');
        assert.deepEqual(parsed.searchParams.get('scope')?.split(' '), [...SCOPES]);
        assert.equal(parsed.searchParams.get('client_secret'), null);
        challenge = parsed.searchParams.get('code_challenge') ?? '';
        const state = parsed.searchParams.get('state');
        assert.ok(state);
        await hitLoopback(`/?code=test-code&state=${state}`);
      },
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url === 'https://oauth2.googleapis.com/token') {
          tokenBody = String(init?.body);
          return json({
            access_token: 'a-sent',
            expires_in: 3600,
            refresh_token: 'r-sent',
            scope: SCOPES.join(' '),
            token_type: 'Bearer',
          });
        }
        if (url === 'https://health.googleapis.com/v4/users/me/identity') {
          assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer a-sent');
          return json({ name: 'users/me/identity', legacyUserId: 'A1B2C3', healthUserId: '111111256096816351' });
        }
        throw new Error(`unexpected ${url}`);
      },
    });
    assert.equal(result.phoneSetupUnfinished, false);
    const saved = readTokenFile(dir);
    assert.ok(saved);
    assert.equal(saved.accessToken, 'a-sent');
    assert.equal(saved.refreshToken, 'r-sent');
    assert.equal(saved.refreshObtainedAt, now.toISOString());
    assert.equal(saved.expiry, '2026-03-04T13:00:00.000Z');
    assert.equal(saved.scopes.length, 5);
    const params = new URLSearchParams(tokenBody);
    assert.equal(params.get('grant_type'), 'authorization_code');
    assert.equal(params.get('redirect_uri'), REDIRECT_URI);
    assert.equal(params.get('code'), 'test-code');
    const verifier = params.get('code_verifier');
    assert.ok(verifier);
    assert.equal(createHash('sha256').update(verifier).digest('base64url'), challenge);
    const file = readFileSync(join(dir, 'tokens.json'), 'utf8');
    assert.equal(file.includes('c-secret'), false);
    assert.equal(file.includes('client-id'), false);

    const unlinked = await login({
      configDir: dir,
      now: () => now,
      timeoutMs: 3000,
      openUrl: async (url) => {
        const state = new URL(url).searchParams.get('state');
        await hitLoopback(`/?code=test-code&state=${state}`);
      },
      fetchImpl: async (input) => {
        const url = String(input);
        if (url === 'https://oauth2.googleapis.com/token') {
          return json({
            access_token: 'a-sent',
            expires_in: 3600,
            refresh_token: 'r-sent',
            scope: SCOPES.join(' '),
            token_type: 'Bearer',
          });
        }
        return json(
          {
            error: {
              code: 400,
              message: 'The account is not linked to Google Health.',
              status: 'FAILED_PRECONDITION',
              details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCOUNT_NOT_LINKED', domain: 'health.googleapis.com' }],
            },
          },
          400,
        );
      },
    });
    assert.equal(unlinked.phoneSetupUnfinished, true);
    assert.match(unlinked.message, /phone setup unfinished/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeEnv(dir: string): void {
  writeFileSync(join(dir, 'env'), 'GOOGLE_OAUTH_CLIENT_ID=client-id\nGOOGLE_OAUTH_CLIENT_SECRET=c-secret\n');
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function hitLoopback(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: 8787, path, method: 'GET' }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.end();
  });
}
