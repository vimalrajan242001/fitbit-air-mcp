import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WEARABLE_FAMILY } from '../src/constants.js';
import { readSleepNights, summarizeSleepSession } from '../src/sleep.js';
import { fakeHealthApi, loadFixture } from './fixture.js';

const published = loadFixture('sleep-reconcile.json');

test('summarizes the published sleep reconcile example', async () => {
  const api = fakeHealthApi(async (_method, path) => {
    const url = new URL(path, 'https://health.googleapis.com');
    assert.equal(url.searchParams.get('dataSourceFamily'), WEARABLE_FAMILY);
    assert.equal(url.searchParams.get('pageSize'), '25');
    assert.match(url.searchParams.get('filter') ?? '', /sleep\.interval\.civil_end_time >= "2026-03-04"/);
    assert.match(url.searchParams.get('filter') ?? '', /sleep\.interval\.civil_end_time < "2026-03-05"/);
    if (url.searchParams.get('pageToken')) return { dataPoints: [], nextPageToken: '' };
    return { ...published, nextPageToken: 's2' };
  });
  const result = await readSleepNights(api, '2026-03-04', '2026-03-04', true);
  const night = result.nights[0];
  assert.ok(night);
  assert.equal(night.date, '2026-03-04');
  assert.equal(night.sourceDevice, 'Charge 6');
  assert.equal(night.inBedMinutes, 464);
  assert.equal(night.minutesAsleep, 407);
  assert.equal(night.stageMinutes.AWAKE, 56);
  assert.equal(night.stageMinutes.LIGHT, 198);
  assert.equal(night.stageMinutes.DEEP, 114);
  assert.equal(night.stageMinutes.REM, 94);
  assert.equal(night.shortAwakeningCount, 0);
  assert.equal(night.sleepEfficiencyPercent, 88);
  assert.equal(night.stages?.length, 2);
  assert.equal(JSON.stringify(night.stages).includes('createTime'), false);
  assert.equal(api.calls.length, 2);
  assert.equal(JSON.stringify(result).includes('Sleep Score'), false);
});

test('in-bed minutes come from the interval, not minutesInSleepPeriod', () => {
  const session = structuredClone(published.dataPoints);
  const point = (session as Array<Record<string, unknown>>)[0]!;
  const sleep = point.sleep as { interval: { startTime: string; endTime: string }; summary: { minutesInSleepPeriod: string } };
  sleep.interval.startTime = '2026-03-03T22:00:00Z';
  sleep.interval.endTime = '2026-03-04T00:00:00Z';
  sleep.summary.minutesInSleepPeriod = '999';
  const night = summarizeSleepSession(point, { includeStages: false });
  assert.equal(night?.inBedMinutes, 120);
});

test('counts documented shortAwakenings and hides stages for a multi-night detail request', async () => {
  const withAwakening = structuredClone(published);
  const point = (withAwakening.dataPoints as Array<{ sleep: { shortAwakenings?: unknown[] } }>)[0]!;
  point.sleep.shortAwakenings = [
    { startTime: '2026-04-20T23:10:00Z', endTime: '2026-04-20T23:11:30Z', type: 'AWAKE' },
  ];
  const api = fakeHealthApi(async () => withAwakening);
  const oneNight = await readSleepNights(api, '2026-03-04', '2026-03-04', false);
  assert.equal(oneNight.nights[0]?.shortAwakeningCount, 1);
  assert.equal(oneNight.nights[0]?.stages, undefined);
  const twoNights = await readSleepNights(api, '2026-03-03', '2026-03-04', true);
  assert.equal(twoNights.nights[0]?.stages, undefined);
  assert.equal(twoNights.missing.some((entry) => entry.reason.includes('single night')), true);
});
