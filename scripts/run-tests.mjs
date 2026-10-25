import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const extra = process.argv.slice(2);
const files =
  extra.length > 0
    ? extra
    : readdirSync(join(root, 'test'))
        .filter((name) => name.endsWith('.test.ts'))
        .sort()
        .map((name) => join('test', name));

const result = spawnSync(process.execPath, [join(root, 'node_modules/tsx/dist/cli.mjs'), '--test', ...files], {
  cwd: root,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
