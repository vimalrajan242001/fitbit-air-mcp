/** Matches package.json; a test checks it. */
export const SERVER_VERSION = '0.1.0';

/** Google Health API origin and version. Paths are appended to this base. */
export const HEALTH_API_BASE = 'https://health.googleapis.com/v4';

export const OAUTH_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export const LOOPBACK_HOST = '127.0.0.1';
export const OAUTH_PORT = 8787;
export const HTTP_PORT = 8788;
export const REDIRECT_URI = `http://${LOOPBACK_HOST}:${OAUTH_PORT}`;

/** Fitbit tracker samples. Excludes phone estimates and manual entries. */
export const WEARABLE_FAMILY = 'users/me/dataSourceFamilies/google-wearables';

export const SCOPES = [
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
  'https://www.googleapis.com/auth/googlehealth.profile.readonly',
  'https://www.googleapis.com/auth/googlehealth.settings.readonly',
] as const;

/** Testing-mode refresh tokens last 7 days from refreshObtainedAt. */
export const TESTING_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

/** Tool results carry loginWarning once the refresh token has this long or less left. */
export const LOGIN_WARNING_MS = 48 * 60 * 60 * 1000;

/** active-minutes and total-calories reject ranges over 14 days. Tools stay at 7. */
export const MAX_ACTIVITY_DAYS = 7;

/** Weekly reads use the full 14-day rollup range: 7 chunks of 5 series stays under the Workers free-plan 50 subrequests. */
export const MAX_ROLLUP_DAYS = 14;

/** Keeps a reconcile read (sleep, exercise, recovery) to a few pages and a result the model can hold. */
export const MAX_RECONCILE_DAYS = 31;

/** Weekly trend reads: 13 weeks, paged inside the server. */
export const MAX_TREND_DAYS = 91;

/** Days behind a baseline, ending at the range end. */
export const BASELINE_DAYS = 28;

/** Reconcile pages hold at most 25 sessions. */
export const RECONCILE_PAGE_SIZE = 25;
export const MAX_RECONCILE_PAGES = 25;
export const MAX_ACTIVITY_PAGES = 10;
export const PAIRED_DEVICE_PAGE_SIZE = 100;
export const MAX_PAIRED_DEVICE_PAGES = 10;

/** Treat an access token this close to expiry as expired. */
export const ACCESS_TOKEN_SKEW_MS = 60_000;

/** Per-request timeout for Google calls. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** Longest wait honored from a Retry-After header, and the wait when there is none. */
export const MAX_RETRY_AFTER_MS = 5_000;
export const DEFAULT_RETRY_MS = 1_000;

/** How long `npm run login` waits for the browser redirect. */
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export const REDIRECT_MISMATCH_MESSAGE =
  'The OAuth client is a Web client and http://127.0.0.1:8787 must be added exactly.';
