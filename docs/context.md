# Fitbit Air MCP context

This server reads one person’s own Fitbit Air data. The band syncs to the Google Health app on the phone. The app uploads to Google Health. This process reads that cloud copy through the Google Health API after the account holder consents. It never pairs with the band.

```
Fitbit Air -> Google Health app -> Google Health API -> this process -> Cursor or another local client
```

The legacy Fitbit host is shut down. Do not call `api.fitbit.com`.

## Official pages

- [About the Google Health API](https://developers.google.com/health/about)
- [Set up Google Cloud and OAuth](https://developers.google.com/health/setup)
- [Scopes](https://developers.google.com/health/scopes)
- [Data types](https://developers.google.com/health/data-types)
- [Endpoints](https://developers.google.com/health/endpoints)
- [Aggregate data](https://developers.google.com/health/aggregate-data)
- [dailyRollUp](https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints/dailyRollUp)
- [reconcile](https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints/reconcile)
- [Filters](https://developers.google.com/health/filters)
- [Sleep](https://developers.google.com/health/data-types/sleep)
- [Paired devices](https://developers.google.com/health/reference/rest/v4/users.pairedDevices)
- [Settings](https://developers.google.com/health/reference/rest/v4/Settings)
- [OAuth for desktop apps](https://developers.google.com/identity/protocols/oauth2/native-app)

## Login

Authorization code with PKCE `S256`. Authorize at `https://accounts.google.com/o/oauth2/v2/auth`. Token exchange at `https://oauth2.googleapis.com/token`. The loopback redirect is exactly `http://127.0.0.1:8787`. The request sends `access_type=offline` and `prompt=consent` so Testing mode issues a refresh token.

The app stays in Testing. A refresh token lasts 7 days from `refreshObtainedAt`. `connection_status` reports `loginDueAt` and `loginDue`. Run `npm run login` again when it is due. No homepage, privacy policy, or verification in this slice.

If Google returns `redirect_uri_mismatch`, login stops. The OAuth client is a Web client and `http://127.0.0.1:8787` must be added exactly. Do not create a new Cloud project.

After the code exchange the server calls `GET /users/me/identity`. HTTP 400 with reason `ACCOUNT_NOT_LINKED` means phone setup is unfinished: the Google Health app still needs the account linked. That is not a crash. The token file is still saved.

The env file and `tokens.json` live in `~/.config/fitbit-air-mcp/` (on Windows, `%USERPROFILE%\.config\fitbit-air-mcp\`). The env file has `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`. Nothing in this repo holds those values.

## This slice

Tools: `connection_status`, `sync_status`, `daily_activity`, `sleep_nights`, `recovery_day`, `fitness_age`, `exercise_sessions`. Resource: `fitbit://today`. Prompts: `weekly_review`, `sleep_check`, each with the today snapshot embedded. `compare_periods` was removed; `granularity: "week"` covers trends and comparisons.

`granularity: "week"` (in `src/trends.ts`) accepts up to 91 days. Activity is read in 14-day chunks (35 calls for 91 days, under the Workers free-plan 50-subrequest cap) and returned as 7-day weeks from `start` with per-day averages and `daysWithData`, no per-day rows. Sleep takes the longest session per civil end date as the main sleep and counts the rest as naps; each week has average asleep and in-bed minutes, the median local bedtime, and its 25th-75th percentile spread. Both add a baseline: median and 25th-75th percentile over the last 28 days of the range. It is descriptive, not a score.

Activity uses `POST /users/me/dataTypes/{type}/dataPoints:dailyRollUp` with `windowSizeDays: 1`, a closed-open civil range, and `dataSourceFamily` `users/me/dataSourceFamilies/google-wearables`. Types: `steps`, `distance`, `active-zone-minutes`, `active-minutes`, `total-calories`. Each request is at most 7 days because `active-minutes` and `total-calories` reject ranges over 14.

Documented rollup fields, kept in API units (the result adds `distance.kilometers`, and sleep adds `inBedHours` and `hoursAsleep`):

- `steps.countSum`
- `distance.millimetersSum`
- `activeZoneMinutes.sumInFatBurnHeartZone`, `sumInCardioHeartZone`, `sumInPeakHeartZone`
- `activeMinutes.activeMinutesRollupByActivityLevel[].activityLevel` and `activeMinutesSum`
- `totalCalories.kcalSum`

A missing rollup for a civil day is an empty series plus a `missing` entry. A documented zero stays zero.

Sleep uses `GET /users/me/dataTypes/sleep/dataPoints:reconcile` with the wearable family, page size 25, at most 31 days per request, and `filter=sleep.interval.civil_end_time >= "{start}"` plus the documented upper bound `< "{day after end}"`. In-bed minutes are the session interval. Asleep minutes are `summary.minutesAsleep`. Light, deep, REM, and awake minutes are `summary.stagesSummary`. Short-awakening count is the length of `shortAwakenings`. `detail=true` returns stage intervals only for a single night. `sleepEfficiencyPercent` is `round((minutesAsleep / inBedMinutes) * 100)` from the sleep guide. It is not the in-app Sleep Score.

`recovery_day` reconciles `daily-resting-heart-rate`, `daily-heart-rate-variability`, `daily-oxygen-saturation`, and `daily-vo2-max` (scope `activity_and_fitness.readonly`) with the wearable family, at most 31 days, filtered on `{type_with_underscores}.date >= "{start}"` and `< "{day after end}"`. It keeps `beatsPerMinute`; `averageHeartRateVariabilityMilliseconds`, `deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds`, `nonRemHeartRateBeatsPerMinute`, `entropy`; and `averagePercentage`, `lowerBoundPercentage`, `upperBoundPercentage`, `standardDeviationPercentage`; and `vo2Max` (ml/kg/min), `estimated` when it is a boolean, and `cardioFitnessLevel` when it is one of `POOR`..`EXCELLENT`. `vo2MaxCovariance` is documented only as "the covariance", so it is not used.

`fitness_age` reuses `readRecoveryDays` once, over at most 31 days (default: the 30 days ending today in the account time zone). Age and sex are tool inputs: the Profile documents `age` but no sex. The VO2 max part inverts the FRIEND treadmill 50th-percentile curve (Kaminsky 2015) from the median of at least 3 days. The HRV part inverts an age RMSSD table (Shaffer & Ginsberg 2017 review) from the median `averageHeartRateVariabilityMilliseconds` of at least 7 nights, with low confidence: the API calls it an average RMSSD recorded during sleep, not a whole-night value, and the reference is short-term. Straight lines between points, end slopes extended, clamped to 20-90. Too few days is a `missing` entry. No combined number and no estimate from heart rate.

`exercise_sessions` reconciles `exercise` with the wearable family, at most 31 days, filtered on `exercise.interval.civil_start_time`. It keeps `exerciseType`, `displayName`, the interval, `activeDuration` as minutes, and the `metricsSummary` fields `steps`, `caloriesKcal`, `distanceMillimeters`, `elevationGainMillimeters`, `averageHeartRateBeatsPerMinute`, `activeZoneMinutes`, `averageSpeedMillimetersPerSecond`, `averagePaceSecondsPerMeter`. No `notes`, `exerciseMetadata`, splits, or events.

`sync_status` is `GET /users/me/pairedDevices`. It returns `deviceVersion`, `batteryLevel`, `batteryStatus`, `lastSyncTime`, and `features`. `macAddress` is deleted before the result is built.

`fitbit://today` reads `GET /users/me/settings` for `timeZone`, then today’s steps and zone minutes, last night’s sleep summary, and the latest sync time. It has no resting heart rate and no tokens.

A missing scope or HTTP 403 becomes a `missing` entry. The rest of the tool still returns.

## Next slice

A bounded heart-rate series. Skin temperature waits. GPS and irregular-rhythm notifications stay off until asked for. Still no write, delete, or generic URL tool.

## Ports

- OAuth loopback: `127.0.0.1:8787`
- Private MCP HTTP: `127.0.0.1:8788` at `/mcp`, with localhost Host and Origin checks

Stdio and HTTP are the same process and the same token file. Logs go to stderr only.
