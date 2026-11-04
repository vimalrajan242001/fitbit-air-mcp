import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { readDailyActivity } from './activity.js';
import { SERVER_VERSION } from './constants.js';
import type { DateRange } from './dates.js';
import { readSyncStatus } from './devices.js';
import { errorMessage } from './errors.js';
import { readExerciseSessions } from './exercise.js';
import { readFitnessAge } from './fitnessAge.js';
import { createHealthApi } from './health.js';
import { defaultConfigDir } from './paths.js';
import { readRecoveryDays } from './recovery.js';
import { isRecord } from './parse.js';
import { redact, textResult } from './redact.js';
import { readSleepNights } from './sleep.js';
import { connectionStatus } from './status.js';
import { loginWarning, type TokenDeps } from './tokens.js';
import { readToday } from './today.js';
import { readActivityWeeks, readSleepWeeks } from './trends.js';

const dateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

/** Input fields shared by every ranged tool. */
const dateRangeFields = {
  start: dateField.describe('Inclusive civil start date, YYYY-MM-DD'),
  end: dateField.optional().describe('Inclusive civil end date, YYYY-MM-DD. Defaults to start.'),
};
const granularityField = z.enum(['day', 'week']).optional().describe('"day" (default) or "week" for trends over up to 91 days.');

/** A one-day read when `end` is left out. */
function rangeOf({ start, end }: { start: string; end?: string }): DateRange {
  return { start, end: end ?? start };
}

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

  async function today() {
    let snapshot: unknown;
    try {
      snapshot = redact(withLoginWarning(deps, await readToday(api, deps.now())));
    } catch (error) {
      snapshot = { missing: [{ reason: errorMessage(error, 'The tool failed.') }] };
    }
    return { uri: 'fitbit://today', mimeType: 'application/json', text: JSON.stringify(snapshot, null, 2) };
  }

  server.registerTool(
    'connection_status',
    {
      description:
        'Report whether the Google Health account is linked, which scopes were granted, when the access token expires, and when Testing-mode login is due. Does not return tokens or the OAuth client.',
      inputSchema: z.object({}),
    },
    run(deps, () => connectionStatus(deps.configDir, api, deps.now(), deps.remote)),
  );

  server.registerTool(
    'sync_status',
    {
      description:
        'List paired trackers with product name, battery, last sync time, and feature flags. The hardware address is removed before this result is built.',
      inputSchema: z.object({}),
    },
    run(deps, () => readSyncStatus(api)),
  );

  server.registerTool(
    'daily_activity',
    {
      description:
        'Daily wearable rollups for steps (countSum), distance (millimetersSum, plus kilometers), active zone minutes, active minutes, and total calories (kcalSum). Dates are inclusive civil days, at most 7. A day with no wearable samples is missing, not zero. Other values stay in the API units. With granularity "week" the range may be up to 91 days: it returns 7-day weeks from start with per-day averages and daysWithData (no per-day rows), plus a baseline of the median and 25th-75th percentile range over the last 28 days. Use it for trends and for comparing periods; describe values against the baseline, never as a score or diagnosis.',
      inputSchema: z.object({ ...dateRangeFields, granularity: granularityField }),
    },
    run(deps, (args) => {
      const { start, end } = rangeOf(args);
      return args.granularity === 'week' ? readActivityWeeks(api, start, end) : readDailyActivity(api, start, end);
    }),
  );

  server.registerTool(
    'sleep_nights',
    {
      description:
        'Wearable sleep sessions whose civil end date falls in the inclusive range, at most 31 days. In-bed minutes come from the session interval. inBedHours and hoursAsleep repeat those minutes in hours. Asleep, stage minutes, and short awakenings come from the documented summary fields. Stage intervals are included only when detail is true and the range is one night. With granularity "week" the range may be up to 91 days: the longest session per date is the main sleep and the others are counted as naps; each 7-day week has average asleep and in-bed minutes, the median local bedtime, and its spread (25th-75th percentile, minutes), plus a 28-day baseline. Main sleep is wrong when a nap outlasts a broken night. This is not a Sleep Score and not a diagnosis.',
      inputSchema: z.object({
        ...dateRangeFields,
        detail: z.boolean().optional().describe('Include stage intervals. Honored only for a single night.'),
        granularity: granularityField,
      }),
    },
    run(deps, (args) => {
      const { start, end } = rangeOf(args);
      return args.granularity === 'week' ? readSleepWeeks(api, start, end) : readSleepNights(api, start, end, args.detail ?? false);
    }),
  );

  server.registerTool(
    'recovery_day',
    {
      description:
        'Daily wearable recovery values for an inclusive civil range, at most 31 days: resting heart rate (beatsPerMinute), heart rate variability (average RMSSD and deep-sleep RMSSD in milliseconds, non-REM heart rate, entropy), overnight oxygen saturation (average, confidence bounds, and standard deviation in percent), and daily VO2 max (vo2Max in ml/kg/min, estimated, and cardioFitnessLevel as the API labels it). A day with no samples is missing, not zero. Values stay in the API units. Descriptive only: not a score and not a diagnosis.',
      inputSchema: z.object(dateRangeFields),
    },
    run(deps, (args) => {
      const { start, end } = rangeOf(args);
      return readRecoveryDays(api, start, end);
    }),
  );

  server.registerTool(
    'fitness_age',
    {
      description:
        'Equivalent ages: the age at which a typical person of the same sex has your median daily VO2 max (FRIEND registry treadmill medians, needs 3 days) and, separately and with low confidence, your median overnight HRV (RMSSD, needs 7 nights). Each part lists its inputs and source; a part without enough data is missing, never guessed. No combined number. The window is at most 31 days and defaults to the 30 days ending today in the account time zone. Descriptive, not a score and not a diagnosis.',
      inputSchema: z.object({
        start: dateField.optional().describe('Inclusive civil start date, YYYY-MM-DD. Defaults to 29 days before end.'),
        end: dateField.optional().describe('Inclusive civil end date, YYYY-MM-DD. Defaults to today in the account time zone.'),
        age: z.number().int().min(1).max(120).optional().describe('Age in years, shown next to the equivalent ages.'),
        birthYear: z.number().int().min(1900).max(2100).optional().describe('Used for the shown age when age is not given.'),
        sex: z.enum(['male', 'female', 'unspecified']).optional().describe('Reference curve. "unspecified" (default) averages the male and female curves.'),
      }),
    },
    run(deps, (args) => readFitnessAge(api, deps.now(), args)),
  );

  server.registerTool(
    'exercise_sessions',
    {
      description:
        'Wearable exercise sessions whose civil start date falls in the inclusive range, at most 31 days: type, name, interval, duration and active minutes, and summary metrics (steps, calories in kcal, distance and elevation gain in millimeters, average heart rate, active zone minutes, average speed and pace). No GPS or route data.',
      inputSchema: z.object(dateRangeFields),
    },
    run(deps, (args) => {
      const { start, end } = rangeOf(args);
      return readExerciseSessions(api, start, end);
    }),
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
    async () => ({ contents: [await today()] }),
  );

  // The snapshot is embedded because many clients do not let the model read resources itself.
  for (const [name, title, description, text] of PROMPTS) {
    server.registerPrompt(name, { title, description }, async () => ({
      messages: [
        { role: 'user' as const, content: { type: 'resource' as const, resource: await today() } },
        { role: 'user' as const, content: { type: 'text' as const, text } },
      ],
    }));
  }

  return server;
}

const PROMPT_RULES =
  'A date listed in missing has no wearable data; say so, do not treat it as zero. Describe what the numbers show in plain words. Do not give a Sleep Score, a medical diagnosis, or advice framed as treatment. If a result has loginWarning, mention it first.';

const PROMPTS = [
  [
    'weekly_review',
    'Weekly review',
    'Review the last 7 full days of activity and sleep.',
    `The attached fitbit://today snapshot gives today's date. Call daily_activity and sleep_nights for the 7 days ending yesterday. Summarize steps, kilometers, active zone minutes, and sleep hours as daily averages over the days that have data, and name the best and lowest day. ${PROMPT_RULES}`,
  ],
  [
    'sleep_check',
    'Sleep check',
    'Compare last night with the week before it.',
    `The attached fitbit://today snapshot gives today's date. Call sleep_nights for today and the 7 days before it. Compare last night's hours asleep, stage minutes, and bedtime with the other nights. Several sessions on one date usually mean a nap; report naps apart from the main sleep. ${PROMPT_RULES}`,
  ],
] as const;

/** Adds loginWarning to an object result when Testing-mode login is close. */
function withLoginWarning(deps: TokenDeps, value: unknown): unknown {
  const warning = loginWarning(deps);
  return warning && isRecord(value) ? { ...value, loginWarning: warning } : value;
}

/** Every tool reports a thrown error the same way: an isError result, never an SDK-formatted exception. */
function run<Args>(deps: TokenDeps, read: (args: Args) => Promise<unknown>) {
  return async (args: Args) => {
    try {
      return textResult(withLoginWarning(deps, await read(args)));
    } catch (error) {
      return { isError: true as const, content: [{ type: 'text' as const, text: errorMessage(error, 'The tool failed.') }] };
    }
  };
}
