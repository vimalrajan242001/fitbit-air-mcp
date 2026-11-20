import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Usage: node scripts/run-tests.mjs [--node-test-flag ...] [test/file.test.ts ...]
// Flags (e.g. --test-reporter=spec, --experimental-test-coverage) go to node; with no files, every test/*.test.ts runs.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flags = args.filter((arg) => arg.startsWith('--'));
const named = args.filter((arg) => !arg.startsWith('--'));
const files =
  named.length > 0
    ? named
    : readdirSync(join(root, 'test'))
        .filter((name) => name.endsWith('.test.ts'))
        .sort()
        .map((name) => join('test', name));

const result = spawnSync(process.execPath, [join(root, 'node_modules/tsx/dist/cli.mjs'), '--test', ...flags, ...files], {
  cwd: root,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
