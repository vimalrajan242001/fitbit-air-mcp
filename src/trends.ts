import { ACTIVITY_SERIES, readDailyActivity, type ActivityDay } from './activity.js';
import { BASELINE_DAYS, MAX_ROLLUP_DAYS, MAX_TREND_DAYS, WEARABLE_FAMILY } from './constants.js';
import { addCivilDays, assertRange, chunkRange, parseDurationSeconds, type DateRange } from './dates.js';
import type { Missing } from './errors.js';
import type { HealthApi } from './health.js';
import { readSleepNights, type SleepNight } from './sleep.js';
import { describe, mean, percentile, present, roundOrUndefined, total, type Distribution } from './stats.js';

const DAYS_PER_WEEK = 7;

const BASELINE_NOTE = `Median and middle half (25th to 75th percentile) of daily values over the last ${BASELINE_DAYS} days of the range. Descriptive only, not a score or a diagnosis.`;

const ACTIVITY_METRICS = {
  steps: (day: ActivityDay) => day.steps?.countSum,
  distanceMillimeters: (day: ActivityDay) => day.distance?.millimetersSum,
  activeZoneMinutes: (day: ActivityDay) => (day.activeZoneMinutes ? total(Object.values(day.activeZoneMinutes)) : undefined),
  activeMinutes: (day: ActivityDay) => (day.activeMinutes ? total(day.activeMinutes.byActivityLevel.map((level) => level.activeMinutesSum)) : undefined),
  totalCaloriesKcal: (day: ActivityDay) => day.totalCalories?.kcalSum,
};

type ActivityMetric = keyof typeof ACTIVITY_METRICS;

/** Daily activity grouped into 7-day weeks from `start`, read 14 days at a time. */
export async function readActivityWeeks(api: HealthApi, start: string, end: string) {
  assertRange(start, end, MAX_TREND_DAYS);
  const days: ActivityDay[] = [];
  const missing = new Map<string, Missing>();
  let authStopped = false;
  // Sequential on purpose: an auth stop ends the read, and the Worker caps subrequests.
  for (const range of chunkRange(start, end, MAX_ROLLUP_DAYS)) {
    const chunk = await readDailyActivity(api, range.start, range.end, ACTIVITY_SERIES, MAX_ROLLUP_DAYS);
    days.push(...chunk.days);
    // Per-day gaps show up as daysWithData; only whole-series failures are listed.
    for (const entry of chunk.missing) if (!entry.date) missing.set(`${entry.series}|${entry.reason}`, entry);
    authStopped = chunk.authStopped === true;
    if (authStopped) break;
  }
  const metrics = Object.keys(ACTIVITY_METRICS) as ActivityMetric[];
  const valuesOf = (slice: ActivityDay[], metric: ActivityMetric) => present(slice.map(ACTIVITY_METRICS[metric]));
  const window = baselineWindow(start, end);
  return {
    range: { start, end },
    granularity: 'week' as const,
    dataSourceFamily: WEARABLE_FAMILY,
    weeks: chunkRange(start, end, DAYS_PER_WEEK).map(({ start: weekStart, end: weekEnd }) => {
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
      ) as Record<ActivityMetric, Distribution>),
    },
    missing: [...missing.values()],
    ...(authStopped ? { authStopped: true as const } : {}),
  };
}

/** Sleep grouped into 7-day weeks. The longest session per date is the main sleep; the rest are naps. */
export async function readSleepWeeks(api: HealthApi, start: string, end: string) {
  const result = await readSleepNights(api, start, end, false, MAX_TREND_DAYS);
  const { main, naps } = splitMainSleep(result.nights);
  const dates = [...main.keys()];
  const window = baselineWindow(start, end);
  return {
    range: result.range,
    granularity: 'week' as const,
    dataSourceFamily: result.dataSourceFamily,
    weeks: chunkRange(start, end, DAYS_PER_WEEK).map(({ start: weekStart, end: weekEnd }) => {
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

/** The longest session per civil date is the main sleep; every other session is a nap. */
function splitMainSleep(nights: SleepNight[]): { main: Map<string, SleepNight>; naps: SleepNight[] } {
  const main = new Map<string, SleepNight>();
  const naps: SleepNight[] = [];
  for (const night of nights) {
    const current = main.get(night.date);
    if (!current || night.inBedMinutes > current.inBedMinutes) {
      if (current) naps.push(current);
      main.set(night.date, night);
    } else {
      naps.push(night);
    }
  }
  return { main, naps };
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

function baselineWindow(start: string, end: string): DateRange {
  const baselineStart = addCivilDays(end, 1 - BASELINE_DAYS);
  return { start: baselineStart > start ? baselineStart : start, end };
}
