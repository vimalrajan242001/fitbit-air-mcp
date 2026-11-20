import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  addCivilDays,
  chunkRange,
  assertRange,
  civilDateOf,
  civilToday,
  closedOpenRange,
  eachCivilDate,
  inclusiveDayCount,
  intervalMinutes,
  parseCivilDate,
  parseDurationSeconds,
  readInterval,
} from '../src/dates.js';

test('civil dates parse strictly and refuse impossible days', () => {
  assert.deepEqual(parseCivilDate('2028-02-29'), { year: 2028, month: 2, day: 29 });
  assert.throws(() => parseCivilDate('2026-02-29'), /real calendar day/);
  assert.throws(() => parseCivilDate('2026-2-01'), /YYYY-MM-DD/);
});

test('day arithmetic crosses months and years', () => {
  assert.equal(addCivilDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addCivilDays('2026-03-01', -1), '2026-02-28');
  assert.equal(inclusiveDayCount('2026-03-01', '2026-03-01'), 1);
  assert.deepEqual(eachCivilDate('2026-02-27', '2026-03-01'), ['2026-02-27', '2026-02-28', '2026-03-01']);
  assert.throws(() => eachCivilDate('2026-03-02', '2026-03-01'), /before the start/);
});

test('a closed-open range ends at the next local midnight', () => {
  const range = closedOpenRange('2026-03-01', '2026-03-31');
  assert.deepEqual(range.start.date, { year: 2026, month: 3, day: 1 });
  assert.deepEqual(range.end.date, { year: 2026, month: 4, day: 1 });
  assert.deepEqual(range.end.time, { hours: 0, minutes: 0, seconds: 0, nanos: 0 });
});

test('assertRange names the limit', () => {
  assert.doesNotThrow(() => assertRange('2026-03-01', '2026-03-07', 7));
  assert.throws(() => assertRange('2026-03-01', '2026-03-08', 7), /This range is 8 days\. This read covers at most 7 days\./);
  assert.throws(() => assertRange('2026-03-02', '2026-03-01', 7), /before the start/);
});

test('today follows the account time zone', () => {
  const now = new Date('2026-03-04T02:00:00.000Z');
  assert.equal(civilToday('Etc/UTC', now), '2026-03-04');
  assert.equal(civilToday('America/Los_Angeles', now), '2026-03-03');
  assert.throws(() => civilToday('Not/AZone', now), /time zone could not be applied/);
});

test('a civil date comes from the civil time, else from UTC time plus offset', () => {
  assert.equal(civilDateOf({ date: { year: 2026, month: 3, day: 4 } }, '2026-03-09T00:00:00Z', '0s'), '2026-03-04');
  assert.equal(civilDateOf(undefined, '2026-03-04T23:30:00Z', '3600s'), '2026-03-05');
  assert.equal(civilDateOf(undefined, '2026-03-04T00:30:00Z', '-3600s'), '2026-03-03');
  assert.equal(civilDateOf(undefined, 'not a time', '0s'), null);
  assert.equal(civilDateOf(undefined, undefined, undefined), null);
});

test('Google durations parse as seconds', () => {
  assert.equal(parseDurationSeconds('2400s'), 2400);
  assert.equal(parseDurationSeconds('-14400s'), -14400);
  assert.equal(parseDurationSeconds('1.5s'), 1.5);
  assert.equal(parseDurationSeconds('40m'), undefined);
  assert.equal(parseDurationSeconds(40), undefined);
});

test('chunkRange splits an inclusive range into fixed slices with a short last slice', () => {
  assert.deepEqual(chunkRange('2026-07-01', '2026-07-17', 7), [
    { start: '2026-07-01', end: '2026-07-07' },
    { start: '2026-07-08', end: '2026-07-14' },
    { start: '2026-07-15', end: '2026-07-17' },
  ]);
  assert.deepEqual(chunkRange('2026-07-01', '2026-07-01', 14), [{ start: '2026-07-01', end: '2026-07-01' }]);
});

test('readInterval keeps the documented fields and intervalMinutes refuses a backwards interval', () => {
  const interval = readInterval({ startTime: '2026-03-04T07:00:00Z', endTime: '2026-03-04T07:45:30Z', startUtcOffset: '3600s', extra: 'dropped' });
  assert.deepEqual(interval, { startTime: '2026-03-04T07:00:00Z', endTime: '2026-03-04T07:45:30Z', startUtcOffset: '3600s' });
  assert.equal(intervalMinutes(interval!), 46);
  assert.equal(readInterval({ startTime: '2026-03-04T07:00:00Z' }), null);
  assert.equal(intervalMinutes({ startTime: '2026-03-04T08:00:00Z', endTime: '2026-03-04T07:00:00Z' }), null);
  assert.equal(intervalMinutes({ startTime: 'soon', endTime: '2026-03-04T07:00:00Z' }), null);
});
