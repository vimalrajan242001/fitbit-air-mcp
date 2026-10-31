import { createHash, randomBytes } from 'node:crypto';

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
import { HealthCallError } from './errors.js';
import { exchangeCode, googleAuthorizeUrl } from './oauth.js';
import { createFitbitServer } from './server.js';
import { refreshAccessToken, type TokenFile } from './tokens.js';

export type Env = {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  GOOGLE_OAUTH_CLIENT_ID: string;
  GOOGLE_OAUTH_CLIENT_SECRET: string;
  /** Public origin of this Worker, e.g. https://fitbit-air-mcp.example.workers.dev */
  PUBLIC_URL: string;
  /** Signs the remembered-consent cookie. 32+ random chars. */
  CONSENT_SECRET: string;
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
    const url = new URL(request.url);
    const oauth = env.OAUTH_PROVIDER;
    const redirectUri = `${env.PUBLIC_URL}/callback`;
    const toGoogle = async (authRequest: AuthRequest, extra: Headers): Promise<Response> => {
      const verifier = randomBytes(32).toString('base64url');
      const { state, headers } = await oauth.beginUpstream(authRequest, { data: { verifier }, headers: extra });
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      headers.set('Location', googleAuthorizeUrl({ clientId: env.GOOGLE_OAUTH_CLIENT_ID, redirectUri, challenge, state }).toString());
      return new Response(null, { status: 302, headers });
    };
    try {
      if (url.pathname === '/authorize' && request.method === 'GET') {
        const authRequest = await oauth.parseAuthRequest(request);
        if (await oauth.isConsentRemembered(request, authRequest, { secret: env.CONSENT_SECRET })) {
          return toGoogle(authRequest, new Headers());
        }
        const details = await oauth.describeConsent(authRequest);
        const consent = await oauth.beginConsent(authRequest);
        consent.headers.set('Content-Type', 'text/html; charset=utf-8');
        return new Response(consentPage(details, consent.handle), { headers: consent.headers });
      }
      if (url.pathname === '/authorize' && request.method === 'POST') {
        const form = await request.formData();
        const handle = String(form.get('handle'));
        if (form.get('decision') !== 'approve') {
          const denied = await oauth.denyConsent(request, handle);
          return new Response(null, { status: 302, headers: denied.headers });
        }
        const approved = await oauth.approveConsent(request, handle, { remember: { secret: env.CONSENT_SECRET } });
        return toGoogle(approved.request, approved.headers);
      }
      if (url.pathname === '/callback' && request.method === 'GET') {
        const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(request);
        const code = url.searchParams.get('code');
        if (!code) {
          headers.set('Location', authorizationErrorRedirect(original, 'access_denied'));
          return new Response(null, { status: 302, headers });
        }
        let tokens: TokenFile;
        try {
          tokens = await exchangeCode({
            fetchImpl,
            redirectUri,
            now: new Date(),
            clientId: env.GOOGLE_OAUTH_CLIENT_ID,
            clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
            code,
            verifier: data.verifier,
          });
        } catch (error) {
          return text(error instanceof Error ? error.message : 'Google sign-in failed.', 502);
        }
        const { redirectTo } = await oauth.completeAuthorization({
          request: original,
          userId: OWNER,
          metadata: {},
          scope: original.scope,
          props: tokens,
        });
        headers.set('Location', redirectTo);
        return new Response(null, { status: 302, headers });
      }
      return text('Not found', 404);
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
      if (error instanceof AuthorizationError) return text(error.description, 400);
      if (error instanceof CimdFetchError) return text('This app could not be verified.', 400);
      throw error;
    }
  },
};

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
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    provider ??= new OAuthProvider<Env>({
      apiRoute: '/mcp',
      apiHandler,
      defaultHandler,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/token',
      clientRegistrationEndpoint: '/register',
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
