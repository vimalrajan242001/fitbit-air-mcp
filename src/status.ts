import { ACCESS_TOKEN_SKEW_MS } from './constants.js';
import { HealthCallError, errorMessage, type Missing } from './errors.js';
import type { HealthApi } from './health.js';
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

/** Link state, granted scopes, and login deadlines. Reads the token file but never returns a token. */
export async function connectionStatus(configDir: string, api: HealthApi, now: Date, remote?: RemoteToken): Promise<ConnectionStatus> {
  let tokens: RemoteToken | null;
  try {
    tokens = remote ?? readTokenFile(configDir);
  } catch (error) {
    return needsLogin(errorMessage(error, 'The token file could not be read.'));
  }
  if (!tokens) return needsLogin('no local token file');

  const loginDueAt = loginDeadline(tokens.refreshObtainedAt);
  const due = loginIsDue(tokens, now);
  const accessUsable = Date.parse(tokens.expiry) - now.getTime() > ACCESS_TOKEN_SKEW_MS;
  const unlinked = (reason: string, overrides: Partial<ConnectionStatus> = {}): ConnectionStatus => ({
    healthAccountLinked: false,
    phoneSetupUnfinished: false,
    scopes: tokens.scopes,
    accessTokenExpiresAt: tokens.expiry,
    loginDueAt,
    loginDue: due,
    missing: [{ reason }],
    ...overrides,
  });
  // Nothing could refresh the token, so skip the network call.
  if (due && !accessUsable) return unlinked('login due');

  try {
    await api.get('/users/me/identity');
  } catch (error) {
    if (!(error instanceof HealthCallError)) return unlinked('identity check failed');
    return unlinked(error.message, { phoneSetupUnfinished: error.kind === 'not_linked', loginDue: due || error.kind === 'login_due' });
  }
  // The identity call may have refreshed the token file; report the newest expiry.
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
}

function needsLogin(reason: string): ConnectionStatus {
  return {
    healthAccountLinked: false,
    phoneSetupUnfinished: false,
    scopes: [],
    accessTokenExpiresAt: null,
    loginDueAt: null,
    loginDue: true,
    missing: [{ reason }],
  };
}
