import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readToday } from '../src/today.js';
import { fakeHealthApi, loadFixture } from './fixture.js';

const steps = loadFixture('steps-daily-rollup.json');
const sleep = loadFixture('sleep-reconcile.json');
const device = loadFixture('paired-device.json');

test('today uses the account time zone and the published examples', async () => {
  const point = (steps.rollupDataPoints as Array<Record<string, unknown>>)[0]!;
  const api = fakeHealthApi(async (method, path) => {
    if (path === '/users/me/settings') return { name: 'users/me/settings', timeZone: 'Etc/UTC' };
    if (path.includes('/steps/')) {
      return {
        rollupDataPoints: [
          {
            ...point,
            civilStartTime: { date: { year: 2026, month: 3, day: 4 }, time: {} },
          },
        ],
      };
    }
    if (path.includes('/active-zone-minutes/')) return { rollupDataPoints: [] };
    if (path.includes('/sleep/')) return sleep;
    if (path.includes('/pairedDevices')) return device;
    throw new Error(`unexpected ${method} ${path}`);
  });
  const snapshot = await readToday(api, new Date('2026-03-04T15:00:00.000Z'));
  assert.equal(snapshot.timeZone, 'Etc/UTC');
  assert.equal(snapshot.date, '2026-03-04');
  assert.equal(snapshot.steps?.countSum, 3822);
  assert.equal(snapshot.lastNight?.minutesAsleep, 407);
  assert.equal(snapshot.lastNight?.inBedMinutes, 464);
  assert.equal(snapshot.lastSyncTime, '2026-03-04T07:05:00Z');
  assert.equal(snapshot.deviceVersion, 'Charge 6');
  const body = JSON.stringify(snapshot);
  assert.equal(body.includes('macAddress'), false);
  assert.equal(body.includes('00:11:22:33:44:55'), false);
  assert.equal(body.includes('restingHeartRate'), false);
  assert.equal(body.includes('accessToken'), false);
});
