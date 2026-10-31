import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { comparePeriods, readDailyActivity } from './activity.js';
import { readSyncStatus } from './devices.js';
import { createHealthApi } from './health.js';
import { defaultConfigDir } from './paths.js';
import { redact, textResult } from './redact.js';
import { readSleepNights } from './sleep.js';
import { connectionStatus } from './status.js';
import type { TokenDeps } from './tokens.js';
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
  const server = new McpServer({ name: 'fitbit-air', version: '0.1.0' });

  server.registerTool(
    'connection_status',
    {
      description:
        'Report whether the Google Health account is linked, which scopes were granted, when the access token expires, and when Testing-mode login is due. Does not return tokens or the OAuth client.',
      inputSchema: z.object({}),
    },
    async () => textResult(await connectionStatus(deps.configDir, api, deps.now(), deps.remote)),
  );

  server.registerTool(
    'sync_status',
    {
      description:
        'List paired trackers with product name, battery, last sync time, and feature flags. The hardware address is removed before this result is built.',
      inputSchema: z.object({}),
    },
    async () => textResult(await readSyncStatus(api)),
  );

  server.registerTool(
    'daily_activity',
    {
      description:
        'Daily wearable rollups for steps (countSum), distance (millimetersSum), active zone minutes, active minutes, and total calories (kcalSum). Dates are inclusive civil days, at most 7. A day with no wearable samples is missing, not zero. Values stay in the API units.',
      inputSchema: z.object({
        start: dateField.describe('Inclusive civil start date, YYYY-MM-DD'),
        end: dateField.optional().describe('Inclusive civil end date, YYYY-MM-DD. Defaults to start.'),
      }),
    },
    async ({ start, end }) => {
      try {
        return textResult(await readDailyActivity(api, start, end ?? start));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'sleep_nights',
    {
      description:
        'Wearable sleep sessions whose civil end date falls in the inclusive range. In-bed minutes come from the session interval. Asleep, stage minutes, and short awakenings come from the documented summary fields. Stage intervals are included only when detail is true and the range is one night. This is not a Sleep Score and not a diagnosis.',
      inputSchema: z.object({
        start: dateField.describe('Inclusive civil start date, YYYY-MM-DD'),
        end: dateField.optional().describe('Inclusive civil end date, YYYY-MM-DD. Defaults to start.'),
        detail: z.boolean().optional().describe('Include stage intervals. Honored only for a single night.'),
      }),
    },
    async ({ start, end, detail }) => {
      try {
        return textResult(await readSleepNights(api, start, end ?? start, detail ?? false));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'compare_periods',
    {
      description:
        'Run daily_activity for two inclusive ranges and return both totals and the deltas (period B minus period A). Units are unchanged: step counts, millimeters, kilocalories, and active-zone-minute sums.',
      inputSchema: z.object({
        periodA: z.object({ start: dateField, end: dateField }),
        periodB: z.object({ start: dateField, end: dateField }),
      }),
    },
    async ({ periodA, periodB }) => {
      try {
        return textResult(await comparePeriods(api, periodA, periodB));
      } catch (error) {
        return toolError(error);
      }
    },
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
      const snapshot = redact(await readToday(api, deps.now()));
      const href = typeof uri === 'string' ? uri : uri.href;
      return {
        contents: [{ uri: href, mimeType: 'application/json', text: JSON.stringify(snapshot, null, 2) }],
      };
    },
  );

  return server;
}

function toolError(error: unknown): { isError: true; content: [{ type: 'text'; text: string }] } {
  const message = error instanceof Error ? error.message : 'The tool failed.';
  return { isError: true, content: [{ type: 'text', text: message }] };
}
