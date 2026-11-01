import { MAX_ACTIVITY_DAYS, MAX_ACTIVITY_PAGES, WEARABLE_FAMILY } from './constants.js';
import {
  assertRange,
  closedOpenRange,
  eachCivilDate,
  formatCivilDate,
  readFinite,
  readInt,
  type CivilParts,
} from './dates.js';
import { HealthCallError, isRecord, type Missing } from './errors.js';
import { paginate, type HealthApi } from './health.js';

export const ACTIVITY_SERIES = [
  'steps',
  'distance',
  'active-zone-minutes',
  'active-minutes',
  'total-calories',
] as const;

export type ActivitySeries = (typeof ACTIVITY_SERIES)[number];

export type ActivityDay = {
  date: string;
  steps?: { countSum: number };
  distance?: { millimetersSum: number };
  activeZoneMinutes?: {
    sumInFatBurnHeartZone?: number;
    sumInCardioHeartZone?: number;
    sumInPeakHeartZone?: number;
  };
  activeMinutes?: { byActivityLevel: Array<{ activityLevel: string; activeMinutesSum: number }> };
  totalCalories?: { kcalSum: number };
};

export type ActivityResult = {
  range: { start: string; end: string };
  dataSourceFamily: typeof WEARABLE_FAMILY;
  days: ActivityDay[];
  missing: Missing[];
  /** Set when the account needs login or linking, so later calls would fail the same way. */
  authStopped?: true;
};

export type ActivityTotals = {
  stepsCountSum?: number;
  distanceMillimetersSum?: number;
  totalCaloriesKcalSum?: number;
  activeMinutesSum?: number;
  activeZoneMinutes?: {
    sumInFatBurnHeartZone?: number;
    sumInCardioHeartZone?: number;
    sumInPeakHeartZone?: number;
  };
};

type RollupPoint = {
  civilStartTime?: { date?: Partial<CivilParts> };
  steps?: { countSum?: unknown };
  distance?: { millimetersSum?: unknown };
  activeZoneMinutes?: Record<string, unknown>;
  activeMinutes?: { activeMinutesRollupByActivityLevel?: unknown };
  totalCalories?: { kcalSum?: unknown };
};

export async function readDailyActivity(
  api: HealthApi,
  start: string,
  end: string,
  series: readonly ActivitySeries[] = ACTIVITY_SERIES,
): Promise<ActivityResult> {
  assertRange(start, end, MAX_ACTIVITY_DAYS);
  const dates = eachCivilDate(start, end);
  const days = new Map<string, ActivityDay>(dates.map((date) => [date, { date }]));
  const missing: Missing[] = [];
  const failed = new Set<ActivitySeries>();
  let authStopped = false;

  const results = await Promise.allSettled(series.map((name) => rollUp(api, name, start, end)));
  const unexpected = results.find((result) => result.status === 'rejected' && !(result.reason instanceof HealthCallError));
  if (unexpected?.status === 'rejected') throw unexpected.reason;
  const authError = results.find(
    (result) => result.status === 'rejected' && ['not_linked', 'no_token', 'login_due'].includes((result.reason as HealthCallError).kind),
  );
  if (authError?.status === 'rejected') {
    for (const name of series) missing.push({ series: name, reason: (authError.reason as HealthCallError).message });
    authStopped = true;
  } else {
    results.forEach((result, index) => {
      const name = series[index]!;
      if (result.status === 'rejected') {
        failed.add(name);
        missing.push({ series: name, reason: (result.reason as HealthCallError).message });
        return;
      }
      for (const point of result.value) {
        const date = civilDateOf(point);
        const day = date ? days.get(date) : undefined;
        if (!day) continue;
        applyPoint(day, name, point, missing);
      }
    });
  }

  if (!authStopped) for (const date of dates) {
    const day = days.get(date)!;
    const absent = series.filter((name) => !failed.has(name) && !hasSeries(day, name) && !missing.some((entry) => entry.date === date && entry.series === name));
    if (absent.length === 0) continue;
    if (absent.length === series.filter((name) => !failed.has(name)).length) {
      missing.push({ date, reason: 'no wearable samples' });
    } else {
      for (const name of absent) missing.push({ date, series: name, reason: 'no wearable samples' });
    }
  }

  const result: ActivityResult = {
    range: { start, end },
    dataSourceFamily: WEARABLE_FAMILY,
    days: dates.map((date) => days.get(date)!),
    missing,
  };
  if (authStopped) result.authStopped = true;
  return result;
}

/** Days per series that have a value, so sums over unequal coverage are not read as a change. */
export function daysWithData(days: ActivityDay[]): Record<ActivitySeries, number> {
  return Object.fromEntries(ACTIVITY_SERIES.map((name) => [name, days.filter((day) => hasSeries(day, name)).length])) as Record<ActivitySeries, number>;
}

export function activityTotals(days: ActivityDay[]): ActivityTotals {
  const zone = defined(Object.fromEntries(ZONE_FIELDS.map((field) => [field, sum(days.map((day) => day.activeZoneMinutes?.[field]))])));
  return defined({
    stepsCountSum: sum(days.map((day) => day.steps?.countSum)),
    distanceMillimetersSum: sum(days.map((day) => day.distance?.millimetersSum)),
    totalCaloriesKcalSum: sum(days.map((day) => day.totalCalories?.kcalSum)),
    activeMinutesSum: sum(days.flatMap((day) => day.activeMinutes?.byActivityLevel.map((level) => level.activeMinutesSum) ?? [])),
    activeZoneMinutes: Object.keys(zone).length > 0 ? zone : undefined,
  });
}

export function subtractTotals(periodA: ActivityTotals, periodB: ActivityTotals): ActivityTotals {
  const zone = defined(
    Object.fromEntries(ZONE_FIELDS.map((field) => [field, delta(periodA.activeZoneMinutes?.[field], periodB.activeZoneMinutes?.[field])])),
  );
  return defined({
    stepsCountSum: delta(periodA.stepsCountSum, periodB.stepsCountSum),
    distanceMillimetersSum: delta(periodA.distanceMillimetersSum, periodB.distanceMillimetersSum),
    totalCaloriesKcalSum: delta(periodA.totalCaloriesKcalSum, periodB.totalCaloriesKcalSum),
    activeMinutesSum: delta(periodA.activeMinutesSum, periodB.activeMinutesSum),
    activeZoneMinutes: Object.keys(zone).length > 0 ? zone : undefined,
  });
}

export async function comparePeriods(
  api: HealthApi,
  periodA: { start: string; end: string },
  periodB: { start: string; end: string },
): Promise<{
  periodA: ActivityResult;
  periodB: ActivityResult;
  deltaMeaning: 'periodB minus periodA';
  deltas: ActivityTotals;
  daysWithData: { periodA: Record<ActivitySeries, number>; periodB: Record<ActivitySeries, number> };
}> {
  const [left, right] = await Promise.all([
    readDailyActivity(api, periodA.start, periodA.end),
    readDailyActivity(api, periodB.start, periodB.end),
  ]);
  return {
    periodA: left,
    periodB: right,
    deltaMeaning: 'periodB minus periodA',
    deltas: subtractTotals(activityTotals(left.days), activityTotals(right.days)),
    daysWithData: { periodA: daysWithData(left.days), periodB: daysWithData(right.days) },
  };
}

async function rollUp(api: HealthApi, series: ActivitySeries, start: string, end: string): Promise<RollupPoint[]> {
  const range = closedOpenRange(start, end);
  const points = await paginate(
    (pageToken) => {
      const body: Record<string, unknown> = {
        range,
        windowSizeDays: 1,
        dataSourceFamily: WEARABLE_FAMILY,
      };
      if (pageToken) body.pageToken = pageToken;
      return api.post(`/users/me/dataTypes/${series}/dataPoints:dailyRollUp`, body);
    },
    'rollupDataPoints',
    MAX_ACTIVITY_PAGES,
    'paging stopped before the range was covered',
  );
  return points.filter(isRecord) as RollupPoint[];
}

function civilDateOf(point: RollupPoint): string | undefined {
  const date = point.civilStartTime?.date;
  if (!date || typeof date.year !== 'number' || typeof date.month !== 'number' || typeof date.day !== 'number') return undefined;
  return formatCivilDate({ year: date.year, month: date.month, day: date.day });
}

function applyPoint(day: ActivityDay, series: ActivitySeries, point: RollupPoint, missing: Missing[]): void {
  if (series === 'steps') {
    if (!point.steps) return;
    const countSum = readInt(point.steps.countSum);
    if (countSum === undefined) {
      missing.push({ date: day.date, series, reason: 'steps rollup had no countSum' });
      return;
    }
    day.steps = { countSum };
    return;
  }
  if (series === 'distance') {
    if (!point.distance) return;
    const millimetersSum = readInt(point.distance.millimetersSum);
    if (millimetersSum === undefined) {
      missing.push({ date: day.date, series, reason: 'distance rollup had no millimetersSum' });
      return;
    }
    day.distance = { millimetersSum };
    return;
  }
  if (series === 'total-calories') {
    if (!point.totalCalories) return;
    const kcalSum = readFinite(point.totalCalories.kcalSum);
    if (kcalSum === undefined) {
      missing.push({ date: day.date, series, reason: 'total calories rollup had no kcalSum' });
      return;
    }
    day.totalCalories = { kcalSum };
    return;
  }
  if (series === 'active-zone-minutes') {
    if (!point.activeZoneMinutes) return;
    const zone = {
      sumInFatBurnHeartZone: readInt(point.activeZoneMinutes.sumInFatBurnHeartZone),
      sumInCardioHeartZone: readInt(point.activeZoneMinutes.sumInCardioHeartZone),
      sumInPeakHeartZone: readInt(point.activeZoneMinutes.sumInPeakHeartZone),
    };
    const present = Object.fromEntries(Object.entries(zone).filter((entry) => entry[1] !== undefined));
    if (Object.keys(present).length === 0) {
      missing.push({ date: day.date, series, reason: 'active zone minutes rollup had no documented sums' });
      return;
    }
    day.activeZoneMinutes = present;
    return;
  }
  if (!point.activeMinutes || !Array.isArray(point.activeMinutes.activeMinutesRollupByActivityLevel)) return;
  const byActivityLevel = point.activeMinutes.activeMinutesRollupByActivityLevel.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.activityLevel !== 'string') return [];
    const activeMinutesSum = readInt(entry.activeMinutesSum);
    if (activeMinutesSum === undefined) return [];
    return [{ activityLevel: entry.activityLevel, activeMinutesSum }];
  });
  if (byActivityLevel.length === 0) return;
  day.activeMinutes = { byActivityLevel };
}

function hasSeries(day: ActivityDay, series: ActivitySeries): boolean {
  if (series === 'steps') return day.steps !== undefined;
  if (series === 'distance') return day.distance !== undefined;
  if (series === 'active-zone-minutes') return day.activeZoneMinutes !== undefined;
  if (series === 'active-minutes') return day.activeMinutes !== undefined;
  return day.totalCalories !== undefined;
}

const ZONE_FIELDS = ['sumInFatBurnHeartZone', 'sumInCardioHeartZone', 'sumInPeakHeartZone'] as const;

function sum(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length > 0 ? present.reduce((total, value) => total + value, 0) : undefined;
}

function delta(left: number | undefined, right: number | undefined): number | undefined {
  return left === undefined || right === undefined ? undefined : right - left;
}

/** Drops undefined keys so absent sums stay absent in the result. */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined)) as T;
}
