# Fitbit Air MCP

A local [Model Context Protocol](https://modelcontextprotocol.io) server that reads one person’s Fitbit Air data through the [Google Health API](https://developers.google.com/health/about). Cursor, or any other stdio client, starts it. The same process also serves streamable HTTP on `127.0.0.1:8788` and nowhere else.

This is a personal-use server for one Google account in OAuth Testing mode. The public repository must never contain the OAuth client id, the client secret, a refresh token, an access token, or `tokens.json`.

The band syncs to the Google Health app. This process does not pair with it, and it does not call `api.fitbit.com`.

## What it exposes

| Tool | What it returns |
| --- | --- |
| `connection_status` | Whether Health is linked, granted scopes, access-token expiry, and the 7-day login deadline |
| `sync_status` | Tracker product name, battery, last sync time, and feature flags |
| `daily_activity` | Steps, distance, active zone minutes, active minutes, and total calories for up to 7 civil days |
| `sleep_nights` | In-bed and asleep minutes, stage minutes, and short awakenings |
| `compare_periods` | Two daily-activity ranges, their totals, and the deltas |

`fitbit://today` is a short snapshot: today’s steps and zone minutes, last night’s sleep, and the last sync time. It is not a Sleep Score and it is not a diagnosis.

A day with no wearable samples is reported as missing, not as zero. The hardware address on a paired device is removed before the result is built. Tokens are never returned.

## Setup on Windows

Install Node.js 22 or newer. Put this project at `%USERPROFILE%\fitbit-air-mcp` so the Cursor config below matches.

Create the env file outside the repo. Put the client id and client secret from Google Cloud on their own lines. Do not commit that file.

```bat
mkdir "%USERPROFILE%\.config\fitbit-air-mcp"
notepad "%USERPROFILE%\.config\fitbit-air-mcp\env"
icacls "%USERPROFILE%\.config\fitbit-air-mcp\env" /inheritance:r /grant:r "%USERNAME%:(R,W)"
```

The file looks like this, with your own values in place of the placeholders:

```
GOOGLE_OAUTH_CLIENT_ID=<client id from Google Cloud>
GOOGLE_OAUTH_CLIENT_SECRET=<client secret from Google Cloud>
```

The OAuth client is a Desktop client, or a Web client whose redirect URI is exactly `http://127.0.0.1:8787`. The Google account must be a test user on a Testing consent screen. Publish stays off.

From the project directory:

```bat
cd /d "%USERPROFILE%\fitbit-air-mcp"
npm ci
npm run build
npm run login
npm start
```

`npm run login` opens the browser, listens on `127.0.0.1:8787`, and writes `%USERPROFILE%\.config\fitbit-air-mcp\tokens.json` for the owner only. It then exits. Sign in as the test user and accept the unverified-app warning.

If login says the redirect URI does not match, the client is a Web client: add `http://127.0.0.1:8787` exactly. Do not create a new Cloud project.

If login says phone setup is unfinished, open the Google Health app and finish linking the Google account, then run `npm run login` again.

Testing-mode refresh tokens last 7 days. When `connection_status` says login is due, run `npm run login` again.

`npm start` keeps stdio and `http://127.0.0.1:8788/mcp` up. Cursor starts the same command itself, so do not run `npm start` at the same time as Cursor or the second process will not be able to bind port 8788.

On Linux and macOS the env directory is `~/.config/fitbit-air-mcp/` and the commands are `npm ci`, `npm run build`, `npm run login`, and `npm start`.

## Cursor

User-level config, `~/.cursor/mcp.json` (on Windows, `%USERPROFILE%\.cursor\mcp.json`). The env file stays outside the repo.

```json
{
  "mcpServers": {
    "fitbit-air": {
      "type": "stdio",
      "command": "node",
      "args": ["${userHome}/fitbit-air-mcp/dist/index.js"],
      "envFile": "${userHome}/.config/fitbit-air-mcp/env"
    }
  }
}
```

Other stdio clients use the same `node` command. Logs are written to stderr because stdout is the MCP protocol.

## Checks

```bat
npm ci
npm run check
```

`npm run check` runs typecheck, tests, and the build. Tests use published Google Health JSON examples. They do not call Google and they do not contain credentials.

`tsconfig` sets `"types": ["node"]` so the project typechecks on TypeScript 6 and later.

GitHub Actions runs `npm ci`, `npm run check`, a secret scan, and gitleaks. A secret match fails the workflow.

## Account time zone

`fitbit://today` uses the `timeZone` from `GET /users/me/settings`. Daily activity uses `dailyRollUp`, which follows the civil day stored with each sample.

More detail for later edits is in [docs/context.md](docs/context.md). Agents should start with [AGENTS.md](AGENTS.md).
