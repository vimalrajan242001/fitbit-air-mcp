import { MAX_ACTIVITY_DAYS, MAX_ACTIVITY_PAGES, WEARABLE_FAMILY } from './constants.js';
import {
  assertActivityRange,
  closedOpenRange,
  eachCivilDate,
  formatCivilDate,
  readFinite,
  readInt,
  type CivilParts,
} from './dates.js';
import { HealthCallError, isRecord, type Missing } from './errors.js';
import type { HealthApi } from './health.js';

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
  assertActivityRange(start, end, MAX_ACTIVITY_DAYS);
  const dates = eachCivilDate(start, end);
  const days = new Map<string, ActivityDay>(dates.map((date) => [date, { date }]));
  const missing: Missing[] = [];
  const failed = new Set<ActivitySeries>();
  let authStopped = false;

  for (let index = 0; index < series.length; index += 1) {
    const name = series[index]!;
    try {
      const points = await rollUp(api, name, start, end);
      for (const point of points) {
        const date = civilDateOf(point);
        const day = date ? days.get(date) : undefined;
        if (!day) continue;
        applyPoint(day, name, point, missing);
      }
    } catch (error) {
      if (error instanceof HealthCallError && (error.kind === 'not_linked' || error.kind === 'no_token' || error.kind === 'login_due')) {
        for (const rest of series.slice(index)) missing.push({ series: rest, reason: error.message });
        authStopped = true;
        break;
      }
      if (error instanceof HealthCallError) {
        failed.add(name);
        missing.push({ series: name, reason: error.message });
        continue;
      }
      throw error;
    }
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

  return {
    range: { start, end },
    dataSourceFamily: WEARABLE_FAMILY,
    days: dates.map((date) => days.get(date)!),
    missing,
  };
}

export function activityTotals(days: ActivityDay[]): ActivityTotals {
  const totals: ActivityTotals = {};
  const steps = days.map((day) => day.steps?.countSum).filter((value): value is number => value !== undefined);
  if (steps.length > 0) totals.stepsCountSum = steps.reduce((sum, value) => sum + value, 0);
  const distance = days.map((day) => day.distance?.millimetersSum).filter((value): value is number => value !== undefined);
  if (distance.length > 0) totals.distanceMillimetersSum = distance.reduce((sum, value) => sum + value, 0);
  const calories = days.map((day) => day.totalCalories?.kcalSum).filter((value): value is number => value !== undefined);
  if (calories.length > 0) totals.totalCaloriesKcalSum = calories.reduce((sum, value) => sum + value, 0);
  const activeMinutes = days.flatMap((day) => day.activeMinutes?.byActivityLevel.map((level) => level.activeMinutesSum) ?? []);
  if (activeMinutes.length > 0) totals.activeMinutesSum = activeMinutes.reduce((sum, value) => sum + value, 0);

  const zoneFields = ['sumInFatBurnHeartZone', 'sumInCardioHeartZone', 'sumInPeakHeartZone'] as const;
  const zone: NonNullable<ActivityTotals['activeZoneMinutes']> = {};
  for (const field of zoneFields) {
    const values = days
      .map((day) => day.activeZoneMinutes?.[field])
      .filter((value): value is number => value !== undefined);
    if (values.length > 0) zone[field] = values.reduce((sum, value) => sum + value, 0);
  }
  if (Object.keys(zone).length > 0) totals.activeZoneMinutes = zone;
  return totals;
}

export function subtractTotals(periodA: ActivityTotals, periodB: ActivityTotals): ActivityTotals {
  const deltas: ActivityTotals = {};
  assignDelta(deltas, 'stepsCountSum', periodA.stepsCountSum, periodB.stepsCountSum);
  assignDelta(deltas, 'distanceMillimetersSum', periodA.distanceMillimetersSum, periodB.distanceMillimetersSum);
  assignDelta(deltas, 'totalCaloriesKcalSum', periodA.totalCaloriesKcalSum, periodB.totalCaloriesKcalSum);
  assignDelta(deltas, 'activeMinutesSum', periodA.activeMinutesSum, periodB.activeMinutesSum);
  const zoneFields = ['sumInFatBurnHeartZone', 'sumInCardioHeartZone', 'sumInPeakHeartZone'] as const;
  const zone: NonNullable<ActivityTotals['activeZoneMinutes']> = {};
  for (const field of zoneFields) {
    const left = periodA.activeZoneMinutes?.[field];
    const right = periodB.activeZoneMinutes?.[field];
    if (left !== undefined && right !== undefined) zone[field] = right - left;
  }
  if (Object.keys(zone).length > 0) deltas.activeZoneMinutes = zone;
  return deltas;
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
}> {
  const left = await readDailyActivity(api, periodA.start, periodA.end);
  const right = await readDailyActivity(api, periodB.start, periodB.end);
  return {
    periodA: left,
    periodB: right,
    deltaMeaning: 'periodB minus periodA',
    deltas: subtractTotals(activityTotals(left.days), activityTotals(right.days)),
  };
}

async function rollUp(api: HealthApi, series: ActivitySeries, start: string, end: string): Promise<RollupPoint[]> {
  const range = closedOpenRange(start, end);
  const points: RollupPoint[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_ACTIVITY_PAGES; page += 1) {
    const body: Record<string, unknown> = {
      range,
      windowSizeDays: 1,
      dataSourceFamily: WEARABLE_FAMILY,
    };
    if (pageToken) body.pageToken = pageToken;
    const payload = await api.post(`/users/me/dataTypes/${series}/dataPoints:dailyRollUp`, body);
    if (!isRecord(payload)) return points;
    const batch = Array.isArray(payload.rollupDataPoints) ? payload.rollupDataPoints : [];
    for (const point of batch) {
      if (isRecord(point)) points.push(point as RollupPoint);
    }
    pageToken = typeof payload.nextPageToken === 'string' && payload.nextPageToken.length > 0 ? payload.nextPageToken : undefined;
    if (!pageToken) return points;
  }
  throw new HealthCallError('http', 'paging stopped before the range was covered');
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

function assignDelta(target: ActivityTotals, key: 'stepsCountSum' | 'distanceMillimetersSum' | 'totalCaloriesKcalSum' | 'activeMinutesSum', left: number | undefined, right: number | undefined): void {
  if (left === undefined || right === undefined) return;
  target[key] = right - left;
}
