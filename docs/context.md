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

Tools: `connection_status`, `sync_status`, `daily_activity`, `sleep_nights`, `compare_periods`. Resource: `fitbit://today`.

Activity uses `POST /users/me/dataTypes/{type}/dataPoints:dailyRollUp` with `windowSizeDays: 1`, a closed-open civil range, and `dataSourceFamily` `users/me/dataSourceFamilies/google-wearables`. Types: `steps`, `distance`, `active-zone-minutes`, `active-minutes`, `total-calories`. Each request is at most 7 days because `active-minutes` and `total-calories` reject ranges over 14.

Documented rollup fields, with no unit conversion:

- `steps.countSum`
- `distance.millimetersSum`
- `activeZoneMinutes.sumInFatBurnHeartZone`, `sumInCardioHeartZone`, `sumInPeakHeartZone`
- `activeMinutes.activeMinutesRollupByActivityLevel[].activityLevel` and `activeMinutesSum`
- `totalCalories.kcalSum`

A missing rollup for a civil day is an empty series plus a `missing` entry. A documented zero stays zero.

Sleep uses `GET /users/me/dataTypes/sleep/dataPoints:reconcile` with the wearable family, page size 25, and `filter=sleep.interval.civil_end_time >= "{start}"` plus the documented upper bound `< "{day after end}"`. In-bed minutes are the session interval. Asleep minutes are `summary.minutesAsleep`. Light, deep, REM, and awake minutes are `summary.stagesSummary`. Short-awakening count is the length of `shortAwakenings`. `detail=true` returns stage intervals only for a single night. `sleepEfficiencyPercent` is `round((minutesAsleep / inBedMinutes) * 100)` from the sleep guide. It is not the in-app Sleep Score.

`sync_status` is `GET /users/me/pairedDevices`. It returns `deviceVersion`, `batteryLevel`, `batteryStatus`, `lastSyncTime`, and `features`. `macAddress` is deleted before the result is built.

`fitbit://today` reads `GET /users/me/settings` for `timeZone`, then today’s steps and zone minutes, last night’s sleep summary, and the latest sync time. It has no resting heart rate and no tokens.

A missing scope or HTTP 403 becomes a `missing` entry. The rest of the tool still returns.

## Next slice

Resting heart rate, daily HRV, and daily SpO2 (`recovery_day`), then workouts and a bounded heart-rate series. Skin temperature and VO2 max wait. GPS and irregular-rhythm notifications stay off until asked for. Still no write, delete, or generic URL tool.

## Ports

- OAuth loopback: `127.0.0.1:8787`
- Private MCP HTTP: `127.0.0.1:8788` at `/mcp`, with localhost Host and Origin checks

Stdio and HTTP are the same process and the same token file. Logs go to stderr only.
