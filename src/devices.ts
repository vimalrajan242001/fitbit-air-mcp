import { HealthCallError, isRecord, type Missing } from './errors.js';
import type { HealthApi } from './health.js';

export type SyncDevice = {
  deviceVersion: string | null;
  batteryLevel: number | null;
  batteryStatus: string | null;
  lastSyncTime: string | null;
  features: string[];
};

export type SyncResult = {
  devices: SyncDevice[];
  missing: Missing[];
};

export async function readSyncStatus(api: HealthApi): Promise<SyncResult> {
  try {
    const devices = (await listPairedDevices(api)).map(toSyncDevice);
    return {
      devices,
      missing: devices.length === 0 ? [{ series: 'paired-devices', reason: 'no paired devices' }] : [],
    };
  } catch (error) {
    if (error instanceof HealthCallError) {
      return { devices: [], missing: [{ series: 'paired-devices', reason: error.message }] };
    }
    throw error;
  }
}

export async function listPairedDevices(api: HealthApi): Promise<unknown[]> {
  const devices: unknown[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const params = new URLSearchParams({ pageSize: '100' });
    if (pageToken) params.set('pageToken', pageToken);
    const payload = await api.get(`/users/me/pairedDevices?${params.toString()}`);
    if (!isRecord(payload)) return devices;
    if (Array.isArray(payload.pairedDevices)) devices.push(...payload.pairedDevices);
    pageToken = typeof payload.nextPageToken === 'string' && payload.nextPageToken.length > 0 ? payload.nextPageToken : undefined;
    if (!pageToken) return devices;
  }
  throw new HealthCallError('http', 'paging stopped before paired devices were covered');
}

/** Copies the documented sync fields and drops macAddress. */
export function toSyncDevice(device: unknown): SyncDevice {
  if (!isRecord(device)) {
    return { deviceVersion: null, batteryLevel: null, batteryStatus: null, lastSyncTime: null, features: [] };
  }
  return {
    deviceVersion: typeof device.deviceVersion === 'string' ? device.deviceVersion : null,
    batteryLevel: typeof device.batteryLevel === 'number' ? device.batteryLevel : null,
    batteryStatus: typeof device.batteryStatus === 'string' ? device.batteryStatus : null,
    lastSyncTime: typeof device.lastSyncTime === 'string' ? device.lastSyncTime : null,
    features: Array.isArray(device.features) ? device.features.filter((feature): feature is string => typeof feature === 'string') : [],
  };
}

export function latestSync(devices: SyncDevice[]): SyncDevice | undefined {
  return devices
    .filter((device) => device.lastSyncTime && !Number.isNaN(Date.parse(device.lastSyncTime)))
    .sort((left, right) => Date.parse(left.lastSyncTime!) - Date.parse(right.lastSyncTime!))
    .at(-1);
}
