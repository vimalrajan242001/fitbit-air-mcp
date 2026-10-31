import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';

import {
  OAUTH_AUTHORIZE_URL,
  OAUTH_PORT,
  OAUTH_TOKEN_URL,
  LOOPBACK_HOST,
  REDIRECT_MISMATCH_MESSAGE,
  REDIRECT_URI,
  SCOPES,
} from './constants.js';
import { loadOAuthClient } from './env.js';
import { findReason } from './errors.js';
import { log } from './log.js';
import { defaultConfigDir } from './paths.js';
import { readOauthJson, tokenFileFromResponse, writeTokenFile, oauthFailureMessage } from './tokens.js';

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

/** Google consent URL for the five read scopes, PKCE S256, offline access. */
export function googleAuthorizeUrl(input: { clientId: string; redirectUri: string; challenge: string; state: string }): URL {
  const authorize = new URL(OAUTH_AUTHORIZE_URL);
  authorize.searchParams.set('client_id', input.clientId);
  authorize.searchParams.set('redirect_uri', input.redirectUri);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('scope', SCOPES.join(' '));
  authorize.searchParams.set('code_challenge', input.challenge);
  authorize.searchParams.set('code_challenge_method', 'S256');
  authorize.searchParams.set('access_type', 'offline');
  authorize.searchParams.set('prompt', 'consent');
  authorize.searchParams.set('state', input.state);
  return authorize;
}

export async function login(options: LoginOptions = {}): Promise<LoginResult> {
  const configDir = options.configDir ?? defaultConfigDir();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const client = loadOAuthClient(configDir);
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('base64url');
  const authorize = googleAuthorizeUrl({ clientId: client.clientId, redirectUri: REDIRECT_URI, challenge, state });

  const server = createServer();
  try {
    await listen(server);
    const callback = waitForCallback(server, state, timeoutMs);
    const settled = callback.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    log('Opening the browser for Google consent. If it does not open, use the URL on the next line.');
    log(authorize.toString());
    await Promise.resolve((options.openUrl ?? openSystemBrowser)(authorize.toString()));
    const outcome = await settled;
    if (!outcome.ok) throw outcome.error;
    const granted = outcome.value;
    const tokens = await exchangeCode({
      fetchImpl,
      now: now(),
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      code: granted.code,
      verifier,
    });
    writeTokenFile(configDir, tokens);
    return identityResult(fetchImpl, tokens.accessToken);
  } finally {
    await closeServer(server);
  }
}

async function identityResult(fetchImpl: typeof fetch, accessToken: string): Promise<LoginResult> {
  const response = await fetchImpl('https://health.googleapis.com/v4/users/me/identity', {
    headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let payload: unknown = {};
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      return {
        phoneSetupUnfinished: false,
        message: `Saved the token file. The identity check failed (HTTP ${response.status}).`,
      };
    }
  }
  if (response.ok) {
    return { phoneSetupUnfinished: false, message: 'Saved the token file. The Health account is linked.' };
  }
  if (response.status === 400 && findReason(payload) === 'ACCOUNT_NOT_LINKED') {
    return {
      phoneSetupUnfinished: true,
      message:
        'Saved the token file. Phone setup unfinished. Open the Google Health app, finish linking this Google account, then run npm run login again.',
    };
  }
  return {
    phoneSetupUnfinished: false,
    message: `Saved the token file. The identity check failed (HTTP ${response.status}).`,
  };
}

export async function exchangeCode(input: {
  fetchImpl: typeof fetch;
  redirectUri?: string;
  now: Date;
  clientId: string;
  clientSecret: string;
  code: string;
  verifier: string;
}): Promise<ReturnType<typeof tokenFileFromResponse>> {
  const body = new URLSearchParams({
    code: input.code,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri ?? REDIRECT_URI,
    grant_type: 'authorization_code',
    code_verifier: input.verifier,
  });
  const response = await input.fetchImpl(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  const payload = await readOauthJson(response);
  if (!response.ok) {
    const message = oauthFailureMessage(payload, response.status, [input.clientSecret, input.code, input.verifier]);
    if (message === 'redirect_uri_mismatch') throw new Error(REDIRECT_MISMATCH_MESSAGE);
    throw new Error(message);
  }
  return tokenFileFromResponse(payload, {
    now: input.now,
    requireRefreshToken: true,
    secrets: [input.clientSecret, input.code, input.verifier],
  });
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
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

function waitForCallback(server: ReturnType<typeof createServer>, expectedState: string, timeoutMs: number): Promise<CallbackQuery> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => finish(new Error('Login timed out waiting for the browser redirect.')), timeoutMs);
    const finish = (error?: Error, value?: CallbackQuery) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      server.off('request', onRequest);
      if (error) reject(error);
      else resolve(value!);
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
        const description = url.searchParams.get('error_description') ?? '';
        response.writeHead(400, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
        response.end(page('Login did not finish. You can close this window.'), () => {
          if (error === 'redirect_uri_mismatch' || description.includes('redirect_uri_mismatch')) {
            finish(new Error(REDIRECT_MISMATCH_MESSAGE));
            return;
          }
          finish(new Error(`Google returned ${error}.`));
        });
        return;
      }
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!code || !state || state !== expectedState) {
        response.writeHead(400, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
        response.end(page('Login state did not match. You can close this window.'), () => {
          finish(new Error('Login state did not match. Run npm run login again.'));
        });
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
      response.end(page('Login finished. You can close this window.'), () => {
        finish(undefined, { code, state });
      });
    };
    server.on('request', onRequest);
  });
}

function page(message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Fitbit Air MCP</title><p>${message}</p>`;
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
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
