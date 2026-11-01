import { MAX_ACTIVITY_DAYS, MAX_ACTIVITY_PAGES, WEARABLE_FAMILY } from './constants.js';
import { assertRange, civilDateOf, closedOpenRange, eachCivilDate, type DateRange } from './dates.js';
import { expectHealthError, type HealthCallError, type Missing } from './errors.js';
import { paginate, type HealthApi, type WearableResult } from './health.js';
import { isRecord, readFinite, readInt } from './parse.js';

export type ActivityDay = {
  date: string;
  steps?: { countSum: number };
  /** kilometers is millimetersSum / 1e6, rounded to 0.01. */
  distance?: { millimetersSum: number; kilometers: number };
  activeZoneMinutes?: {
    sumInFatBurnHeartZone?: number;
    sumInCardioHeartZone?: number;
    sumInPeakHeartZone?: number;
  };
  activeMinutes?: { byActivityLevel: Array<{ activityLevel: string; activeMinutesSum: number }> };
  totalCalories?: { kcalSum: number };
};

export type ActivityResult = WearableResult & {
  days: ActivityDay[];
  /** Set when the account needs login or linking, so later calls would fail the same way. */
  authStopped?: true;
};

type ActivityField = Exclude<keyof ActivityDay, 'date'>;

type SeriesSpec<F extends ActivityField> = {
  /** The key on both the rollup data point and ActivityDay. */
  field: F;
  /** Copies the documented fields, or undefined when none can be read. */
  parse: (rollup: Record<string, unknown>) => ActivityDay[F] | undefined;
  /** Reported when a rollup is present but unreadable. Without it the day is just reported as having no samples. */
  unreadable?: string;
};

/**
 * One entry per documented dailyRollUp data type. To add a series, add its type name and spec here
 * and its field to ActivityDay; reading, paging, and gap reporting follow from the table.
 */
const SERIES = {
  steps: {
    field: 'steps',
    parse: (rollup) => optional(readInt(rollup.countSum), (countSum) => ({ countSum })),
    unreadable: 'steps rollup had no countSum',
  } satisfies SeriesSpec<'steps'>,
  distance: {
    field: 'distance',
    parse: (rollup) => optional(readInt(rollup.millimetersSum), (millimetersSum) => ({
      millimetersSum,
      kilometers: Math.round(millimetersSum / 10_000) / 100,
    })),
    unreadable: 'distance rollup had no millimetersSum',
  } satisfies SeriesSpec<'distance'>,
  'active-zone-minutes': {
    field: 'activeZoneMinutes',
    parse: (rollup) => {
      const sums = Object.fromEntries(
        (['sumInFatBurnHeartZone', 'sumInCardioHeartZone', 'sumInPeakHeartZone'] as const)
          .map((key) => [key, readInt(rollup[key])] as const)
          .filter((entry) => entry[1] !== undefined),
      );
      return Object.keys(sums).length > 0 ? sums : undefined;
    },
    unreadable: 'active zone minutes rollup had no documented sums',
  } satisfies SeriesSpec<'activeZoneMinutes'>,
  'active-minutes': {
    field: 'activeMinutes',
    parse: (rollup) => {
      const levels = rollup.activeMinutesRollupByActivityLevel;
      if (!Array.isArray(levels)) return undefined;
      const byActivityLevel = levels.flatMap((entry) => {
        if (!isRecord(entry) || typeof entry.activityLevel !== 'string') return [];
        const activeMinutesSum = readInt(entry.activeMinutesSum);
        return activeMinutesSum === undefined ? [] : [{ activityLevel: entry.activityLevel, activeMinutesSum }];
      });
      return byActivityLevel.length > 0 ? { byActivityLevel } : undefined;
    },
  } satisfies SeriesSpec<'activeMinutes'>,
  'total-calories': {
    field: 'totalCalories',
    parse: (rollup) => optional(readFinite(rollup.kcalSum), (kcalSum) => ({ kcalSum })),
    unreadable: 'total calories rollup had no kcalSum',
  } satisfies SeriesSpec<'totalCalories'>,
} as const;

export type ActivitySeries = keyof typeof SERIES;

export const ACTIVITY_SERIES = Object.keys(SERIES) as ActivitySeries[];

const NO_SAMPLES = 'no wearable samples';

export async function readDailyActivity(
  api: HealthApi,
  start: string,
  end: string,
  series: readonly ActivitySeries[] = ACTIVITY_SERIES,
  maxDays = MAX_ACTIVITY_DAYS,
): Promise<ActivityResult> {
  assertRange(start, end, maxDays);
  const range = { start, end };
  const days = eachCivilDate(start, end).map((date): ActivityDay => ({ date }));
  const result: ActivityResult = { range, dataSourceFamily: WEARABLE_FAMILY, days, missing: [] };

  const settled = await Promise.allSettled(series.map((name) => rollUp(api, name, range)));
  const failures = settled.map((outcome) => (outcome.status === 'rejected' ? expectHealthError(outcome.reason) : undefined));

  const authFailure = failures.find((failure) => failure?.stopsAllReads);
  if (authFailure) {
    result.missing = series.map((name) => ({ series: name, reason: authFailure.message }));
    result.authStopped = true;
    return result;
  }

  const byDate = new Map(days.map((day) => [day.date, day]));
  const read: ActivitySeries[] = [];
  settled.forEach((outcome, index) => {
    const name = series[index]!;
    if (outcome.status === 'rejected') {
      result.missing.push({ series: name, reason: (failures[index] as HealthCallError).message });
      return;
    }
    read.push(name);
    for (const point of outcome.value) {
      const day = byDate.get(civilDateOf(point.civilStartTime, undefined, undefined) ?? '');
      if (day) applyRollup(day, name, point, result.missing);
    }
  });
  result.missing.push(...dailyGaps(days, read, result.missing));
  return result;
}

function rollUp(api: HealthApi, series: ActivitySeries, range: DateRange): Promise<Array<Record<string, unknown>>> {
  const body = { range: closedOpenRange(range.start, range.end), windowSizeDays: 1, dataSourceFamily: WEARABLE_FAMILY };
  return paginate(
    (pageToken) => api.post(`/users/me/dataTypes/${series}/dataPoints:dailyRollUp`, pageToken ? { ...body, pageToken } : body),
    'rollupDataPoints',
    MAX_ACTIVITY_PAGES,
    'paging stopped before the range was covered',
  ).then((points) => points.filter(isRecord));
}

function applyRollup(day: ActivityDay, series: ActivitySeries, point: Record<string, unknown>, missing: Missing[]): void {
  const spec: SeriesSpec<ActivityField> = SERIES[series];
  const rollup = point[spec.field];
  if (!rollup) return;
  const value = isRecord(rollup) ? spec.parse(rollup) : undefined;
  if (value !== undefined) {
    (day as Record<ActivityField, unknown>)[spec.field] = value;
  } else if (spec.unreadable) {
    missing.push({ date: day.date, series, reason: spec.unreadable });
  }
}

/** A day with none of the read series is one entry; otherwise each absent series that was not already explained. */
function dailyGaps(days: ActivityDay[], read: ActivitySeries[], explained: Missing[]): Missing[] {
  const gaps: Missing[] = [];
  for (const day of days) {
    const absent = read.filter(
      (name) => day[SERIES[name].field] === undefined && !explained.some((entry) => entry.date === day.date && entry.series === name),
    );
    if (absent.length === 0) continue;
    if (absent.length === read.length) gaps.push({ date: day.date, reason: NO_SAMPLES });
    else gaps.push(...absent.map((name) => ({ date: day.date, series: name, reason: NO_SAMPLES })));
  }
  return gaps;
}

function optional<T, R>(value: T | undefined, wrap: (value: T) => R): R | undefined {
  return value === undefined ? undefined : wrap(value);
}
