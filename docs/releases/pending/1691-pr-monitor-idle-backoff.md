---
title: PR-monitor idle backoff
issue: 1691
---

## What changed

PR-monitor previously made 4 `gh` subprocess calls per subscribed PR on every 60s poll cycle, regardless of activity. Now uses adaptive idle backoff: after 3+ consecutive no-change polls, the PR is polled less frequently (every 2nd, 3rd, or 5th cycle). Any detected change resets the counter immediately.

## Backoff schedule

| Idle polls | Poll frequency | gh call reduction |
|---|---|---|
| 0-2 | Every cycle | 0% |
| 3-5 | Every 2nd cycle | 50% |
| 6-9 | Every 3rd cycle | 67% |
| 10+ | Every 5th cycle | 80% |

## Acceptance

PR-monitor's steady-state call volume measurably drops for an idle PR. Active PRs (with changes detected) are still polled every cycle.
