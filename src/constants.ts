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

/** active-minutes and total-calories reject ranges over 14 days. Tools stay at 7. */
export const MAX_ACTIVITY_DAYS = 7;

/** Sleep and exercise pages are capped at 25 sessions. */
export const SLEEP_PAGE_SIZE = 25;
export const MAX_SLEEP_PAGES = 25;
export const MAX_ACTIVITY_PAGES = 10;

export const ACCESS_TOKEN_SKEW_MS = 60_000;

export const REDIRECT_MISMATCH_MESSAGE =
  'The OAuth client is a Web client and http://127.0.0.1:8787 must be added exactly.';
