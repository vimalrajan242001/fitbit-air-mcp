import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addCivilDays } from '../src/dates.js';
import { HealthCallError } from '../src/errors.js';
import { ageAtValue, readFitnessAge } from '../src/fitnessAge.js';
import { fakeHealthApi, loadFixture } from './fixture.js';

// Built from the documented DailyVO2Max JSON representation; the official pages publish no example response.
const documented = (loadFixture('daily-vo2-max-documented.json').dataPoints as Array<{ dailyVo2Max: Record<string, unknown> }>)[0]!.dailyVo2Max;

const civil = (iso: string) => {
  const [year, month, day] = iso.split('-').map(Number);
  return { year, month, day };
};

/** Answers each recovery series with one point per listed date; a series mapped to an Error throws it. */
function recoveryApi(series: Record<string, Array<[string, Record<string, unknown>]> | Error>) {
  return fakeHealthApi(async (_method, path) => {
    if (path === '/users/me/settings') return { timeZone: 'Etc/UTC' };
    const type = new URL(path, 'https://health.googleapis.com').pathname.split('/')[4]!;
    const points = series[type] ?? [];
    if (points instanceof Error) throw points;
    const field = type.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase());
    return { dataPoints: points.map(([date, value]) => ({ [field]: { ...value, date: civil(date) } })) };
  });
}

const days = (start: string, count: number) => Array.from({ length: count }, (_, i) => addCivilDays(start, i));

test('ageAtValue reads known points, interpolates, extends the end slopes, and clamps', () => {
  const male = [[25, 48.0], [35, 42.4], [45, 37.8], [55, 32.6], [65, 28.2], [75, 24.4]] as const;
  assert.equal(ageAtValue(male, 42.4), 35);
  assert.equal(ageAtValue(male, 24.4), 75);
  const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
  near(ageAtValue(male, 40.1), 40); // halfway between 35 and 45
  near(ageAtValue(male, 50.8), 20); // 2.8 above the first point: 5 years earlier on the first slope
  near(ageAtValue(male, 44.6), 25 + (3.4 / 5.6) * 10);
  assert.equal(ageAtValue(male, 60), 20);
  near(ageAtValue(male, 22.5), 80); // last slope is 0.38 per year
  assert.equal(ageAtValue(male, 5), 90);
});

test('fitness_age reports each part with its inputs and keeps the documented VO2 max labels', async () => {
  const vo2 = days('2026-03-01', 3).map((date, i): [string, Record<string, unknown>] => [date, { ...documented, estimated: i === 0, vo2Max: 42.4 }]);
  const hrv = days('2026-03-01', 7).map((date): [string, Record<string, unknown>] => [date, { averageHeartRateVariabilityMilliseconds: 46, deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds: 90 }]);
  const api = recoveryApi({ 'daily-vo2-max': vo2, 'daily-heart-rate-variability': hrv });
  const result = await readFitnessAge(api, new Date('2026-03-10T12:00:00Z'), { sex: 'male', birthYear: 1990 });
  assert.deepEqual(result.window, { start: '2026-02-09', end: '2026-03-10' });
  assert.equal(result.chronologicalAge, 36);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.parts[0], {
    key: 'vo2max',
    inputMedian: 42.4,
    unit: 'ml/kg/min',
    days: 3,
    estimatedDays: 1,
    latestCardioFitnessLevel: 'GOOD',
    equivalentAge: 35,
    reference: 'FRIEND registry treadmill 50th percentile (Kaminsky 2015, Table 3)',
  });
  assert.equal(result.parts[1]!.key, 'hrv');
  assert.equal(result.parts[1]!.inputMedian, 46); // the average RMSSD, not the deep-sleep one
  assert.equal(result.parts[1]!.equivalentAge, 35);
  assert.equal(result.parts[1]!.confidence, 'low');
  assert.equal(JSON.stringify(result).includes('Covariance'), false);
});

test('unspecified sex averages the two curves', async () => {
  const vo2 = days('2026-03-01', 3).map((date): [string, Record<string, unknown>] => [date, { vo2Max: (48.0 + 37.6) / 2 }]);
  const result = await readFitnessAge(recoveryApi({ 'daily-vo2-max': vo2 }), new Date(), { start: '2026-03-01', end: '2026-03-07' });
  assert.equal(result.sex, 'unspecified');
  assert.equal(result.parts[0]!.equivalentAge, 25);
  assert.equal('chronologicalAge' in result, false);
});

test('too few days and a 403 on VO2 max become missing entries while HRV still returns', async () => {
  const short = await readFitnessAge(
    recoveryApi({
      'daily-vo2-max': days('2026-03-01', 2).map((date): [string, Record<string, unknown>] => [date, { vo2Max: 40 }]),
      'daily-heart-rate-variability': days('2026-03-01', 4).map((date): [string, Record<string, unknown>] => [date, { averageHeartRateVariabilityMilliseconds: 40 }]),
    }),
    new Date(),
    { start: '2026-03-01', end: '2026-03-10', sex: 'female' },
  );
  assert.deepEqual(short.parts, []);
  assert.deepEqual(short.missing, [
    { series: 'daily-vo2-max', reason: '2 of 3 days with data' },
    { series: 'daily-heart-rate-variability', reason: '4 of 7 nights with data' },
  ]);

  const denied = await readFitnessAge(
    recoveryApi({
      'daily-vo2-max': new HealthCallError('missing_scope', 'missing scope', 403),
      'daily-heart-rate-variability': days('2026-03-01', 7).map((date): [string, Record<string, unknown>] => [date, { averageHeartRateVariabilityMilliseconds: 29 }]),
    }),
    new Date(),
    { start: '2026-03-01', end: '2026-03-10', age: 50 },
  );
  assert.deepEqual(denied.missing, [{ series: 'daily-vo2-max', reason: 'missing scope' }]);
  assert.deepEqual(denied.parts.map((part) => [part.key, part.equivalentAge]), [['hrv', 55]]);
});
