import { ACCESS_TOKEN_SKEW_MS } from './constants.js';
import type { HealthApi } from './health.js';
import { HealthCallError, type Missing } from './errors.js';
import { loginDeadline, loginIsDue, readTokenFile, type RemoteToken } from './tokens.js';

export type ConnectionStatus = {
  healthAccountLinked: boolean;
  phoneSetupUnfinished: boolean;
  scopes: string[];
  accessTokenExpiresAt: string | null;
  loginDueAt: string | null;
  loginDue: boolean;
  missing: Missing[];
};

export async function connectionStatus(configDir: string, api: HealthApi, now: Date, remote?: RemoteToken): Promise<ConnectionStatus> {
  let tokens: RemoteToken | null;
  try {
    tokens = remote ?? readTokenFile(configDir);
  } catch (error) {
    return {
      healthAccountLinked: false,
      phoneSetupUnfinished: false,
      scopes: [],
      accessTokenExpiresAt: null,
      loginDueAt: null,
      loginDue: true,
      missing: [{ reason: error instanceof Error ? error.message : 'The token file could not be read.' }],
    };
  }
  if (!tokens) {
    return {
      healthAccountLinked: false,
      phoneSetupUnfinished: false,
      scopes: [],
      accessTokenExpiresAt: null,
      loginDueAt: null,
      loginDue: true,
      missing: [{ reason: 'no local token file' }],
    };
  }
  const loginDueAt = loginDeadline(tokens.refreshObtainedAt);
  const due = loginIsDue(tokens, now);
  const accessUsable = Date.parse(tokens.expiry) - now.getTime() > ACCESS_TOKEN_SKEW_MS;
  if (due && !accessUsable) {
    return {
      healthAccountLinked: false,
      phoneSetupUnfinished: false,
      scopes: tokens.scopes,
      accessTokenExpiresAt: tokens.expiry,
      loginDueAt,
      loginDue: true,
      missing: [{ reason: 'login due' }],
    };
  }
  try {
    await api.get('/users/me/identity');
    const latest = (remote ? null : readTokenFile(configDir)) ?? tokens;
    return {
      healthAccountLinked: true,
      phoneSetupUnfinished: false,
      scopes: latest.scopes,
      accessTokenExpiresAt: latest.expiry,
      loginDueAt,
      loginDue: due,
      missing: [],
    };
  } catch (error) {
    const kind = error instanceof HealthCallError ? error.kind : 'http';
    const reason = error instanceof HealthCallError ? error.message : 'identity check failed';
    return {
      healthAccountLinked: false,
      phoneSetupUnfinished: kind === 'not_linked',
      scopes: tokens.scopes,
      accessTokenExpiresAt: tokens.expiry,
      loginDueAt,
      loginDue: due || kind === 'login_due',
      missing: [{ reason }],
    };
  }
}
