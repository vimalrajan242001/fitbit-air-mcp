import type { ClientRegistrationCallbackOptions } from '@cloudflare/workers-oauth-provider';

import { HealthCallError, isRecord } from './errors.js';
import { createHealthApi } from './health.js';
import type { TokenFile } from './tokens.js';

/** Clients that may register: HTTPS callbacks on these hosts, or loopback apps such as Claude Code. */
const REDIRECT_HOSTS = new Set(['claude.ai', 'claude.com', 'chatgpt.com']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Why this Google account may not use the Worker, or undefined for the owner. */
export async function ownerRefusal(tokens: TokenFile, owner: string | undefined, fetchImpl: typeof fetch): Promise<string | undefined> {
  const api = createHealthApi({ configDir: '/', fetchImpl, now: () => new Date(), remote: tokens });
  let identity: unknown;
  try {
    identity = await api.get('/users/me/identity');
  } catch (error) {
    return error instanceof HealthCallError ? error.message : 'The identity check failed.';
  }
  const id = isRecord(identity) && typeof identity.healthUserId === 'string' ? identity.healthUserId : '';
  if (!id) return 'The identity check returned no healthUserId.';
  if (!owner) return `OWNER_HEALTH_USER_ID is not set. If this is your account, run: npx wrangler secret put OWNER_HEALTH_USER_ID and enter ${id}`;
  return id === owner ? undefined : 'This Google account is not the owner of this server.';
}

/** Refuses a client whose web redirect goes anywhere but an allowed host or loopback. */
export function clientRegistrationCallback({ clientMetadata }: ClientRegistrationCallbackOptions) {
  const uris = Array.isArray(clientMetadata.redirect_uris) ? clientMetadata.redirect_uris : [];
  for (const uri of uris) {
    let url: URL;
    try {
      url = new URL(String(uri));
    } catch {
      return { description: 'redirect_uri is not a URL' };
    }
    // Private-use schemes (cursor://) are refused by the library at /authorize, so they cannot carry a token.
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    if (LOOPBACK_HOSTS.has(url.hostname)) continue;
    if (url.protocol === 'https:' && REDIRECT_HOSTS.has(url.hostname)) continue;
    return { description: `redirect host ${url.hostname} is not allowed`, status: 403 };
  }
  return undefined;
}
