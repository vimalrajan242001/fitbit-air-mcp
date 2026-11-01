import { setTimeout as delay } from 'node:timers/promises';

import { HEALTH_API_BASE } from './constants.js';
import { HealthCallError, errorStatusName, findReason, isRecord, sanitizeText } from './errors.js';
import { getAccessToken, type TokenDeps } from './tokens.js';

export type HealthApi = {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
};

const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

export function healthUrl(path: string): URL {
  if (!path.startsWith('/')) {
    throw new Error('Health API paths must start with /.');
  }
  const url = new URL(`${HEALTH_API_BASE}${path}`);
  if (url.origin !== 'https://health.googleapis.com') {
    throw new Error('Refusing a non-Health API host.');
  }
  return url;
}

export function createHealthApi(deps: TokenDeps): HealthApi {
  return {
    get(path: string) {
      return request(deps, 'GET', path);
    },
    post(path: string, body: unknown) {
      return request(deps, 'POST', path, body);
    },
  };
}

async function request(deps: TokenDeps, method: 'GET' | 'POST', path: string, body?: unknown, allowRetry = true): Promise<unknown> {
  const token = deps.remote?.accessToken ?? (await getAccessToken({ ...deps, force: false }));
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let response = await deps.fetchImpl(healthUrl(path), { ...init, signal: AbortSignal.timeout(30_000) });
  // One retry for a transient failure, after Retry-After seconds (capped) or 1 s.
  if (TRANSIENT_STATUSES.has(response.status)) {
    await response.body?.cancel();
    const seconds = Number(response.headers.get('Retry-After') ?? NaN);
    await delay(Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 5) * 1000 : 1000);
    response = await deps.fetchImpl(healthUrl(path), { ...init, signal: AbortSignal.timeout(30_000) });
  }
  // A remote token is refreshed by the MCP client, so a 401 goes back to it.
  if (response.status === 401 && allowRetry && !deps.remote) {
    await getAccessToken({ ...deps, force: true });
    return request(deps, method, path, body, false);
  }
  const payload = await readHealthJson(response);
  if (response.ok) return payload;
  throw toHealthError(response.status, payload, token);
}

async function readHealthJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HealthCallError('http', `Health API returned a non-JSON response (HTTP ${response.status}).`, response.status);
  }
}

export function toHealthError(status: number, payload: unknown, token: string): HealthCallError {
  const reason = findReason(payload);
  const statusName = errorStatusName(payload);
  if (status === 400 && reason === 'ACCOUNT_NOT_LINKED') {
    return new HealthCallError('not_linked', 'phone setup unfinished', status);
  }
  if (status === 403 || statusName === 'PERMISSION_DENIED' || reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT') {
    return new HealthCallError('missing_scope', 'missing scope', status);
  }
  const message = isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === 'string' ? payload.error.message : '';
  const safe = message ? sanitizeText(message, [token]) : '';
  if (!safe || safe.includes(token)) {
    return new HealthCallError('http', `Health API request failed (HTTP ${status}).`, status);
  }
  return new HealthCallError('http', safe, status);
}
