import { MAX_SLEEP_PAGES, SLEEP_PAGE_SIZE, WEARABLE_FAMILY } from './constants.js';
import { addCivilDays, eachCivilDate, inclusiveDayCount, parseDurationSeconds, readInt } from './dates.js';
import { HealthCallError, isRecord, type Missing } from './errors.js';
import type { HealthApi } from './health.js';

const STAGE_TYPES = ['AWAKE', 'LIGHT', 'DEEP', 'REM', 'ASLEEP', 'RESTLESS'] as const;
type StageType = (typeof STAGE_TYPES)[number];

export type SleepStageInterval = {
  type: string;
  startTime: string;
  endTime: string;
  startUtcOffset?: string;
  endUtcOffset?: string;
};

export type SleepNight = {
  date: string;
  sourceDevice?: string;
  interval: { startTime: string; endTime: string; startUtcOffset?: string; endUtcOffset?: string };
  inBedMinutes: number;
  minutesAsleep?: number;
  stageMinutes: Partial<Record<StageType, number>>;
  shortAwakeningCount: number;
  /** Documented ratio round((minutesAsleep / inBedMinutes) * 100). Not the in-app Sleep Score. */
  sleepEfficiencyPercent?: number;
  stages?: SleepStageInterval[];
};

export type SleepResult = {
  range: { start: string; end: string };
  dataSourceFamily: typeof WEARABLE_FAMILY;
  nights: SleepNight[];
  missing: Missing[];
};

export async function readSleepNights(api: HealthApi, start: string, end: string, detail: boolean): Promise<SleepResult> {
  const days = inclusiveDayCount(start, end);
  if (days < 1) throw new Error('The end date is before the start date.');
  const missing: Missing[] = [];
  const singleNight = start === end;
  if (detail && !singleNight) {
    missing.push({ reason: 'stage intervals are returned only for a single night' });
  }
  let sessions: unknown[];
  try {
    sessions = await reconcileSleep(api, start, end);
  } catch (error) {
    if (error instanceof HealthCallError) {
      return {
        range: { start, end },
        dataSourceFamily: WEARABLE_FAMILY,
        nights: [],
        missing: [...missing, { series: 'sleep', reason: error.message }],
      };
    }
    throw error;
  }

  const nights: SleepNight[] = [];
  for (const session of sessions) {
    const night = summarizeSleepSession(session, { includeStages: detail && singleNight });
    if (!night) {
      missing.push({ series: 'sleep', reason: 'sleep session interval could not be read' });
      continue;
    }
    if (night.date < start || night.date > end) continue;
    nights.push(night);
  }
  nights.sort((left, right) => left.interval.endTime.localeCompare(right.interval.endTime));

  const covered = new Set(nights.map((night) => night.date));
  for (const date of eachCivilDate(start, end)) {
    if (!covered.has(date)) missing.push({ date, series: 'sleep', reason: 'no wearable samples' });
  }
  return { range: { start, end }, dataSourceFamily: WEARABLE_FAMILY, nights, missing };
}

export function summarizeSleepSession(session: unknown, options: { includeStages: boolean }): SleepNight | null {
  if (!isRecord(session) || !isRecord(session.sleep) || !isRecord(session.sleep.interval)) return null;
  const interval = session.sleep.interval;
  if (typeof interval.startTime !== 'string' || typeof interval.endTime !== 'string') return null;
  const startMs = Date.parse(interval.startTime);
  const endMs = Date.parse(interval.endTime);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) return null;
  const date = civilEndDate(interval);
  if (!date) return null;
  const inBedMinutes = Math.round((endMs - startMs) / 60_000);
  const summary = isRecord(session.sleep.summary) ? session.sleep.summary : undefined;
  const minutesAsleep = summary ? readInt(summary.minutesAsleep) : undefined;
  const stageMinutes: SleepNight['stageMinutes'] = {};
  if (summary && Array.isArray(summary.stagesSummary)) {
    for (const stage of summary.stagesSummary) {
      if (!isRecord(stage) || typeof stage.type !== 'string') continue;
      if (!STAGE_TYPES.includes(stage.type as StageType)) continue;
      const minutes = readInt(stage.minutes);
      if (minutes === undefined) continue;
      stageMinutes[stage.type as StageType] = minutes;
    }
  }
  const shortAwakenings = session.sleep.shortAwakenings;
  const night: SleepNight = {
    date,
    interval: {
      startTime: interval.startTime,
      endTime: interval.endTime,
      ...(typeof interval.startUtcOffset === 'string' ? { startUtcOffset: interval.startUtcOffset } : {}),
      ...(typeof interval.endUtcOffset === 'string' ? { endUtcOffset: interval.endUtcOffset } : {}),
    },
    inBedMinutes,
    stageMinutes,
    shortAwakeningCount: Array.isArray(shortAwakenings) ? shortAwakenings.length : 0,
  };
  if (minutesAsleep !== undefined) night.minutesAsleep = minutesAsleep;
  if (minutesAsleep !== undefined && inBedMinutes > 0) {
    night.sleepEfficiencyPercent = Math.round((minutesAsleep / inBedMinutes) * 100);
  }
  const device = isRecord(session.dataSource) && isRecord(session.dataSource.device) ? session.dataSource.device.displayName : undefined;
  if (typeof device === 'string' && device.length > 0) night.sourceDevice = device;
  if (options.includeStages && Array.isArray(session.sleep.stages)) {
    night.stages = session.sleep.stages.flatMap((stage) => {
      if (!isRecord(stage) || typeof stage.type !== 'string' || typeof stage.startTime !== 'string' || typeof stage.endTime !== 'string') {
        return [];
      }
      return [
        {
          type: stage.type,
          startTime: stage.startTime,
          endTime: stage.endTime,
          ...(typeof stage.startUtcOffset === 'string' ? { startUtcOffset: stage.startUtcOffset } : {}),
          ...(typeof stage.endUtcOffset === 'string' ? { endUtcOffset: stage.endUtcOffset } : {}),
        },
      ];
    });
  }
  return night;
}

function civilEndDate(interval: Record<string, unknown>): string | null {
  const civil = interval.civilEndTime;
  if (isRecord(civil) && isRecord(civil.date)) {
    const { year, month, day } = civil.date;
    if (typeof year === 'number' && typeof month === 'number' && typeof day === 'number') {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  if (typeof interval.endTime !== 'string') return null;
  const offset = parseDurationSeconds(interval.endUtcOffset) ?? 0;
  const shifted = new Date(Date.parse(interval.endTime) + offset * 1000);
  if (Number.isNaN(shifted.getTime())) return null;
  return shifted.toISOString().slice(0, 10);
}

async function reconcileSleep(api: HealthApi, start: string, end: string): Promise<unknown[]> {
  const exclusiveEnd = addCivilDays(end, 1);
  const filter = `sleep.interval.civil_end_time >= "${start}" AND sleep.interval.civil_end_time < "${exclusiveEnd}"`;
  const sessions: unknown[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_SLEEP_PAGES; page += 1) {
    const params = new URLSearchParams({
      dataSourceFamily: WEARABLE_FAMILY,
      pageSize: String(SLEEP_PAGE_SIZE),
      filter,
    });
    if (pageToken) params.set('pageToken', pageToken);
    const payload = await api.get(`/users/me/dataTypes/sleep/dataPoints:reconcile?${params.toString()}`);
    if (!isRecord(payload)) return sessions;
    if (Array.isArray(payload.dataPoints)) sessions.push(...payload.dataPoints);
    pageToken = typeof payload.nextPageToken === 'string' && payload.nextPageToken.length > 0 ? payload.nextPageToken : undefined;
    if (!pageToken) return sessions;
  }
  throw new HealthCallError('http', 'paging stopped before the sleep window was covered');
}
