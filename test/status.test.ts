import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { SCOPES, TESTING_REFRESH_MS } from '../src/constants.js';
import { HealthCallError } from '../src/errors.js';
import { connectionStatus } from '../src/status.js';
import { loginDeadline, writeTokenFile, type TokenFile } from '../src/tokens.js';
import { fakeHealthApi } from './fixture.js';

const obtained = '2026-03-01T00:00:00.000Z';

function tokens(now: Date, expiryOffsetMs: number): TokenFile {
  return {
    accessToken: 'a-sent',
    expiry: new Date(now.getTime() + expiryOffsetMs).toISOString(),
    refreshToken: 'r-sent',
    scopes: [...SCOPES],
    refreshObtainedAt: obtained,
  };
}

test('login deadline is seven days after refreshObtainedAt', () => {
  assert.equal(TESTING_REFRESH_MS, 604_800_000);
  assert.equal(loginDeadline(obtained), '2026-03-08T00:00:00.000Z');
});

test('connection_status reports link state and never returns tokens', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fitbit-air-status-'));
  try {
    const dueAt = new Date('2026-03-08T00:00:00.000Z');
    const before = new Date(dueAt.getTime() - 1);
    writeTokenFile(dir, tokens(before, 60 * 60 * 1000));
    assert.equal(statSync(join(dir, 'tokens.json')).mode & 0o777, 0o600);
    const linked = fakeHealthApi(async () => ({ name: 'users/me/identity' }));
    const fresh = await connectionStatus(dir, linked, before);
    assert.equal(fresh.healthAccountLinked, true);
    assert.equal(fresh.loginDue, false);
    assert.equal(fresh.loginDueAt, '2026-03-08T00:00:00.000Z');
    assert.equal(fresh.scopes.length, 5);
    const freshText = JSON.stringify(fresh);
    assert.equal(freshText.includes('a-sent'), false);
    assert.equal(freshText.includes('r-sent'), false);
    assert.equal(/"accessToken"\s*:/.test(freshText), false);
    assert.equal(/"refreshToken"\s*:/.test(freshText), false);

    const expired = new Date(dueAt.getTime() + 1000);
    writeTokenFile(dir, tokens(expired, -1000));
    const notCalled = fakeHealthApi(async () => {
      throw new Error('identity should not be called');
    });
    const due = await connectionStatus(dir, notCalled, expired);
    assert.equal(due.loginDue, true);
    assert.equal(due.healthAccountLinked, false);
    assert.equal(due.missing[0]?.reason, 'login due');
    assert.equal(notCalled.calls.length, 0);

    writeTokenFile(dir, tokens(before, 60 * 60 * 1000));
    const unlinked = fakeHealthApi(async () => {
      throw new HealthCallError('not_linked', 'phone setup unfinished', 400);
    });
    const phone = await connectionStatus(dir, unlinked, before);
    assert.equal(phone.phoneSetupUnfinished, true);
    assert.equal(phone.healthAccountLinked, false);
    assert.equal(phone.missing[0]?.reason, 'phone setup unfinished');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('connection_status without a token file asks for login', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fitbit-air-empty-'));
  try {
    writeFileSync(join(dir, 'note.txt'), 'empty');
    const api = fakeHealthApi(async () => ({}));
    const status = await connectionStatus(dir, api, new Date('2026-03-04T00:00:00.000Z'));
    assert.equal(status.loginDue, true);
    assert.equal(status.missing[0]?.reason, 'no local token file');
    assert.equal(api.calls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
