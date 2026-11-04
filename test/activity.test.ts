import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readDailyActivity } from '../src/activity.js';
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

test('follows dailyRollUp page tokens and keeps millimetersSum next to kilometers', async () => {
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
            distance: { millimetersSum: '5432100' },
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
  assert.equal(result.days[0]?.distance?.millimetersSum, 5432100);
  assert.equal(result.days[0]?.distance?.kilometers, 5.43);
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


test('an auth stop on any series marks every series missing and adds no per-day gaps', async () => {
  const api = fakeHealthApi(async (_method, path) => {
    if (path.includes('/distance/')) throw new HealthCallError('not_linked', 'phone setup unfinished', 400);
    return publishedDay;
  });
  const result = await readDailyActivity(api, '2026-02-26', '2026-02-26');
  assert.equal(result.missing.length, 5);
  assert.equal(result.missing.every((entry) => entry.reason === 'phone setup unfinished' && entry.date === undefined), true);
});

test('maps every documented rollup field and reports a present-but-unreadable rollup per series', async () => {
  const day = (dayOfMonth: number) => ({ civilStartTime: { date: { year: 2026, month: 3, day: dayOfMonth } } });
  const rollups: Record<string, unknown[]> = {
    steps: [{ ...day(1), steps: { countSum: '1200' } }, { ...day(2), steps: { countSum: 'n/a' } }],
    distance: [{ ...day(1), distance: { millimetersSum: 900000 } }, { ...day(2), distance: {} }],
    'active-zone-minutes': [
      { ...day(1), activeZoneMinutes: { sumInFatBurnHeartZone: '10', sumInPeakHeartZone: 2 } },
      { ...day(2), activeZoneMinutes: { unrelated: 1 } },
    ],
    'active-minutes': [
      {
        ...day(1),
        activeMinutes: {
          activeMinutesRollupByActivityLevel: [
            { activityLevel: 'LIGHT', activeMinutesSum: '30' },
            { activityLevel: 'VERY', activeMinutesSum: 'x' },
            { activeMinutesSum: 4 },
          ],
        },
      },
      { ...day(2), activeMinutes: { activeMinutesRollupByActivityLevel: [] } },
    ],
    'total-calories': [{ ...day(1), totalCalories: { kcalSum: 2100.5 } }, { ...day(2), totalCalories: { kcalSum: null } }],
  };
  const api = fakeHealthApi(async (_method, path) => {
    const series = /dataTypes\/([^/]+)\//.exec(path)?.[1] ?? '';
    return { rollupDataPoints: rollups[series] ?? [] };
  });
  const result = await readDailyActivity(api, '2026-03-01', '2026-03-03');
  assert.deepEqual(result.days, [
    {
      date: '2026-03-01',
      steps: { countSum: 1200 },
      distance: { millimetersSum: 900000, kilometers: 0.9 },
      activeZoneMinutes: { sumInFatBurnHeartZone: 10, sumInPeakHeartZone: 2 },
      activeMinutes: { byActivityLevel: [{ activityLevel: 'LIGHT', activeMinutesSum: 30 }] },
      totalCalories: { kcalSum: 2100.5 },
    },
    { date: '2026-03-02' },
    { date: '2026-03-03' },
  ]);
  assert.deepEqual(result.missing, [
    { date: '2026-03-02', series: 'steps', reason: 'steps rollup had no countSum' },
    { date: '2026-03-02', series: 'distance', reason: 'distance rollup had no millimetersSum' },
    { date: '2026-03-02', series: 'active-zone-minutes', reason: 'active zone minutes rollup had no documented sums' },
    { date: '2026-03-02', series: 'total-calories', reason: 'total calories rollup had no kcalSum' },
    { date: '2026-03-02', series: 'active-minutes', reason: 'no wearable samples' },
    { date: '2026-03-03', reason: 'no wearable samples' },
  ]);
  assert.equal(result.authStopped, undefined);
});

test('a failed series is listed once and other series still report per-day gaps', async () => {
  const api = fakeHealthApi(async (_method, path) => {
    if (path.includes('/total-calories/')) throw new HealthCallError('http', 'Health API request failed (HTTP 500).', 500);
    if (path.includes('/steps/')) return publishedDay;
    return { rollupDataPoints: [] };
  });
  const result = await readDailyActivity(api, '2026-02-26', '2026-02-27', ['steps', 'distance', 'total-calories']);
  assert.deepEqual(result.missing, [
    { series: 'total-calories', reason: 'Health API request failed (HTTP 500).' },
    { date: '2026-02-26', series: 'distance', reason: 'no wearable samples' },
    { date: '2026-02-27', reason: 'no wearable samples' },
  ]);
});

test('an unexpected error is thrown, not hidden as missing', async () => {
  const api = fakeHealthApi(async () => {
    throw new TypeError('bug');
  });
  await assert.rejects(() => readDailyActivity(api, '2026-02-26', '2026-02-26'), TypeError);
});
