import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HealthCallError, expectHealthError } from '../src/errors.js';
import { civilRangeFilter, paginate, retryDelayMs, toHealthError } from '../src/health.js';

test('the civil range filter has an exclusive upper bound on the day after end', () => {
  assert.equal(
    civilRangeFilter('sleep.interval.civil_end_time', { start: '2026-02-27', end: '2026-02-28' }),
    'sleep.interval.civil_end_time >= "2026-02-27" AND sleep.interval.civil_end_time < "2026-03-01"',
  );
});

test('paging stops at the page cap with an expected error instead of returning a partial window', async () => {
  let pages = 0;
  const fetchPage = async () => {
    pages += 1;
    return { items: [pages], nextPageToken: `p${pages}` };
  };
  await assert.rejects(() => paginate(fetchPage, 'items', 3, 'window not covered'), (error: unknown) => {
    assert.ok(error instanceof HealthCallError);
    assert.equal(error.message, 'window not covered');
    return true;
  });
  assert.equal(pages, 3);
  assert.deepEqual(await paginate(async () => 'not an object', 'items', 3, 'unused'), []);
});

test('Retry-After is honored up to a cap, with a default when absent or unreadable', () => {
  assert.equal(retryDelayMs('0'), 0);
  assert.equal(retryDelayMs('2'), 2000);
  assert.equal(retryDelayMs('120'), 5000);
  assert.equal(retryDelayMs(null), 1000);
  assert.equal(retryDelayMs('Wed, 21 Oct 2026 07:28:00 GMT'), 1000);
  assert.equal(retryDelayMs('-1'), 1000);
});

test('Health errors are classified and never echo the bearer token', () => {
  const notLinked = toHealthError(400, { error: { details: [{ reason: 'ACCOUNT_NOT_LINKED' }] } }, 'tok-123456');
  assert.equal(notLinked.kind, 'not_linked');
  assert.equal(notLinked.stopsAllReads, true);
  const scope = toHealthError(400, { error: { status: 'PERMISSION_DENIED' } }, 'tok-123456');
  assert.equal(scope.kind, 'missing_scope');
  assert.equal(scope.stopsAllReads, false);
  assert.equal(toHealthError(403, {}, 'tok-123456').kind, 'missing_scope');
  const echoed = toHealthError(500, { error: { message: 'bad token tok-123456 here' } }, 'tok-123456');
  assert.equal(echoed.message, 'bad token [redacted] here');
  assert.equal(toHealthError(502, 'gateway', 'tok-123456').message, 'Health API request failed (HTTP 502).');
});

test('expectHealthError passes expected failures through and rethrows bugs', () => {
  const expected = new HealthCallError('http', 'boom');
  assert.equal(expectHealthError(expected), expected);
  assert.throws(() => expectHealthError(new TypeError('bug')), TypeError);
});
