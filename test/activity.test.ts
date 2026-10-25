import assert from 'node:assert/strict';
import { test } from 'node:test';

import { comparePeriods, readDailyActivity } from '../src/activity.js';
import { WEARABLE_FAMILY } from '../src/constants.js';
import { HealthCallError } from '../src/errors.js';
import { fakeHealthApi, loadFixture } from './fixture.js';

const publishedDay = loadFixture('steps-daily-rollup.json');
const publishedRange = loadFixture('steps-daily-range.json');
const rangePoints = publishedRange.rollupDataPoints as Array<Record<string, unknown>>;

test('maps the published steps dailyRollUp and leaves a gap missing', async () => {
  const api = fakeHealthApi(async (_method, path, body) => {
    if (path.includes('/steps/')) {
      const requested = body as { range: { end: { date: { day: number } } }; windowSizeDays: number; dataSourceFamily: string };
      assert.equal(requested.windowSizeDays, 1);
      assert.equal(requested.dataSourceFamily, WEARABLE_FAMILY);
      assert.equal(requested.range.end.date.day, 28);
      if (requested.range.end.date.day === 28) return publishedDay;
    }
    return { rollupDataPoints: [] };
  });
  const result = await readDailyActivity(api, '2026-02-26', '2026-02-27');
  assert.equal(result.days[0]?.steps?.countSum, 3822);
  assert.equal(result.days[1]?.steps, undefined);
  assert.deepEqual(
    result.missing.filter((entry) => entry.date === '2026-02-27'),
    [{ date: '2026-02-27', reason: 'no wearable samples' }],
  );
  assert.equal(JSON.stringify(result).includes('"steps":{"countSum":0}'), false);
});

test('keeps a documented zero step count', async () => {
  const zero = structuredClone(publishedDay);
  const points = zero.rollupDataPoints as Array<{ steps: { countSum: string } }>;
  points[0]!.steps.countSum = '0';
  const api = fakeHealthApi(async (_method, path) => (path.includes('/steps/') ? zero : { rollupDataPoints: [] }));
  const result = await readDailyActivity(api, '2026-02-26', '2026-02-26');
  assert.equal(result.days[0]?.steps?.countSum, 0);
  assert.equal(result.missing.some((entry) => entry.series === 'steps'), false);
});

test('follows dailyRollUp page tokens and does not convert distance', async () => {
  const api = fakeHealthApi(async (_method, path, body) => {
    const payload = body as { pageToken?: string };
    if (path.includes('/steps/')) {
      if (!payload.pageToken) return { rollupDataPoints: [rangePoints[0]], nextPageToken: 'p2' };
      assert.equal(payload.pageToken, 'p2');
      return { rollupDataPoints: [rangePoints[1]] };
    }
    if (path.includes('/distance/')) {
      return {
        rollupDataPoints: [
          {
            civilStartTime: { date: { year: 2026, month: 7, day: 28 } },
            distance: { millimetersSum: '1000' },
          },
        ],
      };
    }
    return { rollupDataPoints: [] };
  });
  const result = await readDailyActivity(api, '2026-07-28', '2026-07-29');
  assert.deepEqual(
    result.days.map((day) => day.steps?.countSum),
    [8430, 11245],
  );
  assert.equal(result.days[0]?.distance?.millimetersSum, 1000);
  assert.equal(JSON.stringify(result).includes('0.62'), false);
  const stepCalls = api.calls.filter((call) => call.path.includes('/steps/'));
  assert.equal(stepCalls.length, 2);
});

test('a missing scope does not blank the other series', async () => {
  const api = fakeHealthApi(async (_method, path) => {
    if (path.includes('/distance/')) throw new HealthCallError('missing_scope', 'missing scope', 403);
    if (path.includes('/steps/')) return publishedDay;
    return { rollupDataPoints: [] };
  });
  const result = await readDailyActivity(api, '2026-02-26', '2026-02-26');
  assert.equal(result.days[0]?.steps?.countSum, 3822);
  assert.deepEqual(
    result.missing.find((entry) => entry.series === 'distance'),
    { series: 'distance', reason: 'missing scope' },
  );
});

test('refuses an activity range longer than 7 days before calling the API', async () => {
  const api = fakeHealthApi(() => ({ rollupDataPoints: [] }));
  await assert.rejects(() => readDailyActivity(api, '2026-07-01', '2026-07-08'), /7 days/);
  assert.equal(api.calls.length, 0);
});

test('compare_periods subtracts the published daily step counts', async () => {
  const api = fakeHealthApi(async (_method, path, body) => {
    if (!path.includes('/steps/')) return { rollupDataPoints: [] };
    const start = (body as { range: { start: { date: { day: number } } } }).range.start.date.day;
    const point = rangePoints.find((entry) => (entry.civilStartTime as { date: { day: number } }).date.day === start);
    return { rollupDataPoints: point ? [point] : [] };
  });
  const result = await comparePeriods(api, { start: '2026-07-28', end: '2026-07-28' }, { start: '2026-07-29', end: '2026-07-29' });
  assert.equal(result.deltas.stepsCountSum, 11245 - 8430);
  assert.equal(result.deltas.distanceMillimetersSum, undefined);
  assert.equal(result.deltaMeaning, 'periodB minus periodA');
});
