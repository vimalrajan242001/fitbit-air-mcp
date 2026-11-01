import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addCivilDays, eachCivilDate, formatCivilDate, type CivilParts } from '../src/dates.js';
import { percentile, readActivityWeeks, readSleepWeeks } from '../src/trends.js';
import { fakeHealthApi } from './fixture.js';

type RangeBody = { range: { start: { date: CivilParts }; end: { date: CivilParts } } };

test('percentile interpolates between ranks', () => {
  assert.equal(percentile([4, 1, 3, 2], 0.5), 2.5);
  assert.equal(percentile([10], 0.25), 10);
});

test('weekly activity reads 14 days at a time and averages only days with data', async () => {
  const api = fakeHealthApi(async (_method, path, body) => {
    if (!path.includes('/steps/')) return { rollupDataPoints: [] };
    const { start, end } = (body as RangeBody).range;
    const dates = eachCivilDate(formatCivilDate(start.date), addCivilDays(formatCivilDate(end.date), -1));
    // 2026-07-03 has no samples; every other day has 1000 steps times its day of month.
    return {
      rollupDataPoints: dates
        .filter((date) => date !== '2026-07-03')
        .map((date) => {
          const [year, month, day] = date.split('-').map(Number);
          return { civilStartTime: { date: { year, month, day } }, steps: { countSum: String(day! * 1000) } };
        }),
    };
  });
  const result = await readActivityWeeks(api, '2026-07-01', '2026-07-17');
  assert.equal(api.calls.length, 10, 'two 14-day chunks of five series');
  assert.deepEqual(
    result.weeks.map((week) => [week.start, week.end]),
    [
      ['2026-07-01', '2026-07-07'],
      ['2026-07-08', '2026-07-14'],
      ['2026-07-15', '2026-07-17'],
    ],
  );
  assert.equal(result.weeks[0]!.daysWithData.steps, 6);
  assert.equal(result.weeks[0]!.dailyAverage.steps, Math.round(((1 + 2 + 4 + 5 + 6 + 7) * 1000) / 6));
  assert.equal(result.weeks[1]!.dailyAverage.steps, 11000);
  assert.equal(result.weeks[2]!.dailyAverage.steps, 16000);
  assert.equal(result.weeks[0]!.dailyAverage.distanceMillimeters, undefined);
  assert.equal(result.baseline.start, '2026-07-01');
  assert.deepEqual(result.baseline.steps, { median: 9500, typicalRange: [5750, 13250], daysWithData: 16 });
  assert.equal(result.missing.length, 0);
  assert.equal(JSON.stringify(result).includes('"days"'), false);
});

test('weekly activity refuses more than 91 days before calling the API', async () => {
  const api = fakeHealthApi(() => ({ rollupDataPoints: [] }));
  await assert.rejects(() => readActivityWeeks(api, '2026-01-01', '2026-04-02'), /91 days/);
  assert.equal(api.calls.length, 0);
});

test('weekly sleep keeps the longest session per date as main sleep and counts naps apart', async () => {
  const session = (startTime: string, endTime: string, minutesAsleep: number) => ({
    sleep: {
      interval: { startTime, endTime, startUtcOffset: '3600s', endUtcOffset: '3600s' },
      summary: { minutesAsleep: String(minutesAsleep) },
    },
  });
  const api = fakeHealthApi(async () => ({
    dataPoints: [
      session('2026-03-01T22:00:00Z', '2026-03-02T06:00:00Z', 420), // local 23:00
      session('2026-03-02T13:00:00Z', '2026-03-02T13:40:00Z', 30), // nap on the same date
      session('2026-03-02T23:30:00Z', '2026-03-03T06:30:00Z', 380), // local 00:30
    ],
  }));
  const result = await readSleepWeeks(api, '2026-03-02', '2026-03-03');
  const week = result.weeks[0]!;
  assert.equal(week.nightsWithData, 2);
  assert.deepEqual(week.naps, { count: 1, inBedMinutes: 40 });
  assert.equal(week.mainSleep?.averageMinutesAsleep, 400);
  assert.equal(week.mainSleep?.medianBedtime, '23:45');
  assert.equal(week.mainSleep?.bedtimeSpreadMinutes, 45);
  assert.equal(result.baseline.minutesAsleep.median, 400);
  assert.equal(result.missing.length, 0);
  assert.equal(JSON.stringify(result).includes('Sleep Score'), false);
});
