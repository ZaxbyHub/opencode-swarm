---
title: PR-monitor idle backoff
issue: 1660
---

## What changed

PR-monitor previously made 4 `gh` subprocess calls per subscribed PR on every 60s poll cycle, regardless of activity. Now uses adaptive idle backoff: after 3+ consecutive no-change polls, the PR is polled less frequently (every 2nd or 3rd cycle). Any detected change resets the counter immediately.

## Backoff schedule

| Idle polls | Poll frequency | gh call reduction |
|---|---|---|
| 0-2 | Every cycle | 0% |
| 3-5 | Every 2nd cycle | 50% |
| 6+ | Every 3rd cycle | 67% |

The 10+ tier (previously every 5th cycle / 80% reduction) is collapsed into the 6+ tier at a 3× cap per General Council — the council rejected 5 minutes of blind polling on a watch feature as excessive. Worst-case interval is now ~180s at the default 60s base interval.

## Acceptance

PR-monitor's steady-state call volume measurably drops for an idle PR. Active PRs (with changes detected) are still polled every cycle.