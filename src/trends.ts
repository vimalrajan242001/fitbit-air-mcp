import { readDailyActivity, type ActivityDay } from './activity.js';
import { BASELINE_DAYS, MAX_ACTIVITY_DAYS, MAX_TREND_DAYS, WEARABLE_FAMILY } from './constants.js';
import { addCivilDays, assertRange, parseDurationSeconds } from './dates.js';
import type { Missing } from './errors.js';
import type { HealthApi } from './health.js';
import { readSleepNights, type SleepNight } from './sleep.js';

const BASELINE_NOTE = `Median and middle half (25th to 75th percentile) of daily values over the last ${BASELINE_DAYS} days of the range. Descriptive only, not a score or a diagnosis.`;

const ACTIVITY_METRICS = {
  steps: (day: ActivityDay) => day.steps?.countSum,
  distanceMillimeters: (day: ActivityDay) => day.distance?.millimetersSum,
  activeZoneMinutes: (day: ActivityDay) => (day.activeZoneMinutes ? total(Object.values(day.activeZoneMinutes)) : undefined),
  activeMinutes: (day: ActivityDay) => (day.activeMinutes ? total(day.activeMinutes.byActivityLevel.map((level) => level.activeMinutesSum)) : undefined),
  totalCaloriesKcal: (day: ActivityDay) => day.totalCalories?.kcalSum,
};

type ActivityMetric = keyof typeof ACTIVITY_METRICS;

/** Daily activity grouped into 7-day weeks from `start`, read 7 days at a time. */
export async function readActivityWeeks(api: HealthApi, start: string, end: string) {
  assertRange(start, end, MAX_TREND_DAYS);
  const days: ActivityDay[] = [];
  const missing = new Map<string, Missing>();
  let authStopped = false;
  for (let chunkStart = start; chunkStart <= end && !authStopped; chunkStart = addCivilDays(chunkStart, MAX_ACTIVITY_DAYS)) {
    const chunkEnd = minDate(addCivilDays(chunkStart, MAX_ACTIVITY_DAYS - 1), end);
    const chunk = await readDailyActivity(api, chunkStart, chunkEnd);
    days.push(...chunk.days);
    // Per-day gaps show up as daysWithData; only whole-series failures are listed.
    for (const entry of chunk.missing) if (!entry.date) missing.set(`${entry.series}|${entry.reason}`, entry);
    authStopped = chunk.authStopped === true;
  }
  const metrics = Object.keys(ACTIVITY_METRICS) as ActivityMetric[];
  const valuesOf = (slice: ActivityDay[], metric: ActivityMetric) => present(slice.map(ACTIVITY_METRICS[metric]));
  const window = baselineWindow(start, end);
  return {
    range: { start, end },
    granularity: 'week' as const,
    dataSourceFamily: WEARABLE_FAMILY,
    weeks: weeksOf(start, end).map(({ start: weekStart, end: weekEnd }) => {
      const slice = days.filter((day) => day.date >= weekStart && day.date <= weekEnd);
      return {
        start: weekStart,
        end: weekEnd,
        daysWithData: Object.fromEntries(metrics.map((metric) => [metric, valuesOf(slice, metric).length])),
        dailyAverage: Object.fromEntries(metrics.map((metric) => [metric, roundOrUndefined(mean(valuesOf(slice, metric)))])),
      };
    }),
    baseline: {
      ...window,
      note: BASELINE_NOTE,
      ...(Object.fromEntries(
        metrics.map((metric) => [metric, describe(valuesOf(days.filter((day) => day.date >= window.start), metric))]),
      ) as Record<ActivityMetric, ReturnType<typeof describe>>),
    },
    missing: [...missing.values()],
    ...(authStopped ? { authStopped: true as const } : {}),
  };
}

/** Sleep grouped into 7-day weeks. The longest session per date is the main sleep; the rest are naps. */
export async function readSleepWeeks(api: HealthApi, start: string, end: string) {
  const result = await readSleepNights(api, start, end, false, MAX_TREND_DAYS);
  const main = new Map<string, SleepNight>();
  const naps: SleepNight[] = [];
  for (const night of result.nights) {
    const current = main.get(night.date);
    if (!current || night.inBedMinutes > current.inBedMinutes) {
      if (current) naps.push(current);
      main.set(night.date, night);
    } else {
      naps.push(night);
    }
  }
  const dates = [...main.keys()];
  const window = baselineWindow(start, end);
  return {
    range: result.range,
    granularity: 'week' as const,
    dataSourceFamily: result.dataSourceFamily,
    weeks: weeksOf(start, end).map(({ start: weekStart, end: weekEnd }) => {
      const nights = dates.filter((date) => date >= weekStart && date <= weekEnd).map((date) => main.get(date)!);
      const weekNaps = naps.filter((nap) => nap.date >= weekStart && nap.date <= weekEnd);
      return {
        start: weekStart,
        end: weekEnd,
        nightsWithData: nights.length,
        mainSleep: summarizeMainSleep(nights),
        naps: { count: weekNaps.length, inBedMinutes: total(weekNaps.map((nap) => nap.inBedMinutes)) },
      };
    }),
    baseline: {
      ...window,
      note: BASELINE_NOTE,
      ...mainSleepBaseline(dates.filter((date) => date >= window.start).map((date) => main.get(date)!)),
    },
    // Per-night gaps show up as nightsWithData.
    missing: result.missing.filter((entry) => !entry.date),
  };
}

function summarizeMainSleep(nights: SleepNight[]) {
  if (nights.length === 0) return undefined;
  const bedtimes = present(nights.map(bedtimeMinutesFromNoon));
  return {
    averageMinutesAsleep: roundOrUndefined(mean(present(nights.map((night) => night.minutesAsleep)))),
    averageInBedMinutes: roundOrUndefined(mean(nights.map((night) => night.inBedMinutes))),
    medianBedtime: bedtimes.length > 0 ? clockFromNoon(percentile(bedtimes, 0.5)) : undefined,
    bedtimeSpreadMinutes: bedtimes.length > 0 ? Math.round(percentile(bedtimes, 0.75) - percentile(bedtimes, 0.25)) : undefined,
  };
}

function mainSleepBaseline(nights: SleepNight[]) {
  const bedtimes = present(nights.map(bedtimeMinutesFromNoon));
  return {
    minutesAsleep: describe(present(nights.map((night) => night.minutesAsleep))),
    inBedMinutes: describe(nights.map((night) => night.inBedMinutes)),
    medianBedtime: bedtimes.length > 0 ? clockFromNoon(percentile(bedtimes, 0.5)) : undefined,
  };
}

/** Local bedtime as minutes after noon, so 23:30 and 00:30 sit next to each other. */
export function bedtimeMinutesFromNoon(night: SleepNight): number | undefined {
  const startMs = Date.parse(night.interval.startTime);
  if (Number.isNaN(startMs)) return undefined;
  const local = new Date(startMs + (parseDurationSeconds(night.interval.startUtcOffset) ?? 0) * 1000);
  return (local.getUTCHours() * 60 + local.getUTCMinutes() + 720) % 1440;
}

function clockFromNoon(minutes: number): string {
  const clock = (Math.round(minutes) + 720) % 1440;
  return `${String(Math.floor(clock / 60)).padStart(2, '0')}:${String(clock % 60).padStart(2, '0')}`;
}

function weeksOf(start: string, end: string): Array<{ start: string; end: string }> {
  const weeks: Array<{ start: string; end: string }> = [];
  for (let weekStart = start; weekStart <= end; weekStart = addCivilDays(weekStart, 7)) {
    weeks.push({ start: weekStart, end: minDate(addCivilDays(weekStart, 6), end) });
  }
  return weeks;
}

function baselineWindow(start: string, end: string): { start: string; end: string } {
  const baselineStart = addCivilDays(end, 1 - BASELINE_DAYS);
  return { start: baselineStart > start ? baselineStart : start, end };
}

function describe(values: number[]) {
  if (values.length === 0) return { daysWithData: 0 };
  return {
    median: Math.round(percentile(values, 0.5)),
    typicalRange: [Math.round(percentile(values, 0.25)), Math.round(percentile(values, 0.75))],
    daysWithData: values.length,
  };
}

/** Linear-interpolated percentile of a non-empty list. */
export function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

function present(values: Array<number | undefined>): number[] {
  return values.filter((value): value is number => value !== undefined);
}

function total(values: Array<number | undefined>): number {
  return present(values).reduce((sum, value) => sum + value, 0);
}

function mean(values: number[]): number | undefined {
  return values.length > 0 ? total(values) / values.length : undefined;
}

function roundOrUndefined(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.round(value);
}

function minDate(left: string, right: string): string {
  return left < right ? left : right;
}
