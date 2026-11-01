import { MAX_SLEEP_DAYS, MAX_SLEEP_PAGES, WEARABLE_FAMILY } from './constants.js';
import { addCivilDays, assertRange, civilDateOf, parseDurationSeconds, readFinite, readInt } from './dates.js';
import { HealthCallError, isRecord, type Missing } from './errors.js';
import { reconcile, type HealthApi } from './health.js';

/** Documented MetricsSummary fields kept as-is. No GPS, route, or heart-rate series. */
const INT_METRICS = ['steps', 'averageHeartRateBeatsPerMinute', 'activeZoneMinutes'] as const;
const NUMBER_METRICS = [
  'caloriesKcal',
  'distanceMillimeters',
  'elevationGainMillimeters',
  'averageSpeedMillimetersPerSecond',
  'averagePaceSecondsPerMeter',
] as const;

export type ExerciseSession = {
  date: string;
  exerciseType: string;
  displayName?: string;
  interval: { startTime: string; endTime: string; startUtcOffset?: string; endUtcOffset?: string };
  durationMinutes: number;
  /** From `activeDuration`, which excludes pauses. */
  activeMinutes?: number;
  metrics: Partial<Record<(typeof INT_METRICS)[number] | (typeof NUMBER_METRICS)[number], number>>;
};

export type ExerciseResult = {
  range: { start: string; end: string };
  dataSourceFamily: typeof WEARABLE_FAMILY;
  sessions: ExerciseSession[];
  missing: Missing[];
};

export async function readExerciseSessions(api: HealthApi, start: string, end: string): Promise<ExerciseResult> {
  assertRange(start, end, MAX_SLEEP_DAYS);
  const range = { start, end };
  const filter = `exercise.interval.civil_start_time >= "${start}" AND exercise.interval.civil_start_time < "${addCivilDays(end, 1)}"`;
  let points: unknown[];
  try {
    points = await reconcile(api, 'exercise', filter, MAX_SLEEP_PAGES, 'paging stopped before the exercise window was covered');
  } catch (error) {
    if (error instanceof HealthCallError) {
      return { range, dataSourceFamily: WEARABLE_FAMILY, sessions: [], missing: [{ series: 'exercise', reason: error.message }] };
    }
    throw error;
  }
  const missing: Missing[] = [];
  const sessions: ExerciseSession[] = [];
  for (const point of points) {
    const session = summarizeExercise(point);
    if (!session) {
      missing.push({ series: 'exercise', reason: 'exercise session interval could not be read' });
      continue;
    }
    if (session.date >= start && session.date <= end) sessions.push(session);
  }
  sessions.sort((left, right) => left.interval.startTime.localeCompare(right.interval.startTime));
  return { range, dataSourceFamily: WEARABLE_FAMILY, sessions, missing };
}

export function summarizeExercise(point: unknown): ExerciseSession | null {
  const exercise = isRecord(point) ? point.exercise : undefined;
  if (!isRecord(exercise) || !isRecord(exercise.interval) || typeof exercise.exerciseType !== 'string') return null;
  const { interval } = exercise;
  if (typeof interval.startTime !== 'string' || typeof interval.endTime !== 'string') return null;
  const startMs = Date.parse(interval.startTime);
  const endMs = Date.parse(interval.endTime);
  const date = civilDateOf(interval.civilStartTime, interval.startTime, interval.startUtcOffset);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs || !date) return null;
  const summary = isRecord(exercise.metricsSummary) ? exercise.metricsSummary : {};
  const metrics: ExerciseSession['metrics'] = {};
  for (const key of INT_METRICS) {
    const read = readInt(summary[key]);
    if (read !== undefined) metrics[key] = read;
  }
  for (const key of NUMBER_METRICS) {
    const read = readFinite(summary[key]);
    if (read !== undefined) metrics[key] = read;
  }
  const session: ExerciseSession = {
    date,
    exerciseType: exercise.exerciseType,
    interval: {
      startTime: interval.startTime,
      endTime: interval.endTime,
      ...(typeof interval.startUtcOffset === 'string' ? { startUtcOffset: interval.startUtcOffset } : {}),
      ...(typeof interval.endUtcOffset === 'string' ? { endUtcOffset: interval.endUtcOffset } : {}),
    },
    durationMinutes: Math.round((endMs - startMs) / 60_000),
    metrics,
  };
  if (typeof exercise.displayName === 'string' && exercise.displayName.length > 0) session.displayName = exercise.displayName;
  const activeSeconds = parseDurationSeconds(exercise.activeDuration);
  if (activeSeconds !== undefined) session.activeMinutes = Math.round(activeSeconds / 60);
  return session;
}
