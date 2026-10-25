import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

test('AGENTS.md stays short and source stays free of stdout logs and the legacy host', () => {
  const agents = readFileSync('AGENTS.md', 'utf8');
  assert.ok(agents.split('\n').length < 150);
  const files = sourceFiles('src');
  const combined = files.map((file) => readFileSync(file, 'utf8')).join('\n');
  assert.equal(combined.includes('console.log'), false);
  assert.equal(combined.includes('api.fitbit.com'), false);
  assert.equal(combined.includes('GOC' + 'SPX-'), false);
});

test('secret scan passes', () => {
  const result = spawnSync(process.execPath, ['scripts/secret-scan.mjs'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (name.endsWith('.ts')) found.push(path);
  }
  return found;
}
