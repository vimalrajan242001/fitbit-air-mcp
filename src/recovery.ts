import { MAX_RECONCILE_DAYS, WEARABLE_FAMILY } from './constants.js';
import { assertRange, civilDateOf, eachCivilDate } from './dates.js';
import { expectHealthError, type Missing } from './errors.js';
import { civilRangeFilter, reconcile, type HealthApi, type WearableResult } from './health.js';
import { isRecord, pickNumbers } from './parse.js';

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
  { type: 'daily-vo2-max', field: 'dailyVo2Max', ints: [], numbers: ['vo2Max'], labels: vo2MaxLabels },
] as const;

/** Documented `DailyVO2Max.CardioFitnessLevel` values, kept as the API's own label (UNSPECIFIED is dropped). */
const CARDIO_FITNESS_LEVELS = new Set(['POOR', 'FAIR', 'AVERAGE', 'GOOD', 'VERY_GOOD', 'EXCELLENT']);

/** `estimated` and `cardioFitnessLevel` from an untrusted DailyVO2Max, each only when valid. */
function vo2MaxLabels(value: Record<string, unknown>): { estimated?: boolean; cardioFitnessLevel?: string } {
  const labels: { estimated?: boolean; cardioFitnessLevel?: string } = {};
  if (typeof value.estimated === 'boolean') labels.estimated = value.estimated;
  if (typeof value.cardioFitnessLevel === 'string' && CARDIO_FITNESS_LEVELS.has(value.cardioFitnessLevel)) {
    labels.cardioFitnessLevel = value.cardioFitnessLevel;
  }
  return labels;
}

type RecoverySeries = (typeof RECOVERY_SERIES)[number];
type RecoveryField = RecoverySeries['field'];

export type RecoveryDay = { date: string } & Partial<Record<RecoveryField, Record<string, number | boolean | string>>>;

export type RecoveryResult = WearableResult & { days: RecoveryDay[] };

export async function readRecoveryDays(api: HealthApi, start: string, end: string): Promise<RecoveryResult> {
  assertRange(start, end, MAX_RECONCILE_DAYS);
  const range = { start, end };
  const days = eachCivilDate(start, end).map((date): RecoveryDay => ({ date }));
  const byDate = new Map(days.map((day) => [day.date, day]));
  const missing: Missing[] = [];

  const settled = await Promise.allSettled(
    RECOVERY_SERIES.map(({ type }) =>
      // The filter field is the data type name with underscores.
      reconcile(api, type, civilRangeFilter(`${type.replaceAll('-', '_')}.date`, range), 'paging stopped before the range was covered'),
    ),
  );
  settled.forEach((outcome, index) => {
    const series = RECOVERY_SERIES[index]!;
    if (outcome.status === 'rejected') {
      missing.push({ series: series.type, reason: expectHealthError(outcome.reason).message });
      return;
    }
    for (const point of outcome.value) {
      const value = isRecord(point) ? point[series.field] : undefined;
      if (!isRecord(value)) continue;
      const day = byDate.get(civilDateOf(value, undefined, undefined) ?? '');
      if (!day) continue;
      const kept: Record<string, number | boolean | string> = pickNumbers<string>(value, series) as Record<string, number>;
      if (Object.keys(kept).length === 0) continue;
      day[series.field] = 'labels' in series ? { ...kept, ...series.labels(value) } : kept;
    }
    missing.push(...seriesGaps(days, series));
  });

  return { range, dataSourceFamily: WEARABLE_FAMILY, days, missing };
}

/** A series with no samples in a multi-day range is one entry, not one per day. */
function seriesGaps(days: RecoveryDay[], series: RecoverySeries): Missing[] {
  const absent = days.filter((day) => !day[series.field]).map((day) => day.date);
  if (absent.length === days.length && days.length > 1) return [{ series: series.type, reason: 'no wearable samples' }];
  return absent.map((date) => ({ date, series: series.type, reason: 'no wearable samples' }));
}
