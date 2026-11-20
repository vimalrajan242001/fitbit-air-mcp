import {
  AuthorizationError,
  CimdFetchError,
  OAuthError,
  OAuthProvider,
  authorizationErrorRedirect,
  type AuthRequest,
  type ConsentDescription,
  type OAuthHelpers,
  type TokenExchangeCallbackOptions,
} from '@cloudflare/workers-oauth-provider';
import { createMcpHandler } from '@modelcontextprotocol/server';

import { TESTING_REFRESH_MS } from './constants.js';
import { HealthCallError, errorMessage } from './errors.js';
import { createPkcePair, exchangeCode, googleAuthorizeUrl } from './oauth.js';
import { createFitbitServer } from './server.js';
import { refreshAccessToken, type TokenFile } from './tokens.js';
import { clientRegistrationCallback, ownerRefusal } from './worker-auth.js';

export type Env = {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  GOOGLE_OAUTH_CLIENT_ID: string;
  GOOGLE_OAUTH_CLIENT_SECRET: string;
  /** Public origin of this Worker, e.g. https://fitbit-air-mcp.example.workers.dev */
  PUBLIC_URL: string;
  /** Signs the remembered-consent cookie. 32+ random chars. */
  CONSENT_SECRET: string;
  /** Per-IP limit on unauthenticated client registration. */
  REGISTER_LIMITER: RateLimit;
  /** healthUserId of the one Google account allowed to sign in. */
  OWNER_HEALTH_USER_ID?: string;
};

/** One person's server: every grant belongs to the same user. */
const OWNER = 'owner';

/** Workers' fetch throws "Illegal invocation" when called as a method (deps.fetchImpl(...)), so wrap it. */
const fetchImpl: typeof fetch = (input, init) => fetch(input, init);

/** /mcp after the library has checked the bearer token. Google tokens arrive in ctx.props. */
export const apiHandler = {
  async fetch(request: Request, _env: Env, ctx: ExecutionContext): Promise<Response> {
    const { refreshToken: _refresh, ...remote } = (ctx as ExecutionContext & { props: TokenFile }).props;
    const handler = createMcpHandler(() => createFitbitServer({ configDir: '/', fetchImpl, remote }));
    return handler.fetch(request);
  },
};

/** /authorize (consent, then Google) and /callback (Google back to the MCP client). */
export const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const route = `${request.method} ${new URL(request.url).pathname}`;
    try {
      if (route === 'GET /authorize') return await showConsent(request, env);
      if (route === 'POST /authorize') return await decideConsent(request, env);
      if (route === 'GET /callback') return await finishGoogleSignIn(request, env);
      return text('Not found', 404);
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
      if (error instanceof AuthorizationError) return text(error.description, 400);
      if (error instanceof CimdFetchError) return text('This app could not be verified.', 400);
      throw error;
    }
  },
};

/** GET /authorize: skip straight to Google when consent is remembered, else show the consent page. */
async function showConsent(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const authRequest = await oauth.parseAuthRequest(request);
  if (await oauth.isConsentRemembered(request, authRequest, { secret: env.CONSENT_SECRET })) {
    return redirectToGoogle(env, authRequest, new Headers());
  }
  const details = await oauth.describeConsent(authRequest);
  const consent = await oauth.beginConsent(authRequest);
  consent.headers.set('Content-Type', 'text/html; charset=utf-8');
  return new Response(consentPage(details, consent.handle), { headers: consent.headers });
}

/** POST /authorize: the consent form. Deny goes back to the client; allow goes on to Google. */
async function decideConsent(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const form = await request.formData();
  const handle = String(form.get('handle'));
  if (form.get('decision') !== 'approve') {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await oauth.approveConsent(request, handle, { remember: { secret: env.CONSENT_SECRET } });
  return redirectToGoogle(env, approved.request, approved.headers);
}

/** GET /callback: trade Google's code, check the account is the owner, then complete the MCP client's grant. */
async function finishGoogleSignIn(request: Request, env: Env): Promise<Response> {
  const { request: original, data, headers } = await env.OAUTH_PROVIDER.finishUpstream<{ verifier: string }>(request);
  const code = new URL(request.url).searchParams.get('code');
  if (!code) {
    headers.set('Location', authorizationErrorRedirect(original, 'access_denied'));
    return new Response(null, { status: 302, headers });
  }
  let tokens: TokenFile;
  try {
    tokens = await exchangeCode({
      fetchImpl,
      redirectUri: callbackUrl(env),
      now: new Date(),
      clientId: env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      code,
      verifier: data.verifier,
    });
  } catch (error) {
    return text(errorMessage(error, 'Google sign-in failed.'), 502);
  }
  const refusal = await ownerRefusal(tokens, env.OWNER_HEALTH_USER_ID, fetchImpl);
  if (refusal) return text(refusal, 403);
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: original,
    userId: OWNER,
    metadata: {},
    scope: original.scope,
    props: tokens,
  });
  headers.set('Location', redirectTo);
  return new Response(null, { status: 302, headers });
}

/** Starts the upstream Google sign-in with a fresh PKCE verifier kept in the library's state. */
async function redirectToGoogle(env: Env, authRequest: AuthRequest, extra: Headers): Promise<Response> {
  const { verifier, challenge } = createPkcePair();
  const { state, headers } = await env.OAUTH_PROVIDER.beginUpstream(authRequest, { data: { verifier }, headers: extra });
  headers.set('Location', googleAuthorizeUrl({ clientId: env.GOOGLE_OAUTH_CLIENT_ID, redirectUri: callbackUrl(env), challenge, state }).toString());
  return new Response(null, { status: 302, headers });
}

function callbackUrl(env: Env): string {
  return `${env.PUBLIC_URL}/callback`;
}

/** Keeps our access token no longer-lived than Google's, and refreshes Google's on refresh_token. */
export async function tokenExchangeCallback({ grantType, props, env }: TokenExchangeCallbackOptions<Env>) {
  let tokens = props as TokenFile;
  if (grantType === 'refresh_token') {
    try {
      tokens = await refreshAccessToken(
        tokens,
        { clientId: env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET },
        fetchImpl,
        new Date(),
      );
    } catch (error) {
      if (error instanceof HealthCallError && error.kind === 'login_due') {
        throw new OAuthError('invalid_grant', { description: 'Google access expired. Sign in again.' });
      }
      throw new OAuthError('temporarily_unavailable', { description: 'Google token refresh failed.', statusCode: 503 });
    }
  } else if (grantType !== 'authorization_code') {
    return;
  }
  const accessTokenTTL = Math.max(60, Math.floor((Date.parse(tokens.expiry) - Date.now()) / 1000) - 60);
  return { newProps: tokens, accessTokenTTL };
}

let provider: OAuthProvider<Env> | undefined;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'POST' && new URL(request.url).pathname === '/register') {
      const { success } = await env.REGISTER_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'unknown' });
      if (!success) return text('Too many registrations. Try again later.', 429);
    }
    provider ??= new OAuthProvider<Env>({
      apiRoute: '/mcp',
      apiHandler,
      defaultHandler,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/token',
      clientRegistrationEndpoint: '/register',
      clientRegistrationCallback,
      // Google Testing-mode refresh tokens last 7 days, so ours do too.
      refreshTokenTTL: TESTING_REFRESH_MS / 1000,
      resourceMetadata: { resource: `${env.PUBLIC_URL}/mcp`, resource_name: 'Fitbit Air' },
      tokenExchangeCallback,
    });
    return provider.fetch(request, env, ctx);
  },
};

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function text(message: string, status: number): Response {
  return new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

export function consentPage(details: ConsentDescription, handle: string): string {
  const name = escape(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escape(details.clientDomain)}</strong>.`
    : 'This app registered itself; its name is not verified.';
  const loopback = details.redirectIsLoopback
    ? '<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>'
    : '';
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fitbit Air MCP</title>
<h1>Allow ${name} to read your Fitbit Air data?</h1>
<p>${origin} Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
${loopback}
<p>Next you sign in with Google and approve read-only Health access.</p>
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <p><button name="decision" value="approve">Allow</button> <button name="decision" value="deny">Deny</button></p>
</form>`;
}
