import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WEARABLE_FAMILY } from '../src/constants.js';
import { HealthCallError } from '../src/errors.js';
import { readExerciseSessions } from '../src/exercise.js';
import { readRecoveryDays } from '../src/recovery.js';
import { fakeHealthApi } from './fixture.js';

const date = { year: 2026, month: 3, day: 4 };

test('recovery_day reads the three daily types and reports missing days per series', async () => {
  const api = fakeHealthApi(async (_method, path) => {
    const url = new URL(path, 'https://health.googleapis.com');
    assert.equal(url.searchParams.get('dataSourceFamily'), WEARABLE_FAMILY);
    if (url.pathname.includes('daily-resting-heart-rate')) {
      assert.equal(url.searchParams.get('filter'), 'daily_resting_heart_rate.date >= "2026-03-04" AND daily_resting_heart_rate.date < "2026-03-06"');
      return { dataPoints: [{ dailyRestingHeartRate: { date, beatsPerMinute: '58', dailyRestingHeartRateMetadata: {} } }] };
    }
    if (url.pathname.includes('daily-heart-rate-variability')) {
      return { dataPoints: [{ dailyHeartRateVariability: { date, averageHeartRateVariabilityMilliseconds: 42.5, nonRemHeartRateBeatsPerMinute: '55' } }] };
    }
    if (url.pathname.includes('daily-oxygen-saturation')) return { dataPoints: [] };
    throw new HealthCallError('missing_scope', 'missing scope', 403);
  });
  const result = await readRecoveryDays(api, '2026-03-04', '2026-03-05');
  assert.deepEqual(result.days[0], {
    date: '2026-03-04',
    dailyRestingHeartRate: { beatsPerMinute: 58 },
    dailyHeartRateVariability: { nonRemHeartRateBeatsPerMinute: 55, averageHeartRateVariabilityMilliseconds: 42.5 },
  });
  assert.deepEqual(result.days[1], { date: '2026-03-05' });
  assert.deepEqual(result.missing, [
    { date: '2026-03-05', series: 'daily-resting-heart-rate', reason: 'no wearable samples' },
    { date: '2026-03-05', series: 'daily-heart-rate-variability', reason: 'no wearable samples' },
    { series: 'daily-oxygen-saturation', reason: 'no wearable samples' },
  ]);
  const denied = fakeHealthApi(async () => {
    throw new HealthCallError('missing_scope', 'missing scope', 403);
  });
  const deniedResult = await readRecoveryDays(denied, '2026-03-04', '2026-03-04');
  assert.equal(deniedResult.missing.length, 3);
  assert.ok(deniedResult.missing.every((entry) => entry.reason === 'missing scope' && !entry.date));
});

test('exercise_sessions keeps an allowlist of documented fields', async () => {
  const api = fakeHealthApi(async (_method, path) => {
    const url = new URL(path, 'https://health.googleapis.com');
    assert.match(url.pathname, /\/dataTypes\/exercise\/dataPoints:reconcile$/);
    assert.equal(url.searchParams.get('filter'), 'exercise.interval.civil_start_time >= "2026-03-04" AND exercise.interval.civil_start_time < "2026-03-05"');
    return {
      dataPoints: [
        {
          exercise: {
            interval: { startTime: '2026-03-04T07:00:00Z', endTime: '2026-03-04T07:45:00Z', civilStartTime: { date } },
            exerciseType: 'RUNNING',
            displayName: 'Run',
            activeDuration: '2400s',
            notes: 'private',
            exerciseMetadata: { hasGps: true },
            metricsSummary: { steps: '6000', caloriesKcal: 410.5, distanceMillimeters: 7200000, averageHeartRateBeatsPerMinute: '151' },
          },
        },
        { exercise: { exerciseType: 'WALKING' } },
      ],
    };
  });
  const result = await readExerciseSessions(api, '2026-03-04', '2026-03-04');
  assert.deepEqual(result.sessions, [
    {
      date: '2026-03-04',
      exerciseType: 'RUNNING',
      displayName: 'Run',
      interval: { startTime: '2026-03-04T07:00:00Z', endTime: '2026-03-04T07:45:00Z' },
      durationMinutes: 45,
      activeMinutes: 40,
      metrics: { steps: 6000, averageHeartRateBeatsPerMinute: 151, caloriesKcal: 410.5, distanceMillimeters: 7200000 },
    },
  ]);
  assert.deepEqual(result.missing, [{ series: 'exercise', reason: 'exercise session interval could not be read' }]);
});
