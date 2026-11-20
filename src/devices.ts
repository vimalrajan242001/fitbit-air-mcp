import { MAX_PAIRED_DEVICE_PAGES, PAIRED_DEVICE_PAGE_SIZE } from './constants.js';
import { expectHealthError, type Missing } from './errors.js';
import { paginate, type HealthApi } from './health.js';
import { isRecord, readString } from './parse.js';

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
    return { devices: [], missing: [{ series: 'paired-devices', reason: expectHealthError(error).message }] };
  }
}

export function listPairedDevices(api: HealthApi): Promise<unknown[]> {
  return paginate(
    (pageToken) => {
      const params = new URLSearchParams({ pageSize: String(PAIRED_DEVICE_PAGE_SIZE) });
      if (pageToken) params.set('pageToken', pageToken);
      return api.get(`/users/me/pairedDevices?${params.toString()}`);
    },
    'pairedDevices',
    MAX_PAIRED_DEVICE_PAGES,
    'paging stopped before paired devices were covered',
  );
}

/** Copies the documented sync fields from an allowlist, so macAddress never reaches a result. */
export function toSyncDevice(device: unknown): SyncDevice {
  const fields = isRecord(device) ? device : {};
  return {
    deviceVersion: readString(fields.deviceVersion) ?? null,
    batteryLevel: typeof fields.batteryLevel === 'number' ? fields.batteryLevel : null,
    batteryStatus: readString(fields.batteryStatus) ?? null,
    lastSyncTime: readString(fields.lastSyncTime) ?? null,
    features: Array.isArray(fields.features) ? fields.features.filter((feature): feature is string => typeof feature === 'string') : [],
  };
}

/** The device that synced most recently, ignoring unreadable sync times. */
export function latestSync(devices: SyncDevice[]): SyncDevice | undefined {
  return devices
    .filter((device) => device.lastSyncTime && !Number.isNaN(Date.parse(device.lastSyncTime)))
    .sort((left, right) => Date.parse(left.lastSyncTime!) - Date.parse(right.lastSyncTime!))
    .at(-1);
}
