# Fitbit Air MCP

## Commands

- `npm ci` installs dependencies.
- `npm run check` runs typecheck, then tests, then the build. Use this before finishing an edit.
- `npm test -- test/sleep.test.ts` runs one test file.
- `npm run login` runs the browser consent flow and exits. It does not speak MCP.
- `npm start` serves stdio and `http://127.0.0.1:8788/mcp`.

## Map

- `src/index.ts` starts login or the servers.
- `src/server.ts` is `createFitbitServer()`.
- `src/oauth.ts` is the PKCE loopback login.
- `src/health.ts` is the Health API client.
- `src/activity.ts`, `src/sleep.ts`, `src/devices.ts`, and `src/today.ts` are the reads.
- `docs/context.md` is the longer brief. Read it before changing a call shape.
- `.agents/skills/add-health-tool/SKILL.md` is for adding a tool.

## API

Google Health API base: `https://health.googleapis.com/v4`.

Scopes:

- `https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly`
- `https://www.googleapis.com/auth/googlehealth.sleep.readonly`
- `https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly`
- `https://www.googleapis.com/auth/googlehealth.profile.readonly`
- `https://www.googleapis.com/auth/googlehealth.settings.readonly`

OAuth loopback: `127.0.0.1:8787`. Private MCP HTTP: `127.0.0.1:8788`.

Env file: `~/.config/fitbit-air-mcp/env` (`%USERPROFILE%\.config\fitbit-air-mcp\env` on Windows). Token file: `tokens.json` in that same directory. Both stay outside this repo.

## Always

- Read the official pages linked from `docs/context.md` before inventing a call shape.
- Page inside the server.
- Strip `macAddress` before a tool result is built.
- Log to stderr only.

## Ask first

- A new dependency.
- A new OAuth scope.
- A new tool.

## Never

- Commit or print the client secret, a refresh token, an access token, or `tokens.json`.
- Call `api.fitbit.com`.
- Add write, delete, GPS, irregular-rhythm, nutrition, ECG, heart-rate series, HRV, or SpO2 in this slice.
- Present a Sleep Score or a medical diagnosis.
