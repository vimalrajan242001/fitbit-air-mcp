# Improvement review

Review date: 2026-10-29. Covers `src/`, `scripts/`, `README.md`, `docs/context.md`, CI, agent config files, and `package.json`.
Baseline: `npm run check` passes (20/20 tests, typecheck, build). `npm audit`: 0 vulnerabilities. `npm run secret-scan`: clean.

Security review: 2026-10-31. Adds the Cloudflare Worker (`src/worker.ts`, `wrangler.toml`) and the deploy job. Items 18–23 are new; #1, #2, #3, and #16 were re-checked and are still open. `npm audit`: 0 vulnerabilities. Secret scan and a git-history grep for client secrets and Google tokens: clean. The repo is public.

## Priority key

| Priority | Meaning |
| --- | --- |
| **P0** | Exposes data or loses the login. Fix now. |
| **P1** | Breaks a documented workflow or gives the model wrong answers. |
| **P2** | Performance or robustness. Worth doing. |
| **P3** | Cleanup and tidiness. Do it when touching the file. |

## Summary

| # | Priority | Category | Issue | Effort |
| --- | --- | --- | --- | --- |
| 1 | P0 | Security | ~~Tunnel modes expose `/mcp` with no authentication~~ Resolved | S |
| 2 | P0 | Security | ~~Personal ngrok domain is committed in `package.json`~~ Resolved | XS |
| 3 | P0 | Reliability | ~~`tokens.json` is overwritten in place, not atomically~~ Resolved | XS |
| 4 | P1 | Reliability | Every stdio launch binds port 8788; a second client dies | S |
| 5 | P1 | Tooling | ~~`npm run tunnel` is PowerShell-only; README says it works on Mac~~ Resolved | XS |
| 6 | P1 | Correctness | `compare_periods` deltas ignore unequal data coverage | S |
| 7 | P1 | Correctness | `readToday` detects auth failures by matching message strings | XS |
| 8 | P1 | Correctness | Error handling differs across tools and the resource | S |
| 9 | P2 | Testing | `test/http.test.ts` binds the real port 8788 | XS |
| 10 | P2 | Robustness | No retry on 429 / 5xx | S |
| 11 | P2 | Robustness | `sleep_nights` has no range cap | XS |
| 12 | P2 | Performance | All Health API calls run sequentially | S |
| 13 | P3 | Maintainability | Pagination loop duplicated three times | S |
| 14 | P3 | Maintainability | `identityResult` duplicates the Health client and hardcodes the URL | XS |
| 15 | P3 | Maintainability | Small duplications: civil date formatting, server version, sums | XS |
| 16 | P3 | Tooling | CI: actions pinned by tag, double runs on PR pushes | XS |
| 17 | P3 | Docs | README inaccuracies | XS |
| 18 | P1 | Security (Worker auth) | Worker accepts any Google account | S |
| 19 | P1 | Security (Worker auth) | Open client registration allows consent phishing | S |
| 20 | P2 | Security (Worker abuse) | No rate limit on `/register` | XS |
| 21 | P3 | Security (local) | Local `/mcp` and the login loopback trust every local process | — |
| 22 | P3 | Security (logging) | Worker logs and tool errors can carry codes and local paths | XS |
| 23 | P3 | Security (CI) | Deploy job holds the Cloudflare token behind tag-pinned actions | XS |

Effort: XS < 15 min, S < 1 h.

---

## Security

### 1. P0 — Tunnel modes expose `/mcp` with no authentication

**Resolved:** tunnel mode removed (`npm run ngrok`, `npm run tunnel`, `scripts/start-tunnel.ps1`, README Mode 2). Remote access is the Worker, behind OAuth. The ngrok domain is still in git history; release it in the ngrok dashboard.

**Where:** `src/http.ts`, `package.json` (`ngrok`), `scripts/start-tunnel.ps1`, README "Mode 2".

**Problem:** The only protection on `/mcp` is `localhostHostValidation` plus `localhostOriginValidation`. Both tunnel scripts rewrite the Host header to `127.0.0.1:8788`, which gets past the Host check. Non-browser clients send no `Origin`, which gets past the Origin check. The README presents this as a supported mode for ChatGPT and other machines. Result: anyone who learns the tunnel URL can call `sync_status`, `sleep_nights`, `daily_activity`, and `connection_status`, and the server pays for each call with your token.

**Re-checked 2026-10-31:** Still open. The library code confirms that a request with no `Origin` header passes. Now that the Worker (README "Mode 4") is deployed with OAuth, the smallest fix is to delete the tunnel path: the `ngrok` and `tunnel` scripts, `scripts/start-tunnel.ps1`, and README "Mode 2".

**Fix (if tunnels stay):** Add a random secret to the path, e.g. `/mcp/<32+ random chars>`, read from the env file as `MCP_PATH_SECRET`. Compare with `crypto.timingSafeEqual`. A secret path works with every client, including ChatGPT connectors, which accept only OAuth or no auth and so can't send a static bearer header. Clients that do support headers could also use an `Authorization: Bearer` check.

### 2. P0 — Personal ngrok domain committed in `package.json`

**Resolved:** tunnel mode removed (`npm run ngrok`, `npm run tunnel`, `scripts/start-tunnel.ps1`, README Mode 2). Remote access is the Worker, behind OAuth. The ngrok domain is still in git history; release it in the ngrok dashboard.

**Where:** `package.json` `scripts.ngrok` (`--url=https://dangling-down-bodacious.ngrok-free.dev`).

**Problem:** Combined with #1, the public repo tells anyone your live endpoint. It also breaks `npm run ngrok` for any other clone.

**Fix:** Read the domain from an env var (`ngrok http 8788 --url=$NGROK_URL ...`), or drop `--url` and let ngrok assign one. Consider moving to a new reserved domain, since this one is in git history.

---

## Reliability

### 3. P0 — `tokens.json` is not written atomically

**Resolved:** `writeTokenFile` writes `tokens.json.<pid>.tmp` and renames it over `tokens.json`.

**Where:** `src/tokens.ts` `writeTokenFile`.

**Problem:** `writeFileSync` truncates and then writes. A crash or kill mid-write leaves invalid JSON, and every tool then fails with "Run npm run login again". The `enqueue` lock only covers one process, so a second process (another MCP client) can read a half-written file.

**Fix:** Write to `tokens.json.<pid>.tmp` with mode `0o600`, then `renameSync` it over `tokens.json`. Two lines.

### 4. P1 — Every stdio launch binds port 8788

**Where:** `src/index.ts` `main()`.

**Problem:** HTTP is always started before stdio. With two stdio clients (Cursor and Claude Desktop, or two Cursor windows), the second process gets `EADDRINUSE` and exits, so its stdio server never starts. The README documents this as a known conflict instead of fixing it.

**Fix:** Serve HTTP only on request (`node dist/index.js http`, with `npm start` mapped to it), or log the bind failure and keep stdio running.

---

## Correctness

### 5. P1 — `npm run tunnel` only works on Windows

**Resolved:** removed with the tunnel mode (#1).

**Where:** `package.json` `scripts.tunnel`, `scripts/start-tunnel.ps1`.

**Problem:** It calls `powershell` and `Get-NetTCPConnection`. The README lists it under host-machine steps for Mac or Windows.

**Fix:** Replace the script with the single command it runs:
`cloudflared tunnel --url http://127.0.0.1:8788 --http-host-header 127.0.0.1:8788 --no-autoupdate`. Delete the `.ps1`. Do this after #1.

### 6. P1 — `compare_periods` deltas ignore coverage

**Where:** `src/activity.ts` `comparePeriods`, `activityTotals`.

**Problem:** If period A has 7 days of samples and period B has 4, `stepsCountSum` drops by about 40% and the model reports a real decline. The `missing` arrays are there, but deltas are presented as comparable.

**Fix:** Add `daysWithData` per series to `ActivityTotals`, or per-day averages next to the sums. Mention it in the tool description.

### 7. P1 — `readToday` matches error message strings

**Where:** `src/today.ts` (`entry.reason === 'phone setup unfinished' || ... 'login due'`).

**Problem:** It depends on exact message text from `health.ts` and `tokens.ts`. Rewording either one silently turns an auth failure into three more failing calls.

**Fix:** Return `authStopped` (already computed) from `readDailyActivity` and branch on it.

### 8. P1 — Inconsistent error handling

**Where:** `src/server.ts` (`connection_status`, `sync_status`, `fitbit://today`), `src/devices.ts`, `src/today.ts`.

**Problem:** Three tools use `toolError`; two tools and the resource don't. `getAccessToken` throws plain `Error` for a corrupt token file (`readTokenFile`) or a missing env file (`loadOAuthClient`). Those escape `readSyncStatus` and `readToday` (they only catch `HealthCallError`), so behaviour then depends on how the SDK formats the exception.

**Fix:** Wrap every handler in the same `try`/`toolError`. For the resource, return `{ missing: [{ reason }] }` JSON instead of throwing.

---

## Testing

### 9. P2 — `test/http.test.ts` binds the real port

**Where:** `test/http.test.ts`, README "Verification" tip.

**Problem:** `npm run check` fails while Cursor (or `npm start`) is running. The README works around this instead of fixing it.

**Fix:** Listen on port `0` in the test and read the assigned port from `server.address()`. `createMcpHttpServer` already leaves binding to the caller.

---

## Robustness and performance

### 10. P2 — No retry on 429 / 5xx

**Where:** `src/health.ts` `request`.

**Problem:** Transient failures go straight to `missing` or to an error.

**Fix:** One retry after a short delay (honour `Retry-After` if present) for 429, 500, 502, 503, and 504.

### 11. P2 — `sleep_nights` range is unbounded

**Where:** `src/sleep.ts` `readSleepNights`.

**Problem:** Activity is capped at 7 days; sleep isn't. A one-year request makes up to 25 sequential pages and returns a very large result to the model.

**Fix:** Cap at about 31 days with the same error style as `assertActivityRange`.

### 12. P2 — All Health API calls are sequential

**Where:** `src/activity.ts` (5 series), `comparePeriods` (2 × 5), `src/today.ts` (settings, then activity, sleep, and sync).

**Problem:** Latency adds up: about 10 sequential POSTs for `compare_periods`.

**Fix:** `Promise.all` over series and periods, and over sleep and sync in `readToday`. Token refresh is already serialized by `enqueue`, so this is safe. The auth-stop logic in `readDailyActivity` then needs to look at all results after they settle (`Promise.allSettled`).

---

## Maintainability

### 13. P3 — Pagination loop duplicated

**Where:** `activity.ts` `rollUp`, `devices.ts` `listPairedDevices`, `sleep.ts` `reconcileSleep`.

**Fix:** One `paginate(fetchPage, maxPages, coverageMessage)` helper in `health.ts`.

### 14. P3 — `identityResult` duplicates the Health client

**Where:** `src/oauth.ts` `identityResult`.

**Problem:** It hardcodes `https://health.googleapis.com/v4/users/me/identity` instead of `HEALTH_API_BASE`, and repeats the JSON parsing from `readHealthJson`.

**Fix:** Use `healthUrl('/users/me/identity')` and the shared JSON reader.

### 15. P3 — Small duplications

- `sleep.ts` `civilEndDate` re-implements `formatCivilDate`.
- `server.ts` hardcodes version `'0.1.0'`; `package.json` has it too.
- `activityTotals` and `subtractTotals` repeat the filter-and-sum block about six times; one `sum()` helper shortens both.
- `toHealthError` checks `safe.includes(token)` after `sanitizeText` already removed the token.

---

## Tooling and docs

### 16. P3 — CI

**Where:** `.github/workflows/check.yml`.

- `on: [push, pull_request]` runs twice for PR branches. Limit `push` to `main`.
- Actions are pinned by tag (`@v4`, `@v2`); pin to commit SHAs for supply-chain safety. The deploy job now makes this a security item: see #23.

### 17. P3 — README inaccuracies

- The Mode 1 `envFile` setting is unused: the server reads `~/.config/fitbit-air-mcp/env` itself.

---

## Security: Cloudflare Worker (2026-10-31)

### 18. P1 — Worker accepts any Google account

**Where:** `src/worker.ts` `OWNER` and the `/callback` branch (`completeAuthorization`).

**Problem:** Every grant is stored under the fixed user `'owner'`, and the code never checks which Google account signed in. Only the Google Cloud console blocks strangers: in Testing mode, only listed test users can sign in. If the OAuth app is published, or more test users are added, anyone can use this Worker to read their own data under your app's name and quota. They cannot see your data.

**Fix:** After `exchangeCode`, call `/users/me/identity` with the new access token and compare the result to an `OWNER_HEALTH_USER_ID` Worker secret. Refuse before `completeAuthorization` if it does not match.

### 19. P1 — Open client registration allows consent phishing

**Where:** `src/worker.ts` `clientRegistrationEndpoint: '/register'`.

**Problem:** Anyone can register a client whose `redirect_uri` points to their own server, then send you an `/authorize` link. The consent page names the destination host, as the library requires, and Google's consent screen follows. If you click through both, the attacker gets an MCP token, refreshable for 7 days, for your data.

**Fix:** Add a `clientRegistrationCallback` that only accepts redirect hosts you use (for example `claude.ai`, `chatgpt.com`, and loopback).

### 20. P2 — No rate limit on `/register`

**Where:** `src/worker.ts`, Cloudflare zone settings.

**Problem:** Registration is unauthenticated. A script can write many client records to `OAUTH_KV`, each kept for the 90-day registration TTL. That costs KV writes and storage, and it adds no access.

**Fix:** Add a Cloudflare rate-limiting rule on `POST /register`. #19 also reduces it.

## Security: local and operational (2026-10-31)

### 21. P3 — Local `/mcp` and the login loopback trust every local process

**Where:** `src/http.ts`, `src/oauth.ts` `waitForCallback`.

**Problem:** `127.0.0.1:8788/mcp` has no auth, so any process or user on the same machine can read your health data. Any local process can also send a wrong `state` to `127.0.0.1:8787` and abort a login in progress. This is acceptable on a single-user machine.

**Fix:** None needed for a personal machine. On a shared machine, use the Worker instead.

### 22. P3 — Worker logs and tool errors can carry codes and local paths

**Where:** `wrangler.toml` `[observability]`, `src/status.ts` (`missing[].reason`).

**Problem:** With Workers observability on, the logged `/callback` request URL can include Google's one-time authorization code. The code cannot be used without the PKCE verifier and the client secret, so the risk is low. Separately, `connection_status` can return messages that include the local env-file path to the model.

**Fix:** Optional. Turn off request-URL logging, or accept it as is. Use a fixed reason such as `env file missing` in place of the full path.

### 23. P3 — Deploy job holds the Cloudflare token behind tag-pinned actions

**Where:** `.github/workflows/check.yml` `deploy` job.

**Problem:** `CLOUDFLARE_API_TOKEN` is used in a job that runs `actions/checkout@v4` and `actions/setup-node@v4` by tag. A moved tag would run new code before the deploy step. `checkout` also leaves `GITHUB_TOKEN` in `.git/config` while `npm ci` install scripts run.

**Fix:** Pin actions to commit SHAs. Set `persist-credentials: false` on both checkouts.

---

## Not issues (checked)

- OAuth: PKCE S256, `state` check, loopback only, 5-minute timeout, server closed in `finally`.
- Secrets: tokens redacted by key, `sanitizeText` on error messages, `0600` token file, `.gitignore` covers `tokens.json`, secret scan and gitleaks in CI.
- `macAddress` is dropped by the allowlist in `toSyncDevice` and again by `redact`.
- No calls to `api.fitbit.com`; `healthUrl` refuses other hosts.
- Worker: PKCE S256 to Google; the consent form handle is single-use and bound to the browser; the library sends no-framing headers; every client-controlled string on the consent page is escaped; error responses are `text/plain`.
- Worker: `apiHandler` strips the Google refresh token before the MCP server sees it; grant props are encrypted in KV; Worker secrets go through `wrangler secret`.
- Date inputs are checked against `YYYY-MM-DD` and a real calendar day before they reach the sleep `filter` string, so the filter cannot be injected. Activity series names come from a fixed list.
- `openSystemBrowser` on Windows: the URL is percent-encoded, so `cmd start` cannot be used to inject commands.
- CI: `permissions: contents: read`; the commit message reaches the shell through `env`, so it cannot inject script; deploy runs only on pushes to `main`.
- `npm outdated`: only TypeScript 7 and `@types/node` 26 are newer. `@types/node` 22 matches `engines.node >=22`, so leave it.

## Not verified

- **Live settings (2026-10-31 review):** whether the Google OAuth app is in Testing mode and who its test users are (#18), Cloudflare account settings and secret values, and the behavior of the deployed Worker. The review was code-only.
- **API call shapes against Google's docs:** dailyRollUp body or query `pageToken`, the sleep `filter` syntax (`civil_end_time` with a bare date literal), whether int64 values come back as strings, and the location of the `ACCOUNT_NOT_LINKED` reason.
- **Test contents:** only the pass count was confirmed. Coverage of `compare_periods`, the 401 retry path, and the auth-stop branch is unknown.
