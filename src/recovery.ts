import { MAX_SLEEP_DAYS, MAX_SLEEP_PAGES, WEARABLE_FAMILY } from './constants.js';
import { addCivilDays, assertRange, civilDateOf, eachCivilDate, readFinite, readInt } from './dates.js';
import { HealthCallError, isRecord, type Missing } from './errors.js';
import { reconcile, type HealthApi } from './health.js';

/** Data type, its DataPoint union field, and the documented fields kept from it. */
const RECOVERY_SERIES = [
  { type: 'daily-resting-heart-rate', field: 'dailyRestingHeartRate', ints: ['beatsPerMinute'], numbers: [] },
  {
    type: 'daily-heart-rate-variability',
    field: 'dailyHeartRateVariability',
    ints: ['nonRemHeartRateBeatsPerMinute'],
    numbers: ['averageHeartRateVariabilityMilliseconds', 'deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds', 'entropy'],
  },
  {
    type: 'daily-oxygen-saturation',
    field: 'dailyOxygenSaturation',
    ints: [],
    numbers: ['averagePercentage', 'lowerBoundPercentage', 'upperBoundPercentage', 'standardDeviationPercentage'],
  },
] as const;

type RecoveryField = (typeof RECOVERY_SERIES)[number]['field'];

export type RecoveryDay = { date: string } & Partial<Record<RecoveryField, Record<string, number>>>;

export type RecoveryResult = {
  range: { start: string; end: string };
  dataSourceFamily: typeof WEARABLE_FAMILY;
  days: RecoveryDay[];
  missing: Missing[];
};

export async function readRecoveryDays(api: HealthApi, start: string, end: string): Promise<RecoveryResult> {
  assertRange(start, end, MAX_SLEEP_DAYS);
  const dates = eachCivilDate(start, end);
  const days = new Map<string, RecoveryDay>(dates.map((date) => [date, { date }]));
  const missing: Missing[] = [];

  const results = await Promise.allSettled(
    RECOVERY_SERIES.map(({ type }) => {
      const field = type.replaceAll('-', '_');
      const filter = `${field}.date >= "${start}" AND ${field}.date < "${addCivilDays(end, 1)}"`;
      return reconcile(api, type, filter, MAX_SLEEP_PAGES, 'paging stopped before the range was covered');
    }),
  );
  results.forEach((result, index) => {
    const series = RECOVERY_SERIES[index]!;
    if (result.status === 'rejected') {
      if (!(result.reason instanceof HealthCallError)) throw result.reason;
      missing.push({ series: series.type, reason: result.reason.message });
      return;
    }
    for (const point of result.value) {
      const value = isRecord(point) ? point[series.field] : undefined;
      if (!isRecord(value)) continue;
      const day = days.get(civilDateOf(value, undefined, undefined) ?? '');
      if (!day) continue;
      const kept: Record<string, number> = {};
      for (const key of series.ints) {
        const read = readInt(value[key]);
        if (read !== undefined) kept[key] = read;
      }
      for (const key of series.numbers) {
        const read = readFinite(value[key]);
        if (read !== undefined) kept[key] = read;
      }
      if (Object.keys(kept).length > 0) day[series.field] = kept;
    }
    const absent = dates.filter((date) => !days.get(date)![series.field]);
    // A series with no samples in the whole range is one entry, not one per day.
    if (absent.length === dates.length && dates.length > 1) missing.push({ series: series.type, reason: 'no wearable samples' });
    else for (const date of absent) missing.push({ date, series: series.type, reason: 'no wearable samples' });
  });

  return { range: { start, end }, dataSourceFamily: WEARABLE_FAMILY, days: dates.map((date) => days.get(date)!), missing };
}
