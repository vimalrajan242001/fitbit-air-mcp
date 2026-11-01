# Fitbit Air MCP

A personal [Model Context Protocol](https://modelcontextprotocol.io) server that reads Fitbit Air data through the [Google Health API](https://developers.google.com/health/about).

It supports:
- **Local stdio mode:** Launched directly by Cursor, Claude Desktop, or other stdio MCP clients.
- **Streamable HTTP mode (`/mcp`):** Listens on `127.0.0.1:8788` for local HTTP connections.
- **Remote mode:** A Cloudflare Worker serves `/mcp` behind OAuth, so clients on any machine sign in from the client.

The band syncs to the Google Health mobile app. This MCP server communicates with the Google Health API; it does not pair with the tracker directly and it never calls `api.fitbit.com`.

---

## Capabilities

| Tool | What it returns |
| --- | --- |
| `connection_status` | Whether Health is linked, granted scopes, access-token expiry, and the 7-day login deadline |
| `sync_status` | Tracker product name, battery, last sync time, and feature flags |
| `daily_activity` | Steps, distance, active zone minutes, active minutes, and total calories for up to 7 civil days, or weekly averages for up to 91 days with a 28-day baseline (`granularity: "week"`) |
| `sleep_nights` | In-bed and asleep minutes, stage minutes, and short awakenings, or weekly main-sleep averages, median bedtime, and naps for up to 91 days (`granularity: "week"`) |

| Resource | What it returns |
| --- | --- |
| `fitbit://today` | Snapshot of today's steps, active zone minutes, last night's sleep, and last tracker sync time |

*Note: Missing days in wearable data are reported as missing, not as zero. Hardware MAC addresses are stripped before responses are returned. Credentials and tokens are never returned.*

---

## Prerequisites

1. **Node.js 22 or newer** installed.
2. **Google Cloud Project** with:
   - Google Health API enabled.
   - OAuth 2.0 Client (Desktop app or Web app).
   - Authorized redirect URI set exactly to `http://127.0.0.1:8787`.
   - OAuth consent screen configured in **Testing** mode with your Google account added as a test user.

---

## Setup

Credentials stay **outside the repository** in your user directory. Never commit credentials or tokens.

### On Windows

1. Create the environment folder and file:
   ```cmd
   mkdir "%USERPROFILE%\.config\fitbit-air-mcp"
   notepad "%USERPROFILE%\.config\fitbit-air-mcp\env"
   ```
2. Restrict file permissions to your user account:
   ```cmd
   icacls "%USERPROFILE%\.config\fitbit-air-mcp\env" /inheritance:r /grant:r "%USERNAME%:(R,W)"
   ```
3. Add your Google OAuth credentials to `%USERPROFILE%\.config\fitbit-air-mcp\env`:
   ```env
   GOOGLE_OAUTH_CLIENT_ID=your-client-id.apps.googleusercontent.com
   GOOGLE_OAUTH_CLIENT_SECRET=your-client-secret
   ```
4. Install dependencies and build:
   ```cmd
   npm ci
   npm run build
   ```
5. Authenticate with Google:
   ```cmd
   npm run login
   ```
   *This opens your browser for PKCE consent on `http://127.0.0.1:8787` and writes `%USERPROFILE%\.config\fitbit-air-mcp\tokens.json`.*

### On macOS / Linux

1. Create the environment folder and file:
   ```bash
   mkdir -p ~/.config/fitbit-air-mcp
   nano ~/.config/fitbit-air-mcp/env
   ```
2. Restrict file permissions:
   ```bash
   chmod 600 ~/.config/fitbit-air-mcp/env
   ```
3. Add your credentials:
   ```env
   GOOGLE_OAUTH_CLIENT_ID=your-client-id.apps.googleusercontent.com
   GOOGLE_OAUTH_CLIENT_SECRET=your-client-secret
   ```
4. Install dependencies, build, and login:
   ```bash
   npm ci
   npm run build
   npm run login
   ```

---

## Usage Modes

### Mode 1: Local Stdio Client (Cursor / Claude Desktop)

In this mode, your MCP client launches the server as a local child process.

Configure `~/.cursor/mcp.json` (macOS) or `%USERPROFILE%\.cursor\mcp.json` (Windows):

```json
{
  "mcpServers": {
    "fitbit-air": {
      "type": "stdio",
      "command": "node",
      "args": ["${userHome}/fitbit-air-mcp/dist/index.js"]
    }
  }
}
```

> [!NOTE]
> When Cursor runs `fitbit-air-mcp` via stdio, the process also binds port `8788`. A second stdio client (or `npm start`) finds the port taken, logs it, and serves stdio only.

---

### Mode 2: Running Standalone on a Second Machine

If you want the second machine (Mac or Windows) to run the server completely standalone without keeping your primary computer on:

1. Install Node.js 22+ on the new machine.
2. Clone this repository onto the new machine.
3. Follow the **Setup** section above to create `~/.config/fitbit-air-mcp/env` with the same Google OAuth credentials.
4. Run `npm ci`, `npm run build`, and `npm run login` to authenticate directly from that machine.
5. Add the local stdio configuration to Cursor.

---

### Mode 3: Cloudflare Workers (use from anywhere, sign in from the client)

The Worker (`src/worker.ts`) is an MCP OAuth server in front of Google. When a client connects, it opens a consent page, then Google sign-in. No `npm run login`, no PC left running. It runs on the free Workers plan, and no card is needed.

One-time deploy:

1. `npx wrangler login`
2. `npx wrangler kv namespace create OAUTH_KV`, then put the id in `wrangler.toml`.
3. `npx wrangler secret put GOOGLE_OAUTH_CLIENT_ID`, `npx wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET`, and `npx wrangler secret put CONSENT_SECRET` (32+ random characters; it signs the cookie that remembers your approval), and `npx wrangler secret put OWNER_HEALTH_USER_ID` (your `healthUserId`; the Worker refuses every other Google account. While it is unset, every sign-in is refused and the error page shows the signed-in account's `healthUserId`, so connect once to read yours)
4. `npm run deploy`. Copy the `https://fitbit-air-mcp.<you>.workers.dev` URL into `PUBLIC_URL` in `wrangler.toml`, then run `npm run deploy` again.
5. In Google Cloud Console, add `https://fitbit-air-mcp.<you>.workers.dev/callback` to the OAuth client's **Authorized redirect URIs**. Keep the consent screen's test users to your own account: they are the only people who can sign in.

Connect:

- **Claude Code:** `claude mcp add --transport http fitbit-air https://fitbit-air-mcp.<you>.workers.dev/mcp`, then run `/mcp` and sign in.
- **claude.ai (web and mobile):** Settings → Connectors → Add custom connector, using the same URL.

The consent page appears once per client per 30 days in each browser. After that, reconnecting goes straight to Google.

While the Google app is in Testing mode, access ends after 7 days. When that happens, the client asks you to reconnect, and you sign in again from the client.

Auto-deploy: every push to `main` runs the checks, deploys, then smoke-tests `/.well-known/oauth-authorization-server` (200) and `/mcp` (401). One-time setup:

1. Create a Cloudflare API token from the "Edit Cloudflare Workers" template.
2. In GitHub, go to Settings → Environments → `production`, and add the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
3. To get an email on success as well as failure, go to GitHub → Settings → Notifications → Actions and untick "Only notify for failed workflows".

Local run: `npm run dev:worker -- --var PUBLIC_URL:http://localhost:8790` (secrets go in `.dev.vars`, which is git-ignored).

---

## Token Lifecycle (7-Day Expiry)

In Google Cloud OAuth **Testing mode**, refresh tokens expire **every 7 days**:
- When `connection_status` reports that login is due, run:
  ```bash
  npm run login
  ```
- Complete the browser consent prompt to generate a fresh 7-day token.

---

## Verification & Checks

Before submitting changes, run the validation harness:
```bash
npm ci
npm run check
```
`npm run check` runs:
1. TypeScript typecheck (`tsc --noEmit`).
2. Node.js unit and integration tests (20 tests covering activity, sleep, devices, auth, harness, and secrets).
3. Production build (`tsc -p tsconfig.build.json`).

---

## Troubleshooting

- **`Port 8788 is already in use ... Serving stdio only`**: Another server or Cursor instance holds port 8788. Stdio still works; stop the other process if you need HTTP from this one.
- **`redirect_uri_mismatch`**: Your Google OAuth client must have `http://127.0.0.1:8787` listed under Authorized redirect URIs.

---

## Agents & Contributing

Agents working on this repository must read [AGENTS.md](AGENTS.md) and adhere to the minimal change standards. Technical context on the Google Health API data models is in [docs/context.md](docs/context.md).
