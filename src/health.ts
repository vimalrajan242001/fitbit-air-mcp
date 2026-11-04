import { setTimeout as delay } from 'node:timers/promises';

import {
  DEFAULT_RETRY_MS,
  HEALTH_API_BASE,
  MAX_RECONCILE_PAGES,
  MAX_RETRY_AFTER_MS,
  RECONCILE_PAGE_SIZE,
  REQUEST_TIMEOUT_MS,
  WEARABLE_FAMILY,
} from './constants.js';
import { addCivilDays, type DateRange } from './dates.js';
import { HealthCallError, errorStatusName, findReason, sanitizeText, type Missing } from './errors.js';
import { isRecord, readJsonBody } from './parse.js';
import { getAccessToken, type TokenDeps } from './tokens.js';

export type HealthApi = {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
};

/** Fields every wearable read returns, so a client can always tell what was asked for and what is absent. */
export type WearableResult = {
  range: DateRange;
  dataSourceFamily: typeof WEARABLE_FAMILY;
  missing: Missing[];
};

const HEALTH_ORIGIN = new URL(HEALTH_API_BASE).origin;
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

export function healthUrl(path: string): URL {
  if (!path.startsWith('/')) {
    throw new Error('Health API paths must start with /.');
  }
  const url = new URL(`${HEALTH_API_BASE}${path}`);
  if (url.origin !== HEALTH_ORIGIN) {
    throw new Error('Refusing a non-Health API host.');
  }
  return url;
}

export function createHealthApi(deps: TokenDeps): HealthApi {
  return {
    get: (path) => request(deps, 'GET', path),
    post: (path, body) => request(deps, 'POST', path, body),
  };
}

async function request(deps: TokenDeps, method: 'GET' | 'POST', path: string, body?: unknown, allowAuthRetry = true): Promise<unknown> {
  const token = deps.remote?.accessToken ?? (await getAccessToken({ ...deps, force: false }));
  const init = requestInit(method, token, body);
  const response = await fetchWithOneRetry(deps.fetchImpl, healthUrl(path), init);
  // A remote token is refreshed by the MCP client, so a 401 goes back to it.
  if (response.status === 401 && allowAuthRetry && !deps.remote) {
    await getAccessToken({ ...deps, force: true });
    return request(deps, method, path, body, false);
  }
  const payload = await readHealthJson(response);
  if (response.ok) return payload;
  throw toHealthError(response.status, payload, token);
}

function requestInit(method: 'GET' | 'POST', token: string, body: unknown): RequestInit {
  const headers: Record<string, string> = { Accept: 'application/json', Authorization: `Bearer ${token}` };
  if (body === undefined) return { method, headers };
  headers['Content-Type'] = 'application/json';
  return { method, headers, body: JSON.stringify(body) };
}

/** One retry for a transient failure, after Retry-After seconds (capped) or a short default wait. */
async function fetchWithOneRetry(fetchImpl: typeof fetch, url: URL, init: RequestInit): Promise<Response> {
  const send = () => fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const response = await send();
  if (!TRANSIENT_STATUSES.has(response.status)) return response;
  await response.body?.cancel();
  await delay(retryDelayMs(response.headers.get('Retry-After')));
  return send();
}

export function retryDelayMs(retryAfter: string | null): number {
  const seconds = Number(retryAfter ?? NaN);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : DEFAULT_RETRY_MS;
}

/** Follows nextPageToken for up to maxPages and returns the items under `key`. Throws if pages remain. */
export async function paginate(fetchPage: (pageToken?: string) => Promise<unknown>, key: string, maxPages: number, coverageMessage: string): Promise<unknown[]> {
  const items: unknown[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const payload = await fetchPage(pageToken);
    if (!isRecord(payload)) return items;
    const batch = payload[key];
    if (Array.isArray(batch)) items.push(...batch);
    pageToken = typeof payload.nextPageToken === 'string' && payload.nextPageToken.length > 0 ? payload.nextPageToken : undefined;
    if (!pageToken) return items;
  }
  throw new HealthCallError('http', coverageMessage);
}

/** Pages `dataPoints:reconcile` for one data type from the wearable family. */
export function reconcile(api: HealthApi, dataType: string, filter: string, coverageMessage: string): Promise<unknown[]> {
  return paginate(
    (pageToken) => {
      const params = new URLSearchParams({ dataSourceFamily: WEARABLE_FAMILY, pageSize: String(RECONCILE_PAGE_SIZE), filter });
      if (pageToken) params.set('pageToken', pageToken);
      return api.get(`/users/me/dataTypes/${dataType}/dataPoints:reconcile?${params.toString()}`);
    },
    'dataPoints',
    MAX_RECONCILE_PAGES,
    coverageMessage,
  );
}

/** The documented filter for an inclusive civil range: `field >= start AND field < day after end`. */
export function civilRangeFilter(field: string, { start, end }: DateRange): string {
  return `${field} >= "${start}" AND ${field} < "${addCivilDays(end, 1)}"`;
}

export function readHealthJson(response: Response): Promise<unknown> {
  return readJsonBody(
    response,
    () => new HealthCallError('http', `Health API returned a non-JSON response (HTTP ${response.status}).`, response.status),
  );
}

/** Classifies a failed Health API response. Only a sanitized message ever leaves this function. */
export function toHealthError(status: number, payload: unknown, token: string): HealthCallError {
  const reason = findReason(payload);
  if (status === 400 && reason === 'ACCOUNT_NOT_LINKED') {
    return new HealthCallError('not_linked', 'phone setup unfinished', status);
  }
  if (status === 403 || errorStatusName(payload) === 'PERMISSION_DENIED' || reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT') {
    return new HealthCallError('missing_scope', 'missing scope', status);
  }
  const message = isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === 'string' ? payload.error.message : '';
  const safe = message ? sanitizeText(message, [token]) : '';
  return new HealthCallError('http', safe || `Health API request failed (HTTP ${status}).`, status);
}
