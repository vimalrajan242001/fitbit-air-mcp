import { MAX_RECONCILE_DAYS, WEARABLE_FAMILY } from './constants.js';
import { assertRange, civilDateOf, intervalMinutes, parseDurationSeconds, readInterval, type Interval } from './dates.js';
import { expectHealthError } from './errors.js';
import { civilRangeFilter, reconcile, type HealthApi, type WearableResult } from './health.js';
import { isRecord, pickNumbers } from './parse.js';

/** Documented MetricsSummary fields kept as-is. No GPS, route, or heart-rate series. */
const METRICS = {
  ints: ['steps', 'averageHeartRateBeatsPerMinute', 'activeZoneMinutes'],
  numbers: ['caloriesKcal', 'distanceMillimeters', 'elevationGainMillimeters', 'averageSpeedMillimetersPerSecond', 'averagePaceSecondsPerMeter'],
} as const;

type MetricName = (typeof METRICS)['ints'][number] | (typeof METRICS)['numbers'][number];

export type ExerciseSession = {
  date: string;
  exerciseType: string;
  displayName?: string;
  interval: Interval;
  durationMinutes: number;
  /** From `activeDuration`, which excludes pauses. */
  activeMinutes?: number;
  metrics: Partial<Record<MetricName, number>>;
};

export type ExerciseResult = WearableResult & { sessions: ExerciseSession[] };

export async function readExerciseSessions(api: HealthApi, start: string, end: string): Promise<ExerciseResult> {
  assertRange(start, end, MAX_RECONCILE_DAYS);
  const range = { start, end };
  const result: ExerciseResult = { range, dataSourceFamily: WEARABLE_FAMILY, sessions: [], missing: [] };
  let points: unknown[];
  try {
    points = await reconcile(api, 'exercise', civilRangeFilter('exercise.interval.civil_start_time', range), 'paging stopped before the exercise window was covered');
  } catch (error) {
    result.missing.push({ series: 'exercise', reason: expectHealthError(error).message });
    return result;
  }
  for (const point of points) {
    const session = summarizeExercise(point);
    if (!session) {
      result.missing.push({ series: 'exercise', reason: 'exercise session interval could not be read' });
    } else if (session.date >= start && session.date <= end) {
      result.sessions.push(session);
    }
  }
  result.sessions.sort((left, right) => left.interval.startTime.localeCompare(right.interval.startTime));
  return result;
}

/** Builds a session from the documented fields only, or null when its type or interval cannot be read. */
export function summarizeExercise(point: unknown): ExerciseSession | null {
  const exercise = isRecord(point) ? point.exercise : undefined;
  if (!isRecord(exercise) || !isRecord(exercise.interval) || typeof exercise.exerciseType !== 'string') return null;
  const interval = readInterval(exercise.interval);
  const durationMinutes = interval && intervalMinutes(interval);
  const date = interval && civilDateOf(exercise.interval.civilStartTime, interval.startTime, interval.startUtcOffset);
  if (!interval || durationMinutes === null || !date) return null;

  const session: ExerciseSession = {
    date,
    exerciseType: exercise.exerciseType,
    interval,
    durationMinutes,
    metrics: pickNumbers(isRecord(exercise.metricsSummary) ? exercise.metricsSummary : {}, METRICS),
  };
  if (typeof exercise.displayName === 'string' && exercise.displayName.length > 0) session.displayName = exercise.displayName;
  const activeSeconds = parseDurationSeconds(exercise.activeDuration);
  if (activeSeconds !== undefined) session.activeMinutes = Math.round(activeSeconds / 60);
  return session;
}
