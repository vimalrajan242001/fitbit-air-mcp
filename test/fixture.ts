import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { HealthApi } from '../src/health.js';

const directory = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(directory, name), 'utf8')) as Record<string, unknown>;
}

export type RecordedCall = { method: 'GET' | 'POST'; path: string; body?: unknown };

export function fakeHealthApi(
  handler: (method: 'GET' | 'POST', path: string, body: unknown, calls: RecordedCall[]) => unknown,
): HealthApi & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async get(path: string) {
      calls.push({ method: 'GET', path });
      return handler('GET', path, undefined, calls);
    },
    async post(path: string, body: unknown) {
      calls.push({ method: 'POST', path, body });
      return handler('POST', path, body, calls);
    },
  };
}
