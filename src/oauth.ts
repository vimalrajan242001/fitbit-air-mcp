import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';

import {
  LOGIN_TIMEOUT_MS,
  LOOPBACK_HOST,
  OAUTH_AUTHORIZE_URL,
  OAUTH_PORT,
  REDIRECT_MISMATCH_MESSAGE,
  REDIRECT_URI,
  REQUEST_TIMEOUT_MS,
  SCOPES,
} from './constants.js';
import { loadOAuthClient } from './env.js';
import { findReason } from './errors.js';
import { healthUrl, readHealthJson } from './health.js';
import { log } from './log.js';
import { defaultConfigDir } from './paths.js';
import { oauthFailureMessage, postTokenEndpoint, tokenFileFromResponse, writeTokenFile, type TokenFile } from './tokens.js';

export type LoginResult = {
  phoneSetupUnfinished: boolean;
  message: string;
};

export type LoginOptions = {
  configDir?: string;
  fetchImpl?: typeof fetch;
  openUrl?: (url: string) => void | Promise<void>;
  now?: () => Date;
  timeoutMs?: number;
};

type CallbackQuery = { code: string; state: string };

/** A PKCE S256 pair: the verifier stays here, the challenge goes to Google. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** Google consent URL for the five read scopes, PKCE S256, offline access. */
export function googleAuthorizeUrl(input: { clientId: string; redirectUri: string; challenge: string; state: string }): URL {
  const authorize = new URL(OAUTH_AUTHORIZE_URL);
  const params = {
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    code_challenge: input.challenge,
    code_challenge_method: 'S256',
    // offline + consent make Testing mode issue a refresh token every time.
    access_type: 'offline',
    prompt: 'consent',
    state: input.state,
  };
  for (const [key, value] of Object.entries(params)) authorize.searchParams.set(key, value);
  return authorize;
}

/** The `npm run login` flow: consent in the browser, a loopback redirect, then the token file. */
export async function login(options: LoginOptions = {}): Promise<LoginResult> {
  const configDir = options.configDir ?? defaultConfigDir();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const client = loadOAuthClient(configDir);
  const { verifier, challenge } = createPkcePair();
  const state = randomBytes(16).toString('base64url');
  const authorize = googleAuthorizeUrl({ clientId: client.clientId, redirectUri: REDIRECT_URI, challenge, state }).toString();

  const server = createServer();
  try {
    await listen(server);
    const callback = waitForCallback(server, state, options.timeoutMs ?? LOGIN_TIMEOUT_MS);
    // Awaited below; this only stops a redirect that fails while the browser opens from being an unhandled rejection.
    callback.catch(() => undefined);
    log('Opening the browser for Google consent. If it does not open, use the URL on the next line.');
    log(authorize);
    await (options.openUrl ?? openSystemBrowser)(authorize);
    const { code } = await callback;
    const tokens = await exchangeCode({ fetchImpl, now: now(), clientId: client.clientId, clientSecret: client.clientSecret, code, verifier });
    writeTokenFile(configDir, tokens);
    return identityResult(fetchImpl, tokens.accessToken);
  } finally {
    await closeServer(server);
  }
}

/** Reports whether the Google Health app has linked this account. The token file is already saved either way. */
async function identityResult(fetchImpl: typeof fetch, accessToken: string): Promise<LoginResult> {
  const response = await fetchImpl(healthUrl('/users/me/identity'), {
    headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await readHealthJson(response).catch(() => undefined);
  if (payload !== undefined && response.ok) {
    return { phoneSetupUnfinished: false, message: 'Saved the token file. The Health account is linked.' };
  }
  if (payload !== undefined && response.status === 400 && findReason(payload) === 'ACCOUNT_NOT_LINKED') {
    return {
      phoneSetupUnfinished: true,
      message:
        'Saved the token file. Phone setup unfinished. Open the Google Health app, finish linking this Google account, then run npm run login again.',
    };
  }
  return { phoneSetupUnfinished: false, message: `Saved the token file. The identity check failed (HTTP ${response.status}).` };
}

/** Trades an authorization code for tokens. Errors are sanitized of the secret, code, and verifier. */
export async function exchangeCode(input: {
  fetchImpl: typeof fetch;
  redirectUri?: string;
  now: Date;
  clientId: string;
  clientSecret: string;
  code: string;
  verifier: string;
}): Promise<TokenFile> {
  const { response, payload } = await postTokenEndpoint(input.fetchImpl, {
    code: input.code,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri ?? REDIRECT_URI,
    grant_type: 'authorization_code',
    code_verifier: input.verifier,
  });
  if (!response.ok) {
    const message = oauthFailureMessage(payload, response.status, [input.clientSecret, input.code, input.verifier]);
    throw new Error(message === 'redirect_uri_mismatch' ? REDIRECT_MISMATCH_MESSAGE : message);
  }
  return tokenFileFromResponse(payload, { now: input.now, requireRefreshToken: true });
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        reject(new Error(`Port ${OAUTH_PORT} is already in use on ${LOOPBACK_HOST}. Stop the other login and try again.`));
        return;
      }
      reject(error);
    };
    server.once('error', onError);
    server.listen(OAUTH_PORT, LOOPBACK_HOST, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

/** Resolves with the first redirect that carries our state, or rejects on an error redirect, a state mismatch, or timeout. */
function waitForCallback(server: Server, expectedState: string, timeoutMs: number): Promise<CallbackQuery> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => finish(() => reject(new Error('Login timed out waiting for the browser redirect.'))), timeoutMs);
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      server.off('request', onRequest);
      complete();
    };
    const onRequest = (request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? '/', REDIRECT_URI);
      if (url.pathname === '/favicon.ico') {
        response.writeHead(404);
        response.end();
        return;
      }
      const error = url.searchParams.get('error');
      if (error) {
        const mismatch = error === 'redirect_uri_mismatch' || (url.searchParams.get('error_description') ?? '').includes('redirect_uri_mismatch');
        const failure = new Error(mismatch ? REDIRECT_MISMATCH_MESSAGE : `Google returned ${error}.`);
        respond(response, 400, 'Login did not finish. You can close this window.', () => finish(() => reject(failure)));
        return;
      }
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!code || !state || state !== expectedState) {
        const failure = new Error('Login state did not match. Run npm run login again.');
        respond(response, 400, 'Login state did not match. You can close this window.', () => finish(() => reject(failure)));
        return;
      }
      respond(response, 200, 'Login finished. You can close this window.', () => finish(() => resolve({ code, state })));
    };
    server.on('request', onRequest);
  });
}

/** Sends a one-line HTML page and runs `then` once it is flushed, so the browser sees it before the server closes. */
function respond(response: ServerResponse, status: number, message: string, then: () => void): void {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
  response.end(`<!doctype html><meta charset="utf-8"><title>Fitbit Air MCP</title><p>${message}</p>`, then);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

export function openSystemBrowser(url: string): void {
  const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url.replace(/&/g, '^&')] : [url];
  const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
  child.on('error', () => {
    log('The browser did not open. Use the consent URL printed above.');
  });
  child.unref();
}
