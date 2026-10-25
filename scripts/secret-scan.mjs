import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dirname, '..');
const secretPrefix = 'GOC' + 'SPX-';
const skipDirectories = new Set(['.git', 'node_modules', 'dist', 'coverage']);
const valuePatterns = [
  /"refresh_token"\s*:\s*"[^"]{8,}"/,
  /"refreshToken"\s*:\s*"[^"]{8,}"/,
  /"access_token"\s*:\s*"[^"]{8,}"/,
  /"accessToken"\s*:\s*"[^"]{8,}"/,
  /"client_secret"\s*:\s*"[^"]{8,}"/,
  /"clientSecret"\s*:\s*"[^"]{8,}"/,
  /ya29\.[0-9A-Za-z_-]+/,
];

const failures = [];

function walk(directory) {
  for (const name of readdirSync(directory)) {
    if (skipDirectories.has(name)) continue;
    const path = join(directory, name);
    const info = statSync(path);
    if (info.isDirectory()) {
      walk(path);
      continue;
    }
    const rel = relative(root, path);
    if (name === 'tokens.json' || rel.endsWith('/tokens.json')) failures.push(`${rel} is a token file`);
    if (info.size > 1_000_000) continue;
    const text = readFileSync(path, 'utf8');
    if (text.includes(secretPrefix)) failures.push(`${rel} contains a client secret prefix`);
    for (const pattern of valuePatterns) {
      if (pattern.test(text)) failures.push(`${rel} matches ${pattern}`);
    }
  }
}

walk(root);

try {
  const listed = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  for (const file of listed.split('\n')) {
    if (file === 'tokens.json' || file.endsWith('/tokens.json')) failures.push(`tracked token file ${file}`);
  }
} catch {
  // A brand-new tree may not have a commit yet.
}

try {
  const history = execFileSync('git', ['log', '-p', '--all', '-S', secretPrefix], { cwd: root, encoding: 'utf8' });
  if (history.includes(secretPrefix)) failures.push('git history contains a client secret prefix');
} catch (error) {
  if (error && typeof error === 'object' && 'status' in error && error.status !== 1) {
    throw error;
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
