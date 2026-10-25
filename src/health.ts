import { HEALTH_API_BASE } from './constants.js';
import { HealthCallError, errorStatusName, findReason, isRecord, sanitizeText } from './errors.js';
import { getAccessToken, type TokenDeps } from './tokens.js';

export type HealthApi = {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
};

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
  const token = await getAccessToken({ ...deps, force: false });
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
  };
  const init: RequestInit = { method, headers, signal: AbortSignal.timeout(30_000) };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await deps.fetchImpl(healthUrl(path), init);
  if (response.status === 401 && allowRetry) {
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
