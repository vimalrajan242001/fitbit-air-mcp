import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { createMcpHandler } from '@modelcontextprotocol/server';

import { SCOPES } from '../src/constants.js';
import { createFitbitServer } from '../src/server.js';
import type { RemoteToken } from '../src/tokens.js';
import { loadFixture } from './fixture.js';

const remote: RemoteToken = {
  accessToken: 'remote-access',
  expiry: '2026-03-04T13:00:00.000Z',
  scopes: [...SCOPES],
  refreshObtainedAt: '2026-03-01T00:00:00.000Z',
};

/** Drives the real MCP server in-process, the way the Worker does, and returns the JSON-RPC result. */
async function rpc(fetchImpl: typeof fetch, method: string, params: unknown = {}): Promise<Record<string, unknown>> {
  const handler = createMcpHandler(() => createFitbitServer({ configDir: '/nonexistent', fetchImpl, remote, now: () => new Date('2026-03-04T12:00:00.000Z') }));
  const response = await handler.fetch(
    new Request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  );
  const body = await response.text();
  const data = body.split('\n').find((line) => line.startsWith('data: '));
  assert.ok(data, body);
  const message = JSON.parse(data.slice('data: '.length)) as { result?: Record<string, unknown>; error?: unknown };
  assert.ok(message.result, JSON.stringify(message.error));
  return message.result;
}

const unreachable = (async () => {
  throw new Error('no network in this test');
}) as typeof fetch;

test('the tool, resource, and prompt contract clients see stays the same', async () => {
  const golden = JSON.parse(readFileSync(new URL('./fixtures/mcp-contract.json', import.meta.url), 'utf8')) as unknown;
  const tools = await rpc(unreachable, 'tools/list');
  const resources = await rpc(unreachable, 'resources/list');
  const prompts = await rpc(unreachable, 'prompts/list');
  assert.deepEqual({ tools: tools.tools, resources: resources.resources, prompts: prompts.prompts }, golden);
});

test('a tool that throws returns an isError result with the message', async () => {
  const result = await rpc(unreachable, 'tools/call', { name: 'daily_activity', arguments: { start: '2026-07-01', end: '2026-07-09' } });
  assert.deepEqual(result, { content: [{ type: 'text', text: 'This range is 9 days. This read covers at most 7 days.' }], isError: true });
});

test('sync_status over MCP drops the hardware address and sends the remote bearer', async () => {
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push(`${String(input)} ${new Headers(init?.headers).get('authorization')}`);
    return Response.json(loadFixture('paired-device.json'));
  }) as typeof fetch;
  const result = await rpc(fetchImpl, 'tools/call', { name: 'sync_status', arguments: {} });
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  assert.equal(text.includes('macAddress'), false);
  assert.equal(text.includes('00:11:22:33:44:55'), false);
  assert.deepEqual(JSON.parse(text), {
    devices: [{ deviceVersion: 'Charge 6', batteryLevel: 88, batteryStatus: 'High', lastSyncTime: '2026-03-04T07:05:00Z', features: ['STEPS', 'HEART_RATE'] }],
    missing: [],
  });
  assert.deepEqual(seen, ['https://health.googleapis.com/v4/users/me/pairedDevices?pageSize=100 Bearer remote-access']);
});

test('end defaults to start for a ranged tool', async () => {
  const filters: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    filters.push(new URL(String(input)).searchParams.get('filter') ?? '');
    return Response.json({ dataPoints: [] });
  }) as typeof fetch;
  await rpc(fetchImpl, 'tools/call', { name: 'exercise_sessions', arguments: { start: '2026-03-04' } });
  assert.deepEqual(filters, ['exercise.interval.civil_start_time >= "2026-03-04" AND exercise.interval.civil_start_time < "2026-03-05"']);
});

test('the today resource reports a failure as a missing entry instead of throwing', async () => {
  const result = await rpc(unreachable, 'resources/read', { uri: 'fitbit://today' });
  const [content] = result.contents as Array<{ uri: string; mimeType: string; text: string }>;
  assert.equal(content?.uri, 'fitbit://today');
  assert.equal(content?.mimeType, 'application/json');
  assert.deepEqual(JSON.parse(content!.text), { missing: [{ series: 'settings', reason: 'settings request failed' }] });
});

test('a prompt embeds the today snapshot before its instructions', async () => {
  const result = await rpc(unreachable, 'prompts/get', { name: 'weekly_review' });
  const [snapshot, instructions] = result.messages as Array<{ content: { resource?: { uri: string }; text?: string } }>;
  assert.equal(snapshot?.content.resource?.uri, 'fitbit://today');
  assert.match(instructions?.content.text ?? '', /daily_activity and sleep_nights/);
});
