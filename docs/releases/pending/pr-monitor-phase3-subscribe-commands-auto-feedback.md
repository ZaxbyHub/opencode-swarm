# PR Monitor — Phase 3: Subscribe Commands, auto_pr_feedback, and Bug Fixes

## What

Phase 3 of the GitHub PR Monitor (FR-001) adds user-facing subscription commands, an auto-injection mode for PR feedback, and a critical bug fix for MODE signal injection.

### New Commands (`src/commands/pr-subscribe.ts`, `pr-unsubscribe.ts`, `pr-monitor-status.ts`)

Three new `/swarm pr` commands for explicit session-scoped PR subscription management:

- **`/swarm pr subscribe <pr-url|owner/repo#N|N>`** — Subscribes the current session to PR monitoring. Accepts a full GitHub URL, `owner/repo#N` shorthand, or bare PR number (resolved against `origin`). Idempotent — re-subscribing the same PR returns the existing record without duplication. Requires `pr_monitor.enabled: true`. Uses `maxSubscriptions` from config.
- **`/swarm pr unsubscribe <pr-url|owner/repo#N|N>`** — Removes the current session's subscription to a PR. Uses `buildCorrelationId` to look up the subscription before calling `unsubscribe`.
- **`/swarm pr status`** — Lists all active PR subscriptions for the current session with relative time formatting ("5 minutes ago", "2 hours ago"). Shows per-subscription: PR URL, last-checked time, watching status, and error count. Also reports total active subscriptions across all sessions.

PR reference parsing is shared with `/swarm pr-review` and `/swarm pr-feedback` via `src/commands/pr-ref.ts`.

### New Config Flag (`src/config/schema.ts`)

Added `auto_pr_feedback` (default `false`) to `PrMonitorConfigSchema` (line 1501):

```json
"pr_monitor": {
  "enabled": true,
  "auto_pr_feedback": true
}
```

When `true`, the event subscribers inject `[MODE: PR_FEEDBACK pr="URL"]` signal on `pr.ci.failed` and `pr.merge.conflict` events, enabling automatic PR feedback mode for subscribed PRs.

### Bug Fix: prUrl in All Worker Event Payloads (`src/background/pr-monitor-worker.ts`)

All `publish()` calls in `PrMonitorWorker.computeChanges()` now include `prUrl: sub.prUrl` in their event payloads (lines 454, 503, 527, 540, 561, 574, 590, 605, 639, 663, 792). Previously, `prUrl` was missing from several event types, breaking `[MODE: PR_FEEDBACK pr="..."]` injection in `pr-event-subscribers.ts` because `payload.prUrl` was undefined.

Verified by `tests/unit/background/pr-monitor-worker.test.ts` — "PrMonitorWorker — prUrl in all event payloads" (lines 1534–1676).

### Bug Fix: maxSubscriptions Wired to Subscribe Command (`src/commands/pr-subscribe.ts`)

`handlePrSubscribeCommand` now reads `prMonitorConfig.max_subscriptions` and passes it to `subscribe()` (line 87). Previously, the subscribe command ignored the config and would not enforce the subscription cap.

### Skill Update: Step 6a in commit-pr SKILL (`.claude/skills/commit-pr/SKILL.md`)

Added Step 6a — "PR auto-subscribe reminder" (lines 289–297): After PR creation, if `pr_monitor.enabled: true`, the publisher is advised to run `/swarm pr subscribe <pr-url>` to start background monitoring. This is advisory only — it does not auto-subscribe.

## Why

Phase 1 landed config schema + subscription store. Phase 2 landed the polling worker + event subscribers. Phase 3 completes the user-facing layer:

- The subscribe/unsubscribe/status commands give users explicit, session-scoped control over which PRs are monitored — critical for multi-PR workflows and avoiding notification fatigue
- `auto_pr_feedback` enables a closed-loop pattern where CI failures and merge conflicts on subscribed PRs automatically trigger the PR_FEEDBACK mode, without requiring a separate `/swarm pr-feedback` invocation
- The `prUrl` fix was a correctness regression: without `prUrl` in payloads, the MODE signal could never be constructed, making `auto_pr_feedback` non-functional
- Wiring `maxSubscriptions` to the subscribe command ensures the cap is enforced at the user-facing entry point, not silently ignored

## Migration

No action for existing users. Phase 3 is fully additive:
- New commands are available when `pr_monitor.enabled: true`
- Set `auto_pr_feedback: true` to enable automatic PR_FEEDBACK injection on CI failures and merge conflicts
- Existing subscriptions continue working; the `prUrl` fix retroactively corrects payloads for all event types

## Invariant audit

- **1 (plugin init)** — not touched; no init-time work added
- **3 (subprocesses)** — not touched; no new subprocess calls
- **4 (.swarm containment)** — not touched; commands use `ctx.directory` from `createSwarmTool` pattern
- **7 (test writing)** — `_internals` DI seam on `loadPluginConfig` in `pr-subscribe.ts`; `formatRelativeTime` exposed via `_internals` in `pr-monitor-status.ts`
- **8 (session state)** — commands are session-scoped via `sessionID` parameter; subscription store is the authoritative state
- **11 (tool registration)** — three new commands registered in `src/commands/registry.ts`; no new tools added
