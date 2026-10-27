import { chmodSync, readFileSync } from 'node:fs';

import { envPath } from './paths.js';

export type OAuthClient = {
  clientId: string;
  clientSecret: string;
};

export function loadOAuthClient(configDir: string): OAuthClient {
  const file = envPath(configDir);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`Missing env file at ${file}. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.`);
  }
  const values = parseEnv(text);
  const clientId = values.get('GOOGLE_OAUTH_CLIENT_ID') ?? '';
  const clientSecret = values.get('GOOGLE_OAUTH_CLIENT_SECRET') ?? '';
  if (!clientId || !clientSecret) {
    throw new Error(`Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in ${file}.`);
  }
  if (
    clientId.includes('your-google-oauth-client-id') ||
    clientId.startsWith('<') ||
    clientSecret.includes('your-google-oauth-client-secret') ||
    clientSecret.startsWith('<')
  ) {
    throw new Error(`Replace placeholder credentials with your Google OAuth client ID and secret in ${file}.`);
  }
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows ACLs may refuse a POSIX mode. The token file is still written as 0600.
  }
  return { clientId, clientSecret };
}

export function parseEnv(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
}
