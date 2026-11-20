import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readSyncStatus } from '../src/devices.js';
import { redact } from '../src/redact.js';
import { fakeHealthApi, loadFixture } from './fixture.js';

const published = loadFixture('paired-device.json');

test('strips macAddress from the published paired device', async () => {
  const api = fakeHealthApi(async (_method, path) => {
    const url = new URL(path, 'https://health.googleapis.com');
    if (url.searchParams.get('pageToken') === 'device-2') return { pairedDevices: [] };
    return { ...published, nextPageToken: 'device-2' };
  });
  const result = readSyncStatus(api).then((status) => redact(status));
  const body = JSON.stringify(await result);
  assert.equal(body.includes('macAddress'), false);
  assert.equal(body.includes('00:11:22:33:44:55'), false);
  const device = (await readSyncStatus(api)).devices[0];
  assert.equal(device?.deviceVersion, 'Charge 6');
  assert.equal(device?.batteryLevel, 88);
  assert.equal(device?.batteryStatus, 'High');
  assert.equal(device?.lastSyncTime, '2026-03-04T07:05:00Z');
  assert.deepEqual(device?.features, ['STEPS', 'HEART_RATE']);
  assert.equal(api.calls.length, 4);
});
