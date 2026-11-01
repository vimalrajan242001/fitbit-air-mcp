import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

import { ACCESS_TOKEN_SKEW_MS, LOGIN_WARNING_MS, OAUTH_TOKEN_URL, TESTING_REFRESH_MS } from './constants.js';
import { loadOAuthClient, type OAuthClient } from './env.js';
import { HealthCallError, findReason, sanitizeText } from './errors.js';
import { isRecord, readJsonBody } from './parse.js';
import { tokenPath } from './paths.js';

export type TokenFile = {
  accessToken: string;
  expiry: string;
  refreshToken: string;
  scopes: string[];
  refreshObtainedAt: string;
};

const chains = new Map<string, Promise<unknown>>();

/** Runs tasks with the same key one at a time, so two reads never refresh the same token file at once. */
export function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  chains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

export function loginDeadline(refreshObtainedAt: string): string {
  const parsed = Date.parse(refreshObtainedAt);
  if (Number.isNaN(parsed)) {
    throw new Error('The token file has an unreadable refresh time. Run npm run login again.');
  }
  return new Date(parsed + TESTING_REFRESH_MS).toISOString();
}

export function loginIsDue(tokens: Pick<TokenFile, 'refreshObtainedAt'>, now: Date): boolean {
  return now.getTime() >= Date.parse(loginDeadline(tokens.refreshObtainedAt));
}

/** A reminder once the Testing-mode refresh token is within LOGIN_WARNING_MS of its deadline. Never throws. */
export function loginWarning(deps: Pick<TokenDeps, 'configDir' | 'now' | 'remote'>): string | undefined {
  try {
    const tokens = deps.remote ?? readTokenFile(deps.configDir);
    if (!tokens) return undefined;
    const dueAt = loginDeadline(tokens.refreshObtainedAt);
    if (Date.parse(dueAt) - deps.now().getTime() > LOGIN_WARNING_MS) return undefined;
    return `Google access ends at ${dueAt} (Testing mode). Sign in again before then; locally run npm run login.`;
  } catch {
    return undefined;
  }
}

export function readTokenFile(configDir: string): TokenFile | null {
  const file = tokenPath(configDir);
  if (!existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    throw new Error('The token file is not valid JSON. Run npm run login again.');
  }
  if (!isTokenFile(parsed)) {
    throw new Error('The token file is missing required fields. Run npm run login again.');
  }
  return parsed;
}

export function writeTokenFile(configDir: string, tokens: TokenFile): void {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(configDir, 0o700);
  } catch {
    // The directory may live on a filesystem that ignores POSIX modes.
  }
  const file = tokenPath(configDir);
  // Write then rename, so a crash or a second process never sees a half-written file.
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(tokens, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, file);
  chmodSync(file, 0o600);
}

export function isTokenFile(value: unknown): value is TokenFile {
  if (!isRecord(value)) return false;
  return (
    typeof value.accessToken === 'string' &&
    value.accessToken.length > 0 &&
    typeof value.expiry === 'string' &&
    typeof value.refreshToken === 'string' &&
    value.refreshToken.length > 0 &&
    Array.isArray(value.scopes) &&
    value.scopes.every((scope) => typeof scope === 'string') &&
    typeof value.refreshObtainedAt === 'string'
  );
}

/** A token handed in by the remote host instead of the local token file. */
export type RemoteToken = Omit<TokenFile, 'refreshToken'>;

export type TokenDeps = {
  configDir: string;
  fetchImpl: typeof fetch;
  now: () => Date;
  force?: boolean;
  remote?: RemoteToken;
};

/** A usable access token from the token file, refreshing and saving it when it is near expiry or `force` is set. */
export async function getAccessToken(deps: TokenDeps): Promise<string> {
  return enqueue(deps.configDir, async () => {
    const current = readTokenFile(deps.configDir);
    if (!current) throw new HealthCallError('no_token', 'no local token file');
    const now = deps.now();
    const fresh = !deps.force && Date.parse(current.expiry) - now.getTime() > ACCESS_TOKEN_SKEW_MS;
    if (fresh) return current.accessToken;
    if (loginIsDue(current, now)) throw new HealthCallError('login_due', 'login due');
    const next = await refreshAccessToken(current, loadOAuthClient(deps.configDir), deps.fetchImpl, now);
    writeTokenFile(deps.configDir, next);
    return next.accessToken;
  });
}

export async function refreshAccessToken(current: TokenFile, client: OAuthClient, fetchImpl: typeof fetch, now: Date): Promise<TokenFile> {
  const { response, payload } = await postTokenEndpoint(fetchImpl, {
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: current.refreshToken,
    grant_type: 'refresh_token',
  });
  if (!response.ok) {
    const reason = findReason(payload);
    if (reason === 'invalid_grant') throw new HealthCallError('login_due', 'login due');
    throw new HealthCallError('http', oauthFailureMessage(payload, response.status, [client.clientSecret, current.refreshToken]));
  }
  return tokenFileFromResponse(payload, {
    now,
    previous: current,
    requireRefreshToken: false,
  });
}

/** Validates a token response. A new refresh token restarts the 7-day clock; otherwise the previous one is kept. */
export function tokenFileFromResponse(
  payload: unknown,
  options: { now: Date; previous?: TokenFile; requireRefreshToken: boolean },
): TokenFile {
  if (!isRecord(payload) || typeof payload.access_token !== 'string' || payload.access_token.length === 0) {
    throw new Error('Token response did not include an access token.');
  }
  if (typeof payload.expires_in !== 'number' || !Number.isFinite(payload.expires_in)) {
    throw new Error('Token response did not include expires_in.');
  }
  let refreshToken = options.previous?.refreshToken;
  let refreshObtainedAt = options.previous?.refreshObtainedAt;
  if (typeof payload.refresh_token === 'string' && payload.refresh_token.length > 0) {
    if (payload.refresh_token !== refreshToken) {
      refreshObtainedAt = options.now.toISOString();
    }
    refreshToken = payload.refresh_token;
  }
  if (!refreshToken || !refreshObtainedAt || (options.requireRefreshToken && typeof payload.refresh_token !== 'string')) {
    throw new Error('Google did not return a refresh token. Run npm run login again and accept the consent screen.');
  }
  const scopes =
    typeof payload.scope === 'string'
      ? payload.scope.split(/\s+/).filter((scope) => scope.length > 0)
      : (options.previous?.scopes ?? []);
  return {
    accessToken: payload.access_token,
    expiry: new Date(options.now.getTime() + payload.expires_in * 1000).toISOString(),
    refreshToken,
    scopes,
    refreshObtainedAt,
  };
}

/** POSTs a form to Google's token endpoint and returns the response with its parsed JSON body. */
export async function postTokenEndpoint(fetchImpl: typeof fetch, form: Record<string, string>): Promise<{ response: Response; payload: unknown }> {
  const response = await fetchImpl(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form),
  });
  const payload = await readJsonBody(response, () => new Error(`The token endpoint returned a non-JSON response (HTTP ${response.status}).`));
  return { response, payload };
}

/** A sanitized failure message, or the bare `redirect_uri_mismatch` marker the caller maps to setup help. */
export function oauthFailureMessage(payload: unknown, status: number, secrets: string[]): string {
  const reason = findReason(payload);
  const description =
    isRecord(payload) && typeof payload.error_description === 'string' ? payload.error_description : '';
  const detail = sanitizeText(description || reason || '', secrets);
  if (reason === 'redirect_uri_mismatch' || detail.includes('redirect_uri_mismatch')) {
    return 'redirect_uri_mismatch';
  }
  if (detail) return `Token request failed (${detail}).`;
  return `Token request failed (HTTP ${status}).`;
}
