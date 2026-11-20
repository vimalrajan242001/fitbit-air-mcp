import { readDailyActivity, type ActivityDay } from './activity.js';
import { civilToday } from './dates.js';
import { latestSync, readSyncStatus } from './devices.js';
import { HealthCallError, errorMessage, type Missing } from './errors.js';
import type { HealthApi } from './health.js';
import { isRecord } from './parse.js';
import { readSleepNights, type SleepNight } from './sleep.js';

export type TodaySnapshot = {
  timeZone?: string;
  date?: string;
  steps?: ActivityDay['steps'];
  activeZoneMinutes?: ActivityDay['activeZoneMinutes'];
  lastNight?: SleepNight;
  lastSyncTime?: string | null;
  deviceVersion?: string | null;
  missing: Missing[];
};

/** Today's civil date in the account time zone. Without `date`, `missing` says why. */
export async function readAccountDate(api: HealthApi, now: Date): Promise<{ timeZone?: string; date?: string; missing: Missing[] }> {
  let settings: unknown;
  try {
    settings = await api.get('/users/me/settings');
  } catch (error) {
    const reason = error instanceof HealthCallError ? error.message : 'settings request failed';
    return { missing: [{ series: 'settings', reason }] };
  }
  const timeZone = isRecord(settings) && typeof settings.timeZone === 'string' ? settings.timeZone : '';
  if (!timeZone) return { missing: [{ series: 'settings', reason: 'account time zone is missing' }] };
  let date: string;
  try {
    date = civilToday(timeZone, now);
  } catch (error) {
    return { timeZone, missing: [{ series: 'settings', reason: errorMessage(error, 'account time zone could not be applied') }] };
  }
  return { timeZone, date, missing: [] };
}

/** Today's headline numbers in the account time zone. Each part that cannot be read becomes a missing entry. */
export async function readToday(api: HealthApi, now: Date): Promise<TodaySnapshot> {
  const account = await readAccountDate(api, now);
  if (!account.date) return account;
  const { timeZone, date } = account;

  const activity = await readDailyActivity(api, date, date, ['steps', 'active-zone-minutes']);
  if (activity.authStopped) return { timeZone, date, missing: activity.missing };
  const [sleep, sync] = await Promise.all([readSleepNights(api, date, date, false), readSyncStatus(api)]);
  const day = activity.days.find((entry) => entry.date === date);
  const lastNight = sleep.nights.at(-1);
  const syncDevice = latestSync(sync.devices);
  const snapshot: TodaySnapshot = {
    timeZone,
    date,
    missing: [...activity.missing, ...sleep.missing, ...sync.missing],
  };
  if (day?.steps) snapshot.steps = day.steps;
  if (day?.activeZoneMinutes) snapshot.activeZoneMinutes = day.activeZoneMinutes;
  if (lastNight) snapshot.lastNight = lastNight;
  if (syncDevice) {
    snapshot.lastSyncTime = syncDevice.lastSyncTime;
    snapshot.deviceVersion = syncDevice.deviceVersion;
  }
  return snapshot;
}
