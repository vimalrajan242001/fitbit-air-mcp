# Feature ideas

Brainstorm date: 2026-11-01. Covers the five tools and `fitbit://today` as of #9. Ideas 1-4 are built (`granularity: "week"`, baseline, `compare_periods` removed); the rest are not. Items marked **Ask first** need sign-off under `CLAUDE.md` (new tool or new scope).

## The problem

The tools return raw rollups in API units for at most 7 days, with no notion of the user's normal. The question asked most is "how am I trending?" Answering it for one month took 5 tool calls, about 45k characters of JSON, and hand arithmetic by the model.

A 28-day live pull also showed:

- Naps come back as extra sessions on the same date. Averaging every session per date skews "nightly" sleep.
- Data is dense: one missing series-day in 28. Per-user baselines are viable.

## Ideas

| # | Category | Idea | Effort | Needs |
| --- | --- | --- | --- | --- |
| 1 | Trends | `granularity: "week"` on `daily_activity`: up to ~13 weeks, paged inside the server, per-week daily averages and `daysWithData`, no per-day rows | S | — |
| 2 | Trends | `granularity: "week"` on `sleep_nights`: longest session per date is the main sleep, naps reported apart, median bedtime and its spread | S | — |
| 3 | Trends | 28-day baseline (median and typical range) next to each series, worded descriptively | S | — |
| 4 | Trends | Retire `compare_periods` once 1 lands; it mostly works around the 7-day cap | XS | — |
| 5 | Readability | Add `km` and hours next to `millimetersSum` and minutes | XS | — |
| 6 | Reliability | Add a `loginDue` warning to every result when the refresh token expires within 48 h | XS | — |
| 7 | Reliability | Publish the Google app to end the 7-day Testing-mode expiry | L | Verification |
| 8 | Workflows | MCP prompts ("weekly review", "sleep check") that chain existing tools | XS | — |
| 9 | Recovery | `recovery_day`: resting heart rate, daily HRV, daily SpO2 (the planned next slice) | M | **Ask first** |
| 10 | Recovery | Workouts / exercise sessions | M | **Ask first** |

Effort: XS < 15 min, S < 1 h, M < 1 day, L = days and outside the code.

## Recommended order

1. **1 + 2 + 5** as one change. Biggest gain for the least code, no new tool or scope.
2. **6.** A tool that silently stops working once a week loses trust faster than any missing feature.
3. **3**, then **4**.
4. **9** as the next real feature, after sign-off. It answers a new question ("am I recovered?") instead of improving an old one.

## Risks

- Main sleep as "longest session per date" is wrong when a nap outlasts a broken night.
- A baseline reads easily as "abnormal". Keep wording to "below your 28-day median"; no score, no diagnosis.
- Weekly output must stay small enough that 13 weeks fits in one result.

## Set aside

- MCP Apps / UI widgets: nice, not the bottleneck.
- Goals and streaks: need write access or local state.
- Everything on the `CLAUDE.md` "Never" list.
