import { MAX_RECONCILE_DAYS, WEARABLE_FAMILY } from './constants.js';
import { assertRange, civilDateOf, eachCivilDate, intervalMinutes, readInterval, type Interval } from './dates.js';
import { expectHealthError, type Missing } from './errors.js';
import { civilRangeFilter, reconcile, type HealthApi, type WearableResult } from './health.js';
import { isRecord, readInt } from './parse.js';

const STAGE_TYPES = ['AWAKE', 'LIGHT', 'DEEP', 'REM', 'ASLEEP', 'RESTLESS'] as const;
type StageType = (typeof STAGE_TYPES)[number];

export type SleepStageInterval = Interval & { type: string };

export type SleepNight = {
  date: string;
  sourceDevice?: string;
  interval: Interval;
  inBedMinutes: number;
  minutesAsleep?: number;
  stageMinutes: Partial<Record<StageType, number>>;
  shortAwakeningCount: number;
  /** Documented ratio round((minutesAsleep / inBedMinutes) * 100). Not the in-app Sleep Score. */
  sleepEfficiencyPercent?: number;
  stages?: SleepStageInterval[];
};

export type SleepResult = WearableResult & { nights: SleepNight[] };

export async function readSleepNights(api: HealthApi, start: string, end: string, detail: boolean, maxDays = MAX_RECONCILE_DAYS): Promise<SleepResult> {
  assertRange(start, end, maxDays);
  const range = { start, end };
  const result: SleepResult = { range, dataSourceFamily: WEARABLE_FAMILY, nights: [], missing: [] };
  const singleNight = start === end;
  if (detail && !singleNight) {
    result.missing.push({ reason: 'stage intervals are returned only for a single night' });
  }
  let sessions: unknown[];
  try {
    sessions = await reconcile(api, 'sleep', civilRangeFilter('sleep.interval.civil_end_time', range), 'paging stopped before the sleep window was covered');
  } catch (error) {
    result.missing.push({ series: 'sleep', reason: expectHealthError(error).message });
    return result;
  }

  for (const session of sessions) {
    const night = summarizeSleepSession(session, { includeStages: detail && singleNight });
    if (!night) {
      result.missing.push({ series: 'sleep', reason: 'sleep session interval could not be read' });
    } else if (night.date >= start && night.date <= end) {
      result.nights.push(night);
    }
  }
  result.nights.sort((left, right) => left.interval.endTime.localeCompare(right.interval.endTime));
  result.missing.push(...nightsWithoutSleep(result.nights, range.start, range.end));
  return result;
}

function nightsWithoutSleep(nights: SleepNight[], start: string, end: string): Missing[] {
  const covered = new Set(nights.map((night) => night.date));
  return eachCivilDate(start, end)
    .filter((date) => !covered.has(date))
    .map((date) => ({ date, series: 'sleep', reason: 'no wearable samples' }));
}

/** Builds a night from the documented fields only, or null when the session interval cannot be read. */
export function summarizeSleepSession(session: unknown, options: { includeStages: boolean }): SleepNight | null {
  if (!isRecord(session) || !isRecord(session.sleep)) return null;
  const sleep = session.sleep;
  if (!isRecord(sleep.interval)) return null;
  const interval = readInterval(sleep.interval);
  const inBedMinutes = interval && intervalMinutes(interval);
  if (!interval || inBedMinutes === null) return null;
  const date = civilDateOf(sleep.interval.civilEndTime, interval.endTime, interval.endUtcOffset);
  if (!date) return null;

  const summary = isRecord(sleep.summary) ? sleep.summary : undefined;
  const minutesAsleep = summary ? readInt(summary.minutesAsleep) : undefined;
  const night: SleepNight = {
    date,
    interval,
    inBedMinutes,
    stageMinutes: stageMinutes(summary?.stagesSummary),
    shortAwakeningCount: Array.isArray(sleep.shortAwakenings) ? sleep.shortAwakenings.length : 0,
  };
  if (minutesAsleep !== undefined) night.minutesAsleep = minutesAsleep;
  if (minutesAsleep !== undefined && inBedMinutes > 0) {
    night.sleepEfficiencyPercent = Math.round((minutesAsleep / inBedMinutes) * 100);
  }
  const device = isRecord(session.dataSource) && isRecord(session.dataSource.device) ? session.dataSource.device.displayName : undefined;
  if (typeof device === 'string' && device.length > 0) night.sourceDevice = device;
  if (options.includeStages && Array.isArray(sleep.stages)) night.stages = stageIntervals(sleep.stages);
  return night;
}

function stageMinutes(stagesSummary: unknown): SleepNight['stageMinutes'] {
  const minutesByStage: SleepNight['stageMinutes'] = {};
  if (!Array.isArray(stagesSummary)) return minutesByStage;
  for (const stage of stagesSummary) {
    if (!isRecord(stage) || !STAGE_TYPES.includes(stage.type as StageType)) continue;
    const minutes = readInt(stage.minutes);
    if (minutes !== undefined) minutesByStage[stage.type as StageType] = minutes;
  }
  return minutesByStage;
}

function stageIntervals(stages: unknown[]): SleepStageInterval[] {
  return stages.flatMap((stage) => {
    if (!isRecord(stage) || typeof stage.type !== 'string') return [];
    const interval = readInterval(stage);
    return interval ? [{ type: stage.type, ...interval }] : [];
  });
}
