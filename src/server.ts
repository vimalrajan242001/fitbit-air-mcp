import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { readDailyActivity } from './activity.js';
import { SERVER_VERSION } from './constants.js';
import { readSyncStatus } from './devices.js';
import { readExerciseSessions } from './exercise.js';
import { createHealthApi } from './health.js';
import { defaultConfigDir } from './paths.js';
import { readRecoveryDays } from './recovery.js';
import { redact, textResult } from './redact.js';
import { readSleepNights } from './sleep.js';
import { connectionStatus } from './status.js';
import type { TokenDeps } from './tokens.js';
import { readToday } from './today.js';
import { readActivityWeeks, readSleepWeeks } from './trends.js';

const dateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const granularityField = z.enum(['day', 'week']).optional().describe('"day" (default) or "week" for trends over up to 91 days.');

export type ServerDeps = Partial<Pick<TokenDeps, 'configDir' | 'fetchImpl' | 'now' | 'remote'>>;

export function createFitbitServer(partial: ServerDeps = {}): McpServer {
  const deps: TokenDeps = {
    configDir: partial.configDir ?? defaultConfigDir(),
    fetchImpl: partial.fetchImpl ?? globalThis.fetch,
    now: partial.now ?? (() => new Date()),
    remote: partial.remote,
  };
  const api = createHealthApi(deps);
  const server = new McpServer({ name: 'fitbit-air', version: SERVER_VERSION });

  server.registerTool(
    'connection_status',
    {
      description:
        'Report whether the Google Health account is linked, which scopes were granted, when the access token expires, and when Testing-mode login is due. Does not return tokens or the OAuth client.',
      inputSchema: z.object({}),
    },
    run(() => connectionStatus(deps.configDir, api, deps.now(), deps.remote)),
  );

  server.registerTool(
    'sync_status',
    {
      description:
        'List paired trackers with product name, battery, last sync time, and feature flags. The hardware address is removed before this result is built.',
      inputSchema: z.object({}),
    },
    run(() => readSyncStatus(api)),
  );

  server.registerTool(
    'daily_activity',
    {
      description:
        'Daily wearable rollups for steps (countSum), distance (millimetersSum), active zone minutes, active minutes, and total calories (kcalSum). Dates are inclusive civil days, at most 7. A day with no wearable samples is missing, not zero. Values stay in the API units. With granularity "week" the range may be up to 91 days: it returns 7-day weeks from start with per-day averages and daysWithData (no per-day rows), plus a baseline of the median and 25th-75th percentile range over the last 28 days. Use it for trends and for comparing periods; describe values against the baseline, never as a score or diagnosis.',
      inputSchema: z.object({
        start: dateField.describe('Inclusive civil start date, YYYY-MM-DD'),
        end: dateField.optional().describe('Inclusive civil end date, YYYY-MM-DD. Defaults to start.'),
        granularity: granularityField,
      }),
    },
    run(({ start, end, granularity }) =>
      granularity === 'week' ? readActivityWeeks(api, start, end ?? start) : readDailyActivity(api, start, end ?? start),
    ),
  );

  server.registerTool(
    'sleep_nights',
    {
      description:
        'Wearable sleep sessions whose civil end date falls in the inclusive range, at most 31 days. In-bed minutes come from the session interval. Asleep, stage minutes, and short awakenings come from the documented summary fields. Stage intervals are included only when detail is true and the range is one night. With granularity "week" the range may be up to 91 days: the longest session per date is the main sleep and the others are counted as naps; each 7-day week has average asleep and in-bed minutes, the median local bedtime, and its spread (25th-75th percentile, minutes), plus a 28-day baseline. Main sleep is wrong when a nap outlasts a broken night. This is not a Sleep Score and not a diagnosis.',
      inputSchema: z.object({
        start: dateField.describe('Inclusive civil start date, YYYY-MM-DD'),
        end: dateField.optional().describe('Inclusive civil end date, YYYY-MM-DD. Defaults to start.'),
        detail: z.boolean().optional().describe('Include stage intervals. Honored only for a single night.'),
        granularity: granularityField,
      }),
    },
    run(({ start, end, detail, granularity }) =>
      granularity === 'week' ? readSleepWeeks(api, start, end ?? start) : readSleepNights(api, start, end ?? start, detail ?? false),
    ),
  );

  server.registerTool(
    'recovery_day',
    {
      description:
        'Daily wearable recovery values for an inclusive civil range, at most 31 days: resting heart rate (beatsPerMinute), heart rate variability (average RMSSD and deep-sleep RMSSD in milliseconds, non-REM heart rate, entropy), and overnight oxygen saturation (average, confidence bounds, and standard deviation in percent). A day with no samples is missing, not zero. Values stay in the API units. Descriptive only: not a score and not a diagnosis.',
      inputSchema: z.object({
        start: dateField.describe('Inclusive civil start date, YYYY-MM-DD'),
        end: dateField.optional().describe('Inclusive civil end date, YYYY-MM-DD. Defaults to start.'),
      }),
    },
    run(({ start, end }) => readRecoveryDays(api, start, end ?? start)),
  );

  server.registerTool(
    'exercise_sessions',
    {
      description:
        'Wearable exercise sessions whose civil start date falls in the inclusive range, at most 31 days: type, name, interval, duration and active minutes, and summary metrics (steps, calories in kcal, distance and elevation gain in millimeters, average heart rate, active zone minutes, average speed and pace). No GPS or route data.',
      inputSchema: z.object({
        start: dateField.describe('Inclusive civil start date, YYYY-MM-DD'),
        end: dateField.optional().describe('Inclusive civil end date, YYYY-MM-DD. Defaults to start.'),
      }),
    },
    run(({ start, end }) => readExerciseSessions(api, start, end ?? start)),
  );

  server.registerResource(
    'today',
    'fitbit://today',
    {
      title: 'Today',
      description:
        'Today in the account time zone: steps, active zone minutes, last night’s sleep summary, and last sync time. No tokens and no resting heart rate.',
      mimeType: 'application/json',
    },
    async (uri) => {
      let snapshot: unknown;
      try {
        snapshot = redact(await readToday(api, deps.now()));
      } catch (error) {
        snapshot = { missing: [{ reason: errorMessage(error) }] };
      }
      const href = typeof uri === 'string' ? uri : uri.href;
      return {
        contents: [{ uri: href, mimeType: 'application/json', text: JSON.stringify(snapshot, null, 2) }],
      };
    },
  );

  return server;
}

/** Every tool reports a thrown error the same way: an isError result, never an SDK-formatted exception. */
function run<Args>(read: (args: Args) => Promise<unknown>) {
  return async (args: Args) => {
    try {
      return textResult(await read(args));
    } catch (error) {
      return { isError: true as const, content: [{ type: 'text' as const, text: errorMessage(error) }] };
    }
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The tool failed.';
}
