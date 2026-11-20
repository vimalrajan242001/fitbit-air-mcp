# Improvement review

Review date: 2026-10-29. Covers `src/`, `scripts/`, `README.md`, `docs/context.md`, CI, agent config files, and `package.json`.

Security review: 2026-10-31. Adds the Cloudflare Worker (`src/worker.ts`, `wrangler.toml`) and the deploy job. `npm audit`: 0 vulnerabilities. Secret scan and a git-history grep for client secrets and Google tokens: clean. The repo is public.

Resolved items are removed; see the git history of this file for them.

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
| 21 | P3 | Security (local) | Local `/mcp` and the login loopback trust every local process (accepted) | — |

---

## Security: local and operational (2026-10-31)

### 21. P3 — Local `/mcp` and the login loopback trust every local process

**Accepted:** no change for a single-user machine.

**Where:** `src/http.ts`, `src/oauth.ts` `waitForCallback`.

**Problem:** `127.0.0.1:8788/mcp` has no auth, so any process or user on the same machine can read your health data. Any local process can also send a wrong `state` to `127.0.0.1:8787` and abort a login in progress. This is acceptable on a single-user machine.

**Fix:** None needed for a personal machine. On a shared machine, use the Worker instead.

---

## Not issues (checked)

- OAuth: PKCE S256, `state` check, loopback only, 5-minute timeout, server closed in `finally`.
- Secrets: tokens redacted by key, `sanitizeText` on error messages, `0600` token file, `.gitignore` covers `tokens.json`, secret scan and gitleaks in CI.
- `macAddress` is dropped by the allowlist in `toSyncDevice` and again by `redact`.
- No calls to `api.fitbit.com`; `healthUrl` refuses other hosts.
- Worker: PKCE S256 to Google; the consent form handle is single-use and bound to the browser; the library sends no-framing headers; every client-controlled string on the consent page is escaped; error responses are `text/plain`.
- Worker: `apiHandler` strips the Google refresh token before the MCP server sees it; grant props are encrypted in KV; Worker secrets go through `wrangler secret`.
- Worker: the logged `/callback` URL can carry Google's one-time code, which is useless without the PKCE verifier and the client secret. Logging is kept.
- Date inputs are checked against `YYYY-MM-DD` and a real calendar day before they reach the sleep `filter` string, so the filter cannot be injected. Activity series names come from a fixed list.
- `openSystemBrowser` on Windows: the URL is percent-encoded, so `cmd start` cannot be used to inject commands.
- CI: `permissions: contents: read`; actions pinned to commit SHAs; `persist-credentials: false`; the commit message reaches the shell through `env`, so it cannot inject script; deploy runs only on pushes to `main`.
- `npm outdated`: only TypeScript 7 and `@types/node` 26 are newer. `@types/node` 22 matches `engines.node >=22`, so leave it.

## Not verified

- **Live settings (2026-10-31 review):** whether the Google OAuth app is in Testing mode and who its test users are, Cloudflare account settings and secret values, and the behavior of the deployed Worker. The review was code-only.
- **ngrok domain:** the removed tunnel mode's reserved domain is still in git history; release it in the ngrok dashboard.
- **API call shapes against Google's docs:** dailyRollUp body or query `pageToken`, the sleep `filter` syntax (`civil_end_time` with a bare date literal), whether int64 values come back as strings, and the location of the `ACCOUNT_NOT_LINKED` reason.
