import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { comparePeriods, readDailyActivity } from './activity.js';
import { SERVER_VERSION } from './constants.js';
import { readSyncStatus } from './devices.js';
import { isRecord } from './errors.js';
import { createHealthApi } from './health.js';
import { defaultConfigDir } from './paths.js';
import { redact, textResult } from './redact.js';
import { readSleepNights } from './sleep.js';
import { connectionStatus } from './status.js';
import { loginWarning, type TokenDeps } from './tokens.js';
import { readToday } from './today.js';

const dateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

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
      snapshot = { missing: [{ reason: errorMessage(error) }] };
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
        'Daily wearable rollups for steps (countSum), distance (millimetersSum, plus kilometers), active zone minutes, active minutes, and total calories (kcalSum). Dates are inclusive civil days, at most 7. A day with no wearable samples is missing, not zero.',
      inputSchema: z.object({
        start: dateField.describe('Inclusive civil start date, YYYY-MM-DD'),
        end: dateField.optional().describe('Inclusive civil end date, YYYY-MM-DD. Defaults to start.'),
      }),
    },
    run(deps, ({ start, end }) => readDailyActivity(api, start, end ?? start)),
  );

  server.registerTool(
    'sleep_nights',
    {
      description:
        'Wearable sleep sessions whose civil end date falls in the inclusive range, at most 31 days. In-bed minutes come from the session interval. inBedHours and hoursAsleep repeat those minutes in hours. Asleep, stage minutes, and short awakenings come from the documented summary fields. Stage intervals are included only when detail is true and the range is one night. This is not a Sleep Score and not a diagnosis.',
      inputSchema: z.object({
        start: dateField.describe('Inclusive civil start date, YYYY-MM-DD'),
        end: dateField.optional().describe('Inclusive civil end date, YYYY-MM-DD. Defaults to start.'),
        detail: z.boolean().optional().describe('Include stage intervals. Honored only for a single night.'),
      }),
    },
    run(deps, ({ start, end, detail }) => readSleepNights(api, start, end ?? start, detail ?? false)),
  );

  server.registerTool(
    'compare_periods',
    {
      description:
        'Run daily_activity for two inclusive ranges and return both results and the deltas of the sums (period B minus period A). Units are unchanged: step counts, millimeters, kilocalories, and active-zone-minute sums. daysWithData gives the days per series that have data in each period; when they differ, compare per-day averages, not the deltas.',
      inputSchema: z.object({
        periodA: z.object({ start: dateField, end: dateField }),
        periodB: z.object({ start: dateField, end: dateField }),
      }),
    },
    run(deps, ({ periodA, periodB }) => comparePeriods(api, periodA, periodB)),
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
      return { isError: true as const, content: [{ type: 'text' as const, text: errorMessage(error) }] };
    }
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The tool failed.';
}
