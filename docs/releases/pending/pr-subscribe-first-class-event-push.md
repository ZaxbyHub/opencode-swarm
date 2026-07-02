# First-class PR subscriptions: pushed events, full event coverage, auto-subscribe, and the swarm-pr-subscribe skill

## What changed

- **PR events can now wake the subscribed session** (`src/background/pr-event-delivery.ts`,
  `src/index.ts`): a new `pr_monitor.event_delivery` mode (`'prompt'`, the default;
  `'advisory'` preserves the old behavior) delivers monitor events as a structured
  `<pr-activity …>` message injected via the OpenCode SDK (`session.promptAsync`,
  falling back to `session.prompt`), so an idle subscribed session starts a turn
  and acts on the event instead of waiting for the next user message. Delivery is
  idle-aware: events for a busy session are queued (bounded, deduped, per-session)
  and flushed coalesced on `session.idle`. Wake failures fall back to the legacy
  advisory channel — one channel is chosen per delivery attempt (at-least-once:
  a wake accepted after the acceptance timeout can duplicate onto the advisory
  channel; duplicates share a dedup token and triage as no-ops).

- **All nine detected PR event types are now delivered** (`src/background/pr-event-subscribers.ts`):
  previously only `pr.ci.failed`, `pr.new.comment`, and `pr.merge.conflict` had bus
  subscribers; review state changes, merge/close, CI success, and conflict-resolved
  events were computed by the worker and silently dropped — despite the subscribe
  command promising them. New config gates: `notify_review_activity` (default true,
  covers `pr.review.changes_requested` and `pr.review.approved`), `notify_merged`
  (true), `notify_closed` (true), `notify_ci_success` (false — quiet by default),
  and `pr.merge.conflict_resolved` under the existing `notify_merge_conflict`.
  Merged/closed advisories are marked TERMINAL.

- **Auto-subscribe after PR creation** (`src/hooks/pr-auto-subscribe.ts`): when
  `pr_monitor.enabled` and `pr_monitor.auto_subscribe_on_pr_create` (default true),
  a toolAfter hook detects a successful `gh pr create` in bash output and
  subscribes the session to the new PR automatically (idempotent; lazy-starts the
  polling worker).

- **`/swarm pr subscribe` and `/swarm pr unsubscribe` are agent-invocable**
  (`src/commands/registry.ts`): toolPolicy moved from `human-only` to `agent`,
  matching the state-of-the-art pattern where the agent subscribes itself when
  asked to watch, babysit, or autofix a PR. Caps (`max_subscriptions`) and
  idempotency bound the blast radius. Command and success text now accurately
  describe which events are delivered under which gates.

- **New bundled skill `swarm-pr-subscribe`** (`.opencode/skills/swarm-pr-subscribe/SKILL.md`,
  with `.claude`/`.agents` adapters): the final hop of the PR lifecycle
  (commit-pr → swarm-pr-review → swarm-pr-feedback → swarm-pr-subscribe). It owns
  the monitoring protocol: event intake formats, triage taxonomy (clear fix →
  route through swarm-pr-feedback discipline; ambiguous → ask the user;
  duplicate/no-op → acknowledge quietly), 3-strike bounded-retry escalation,
  injected-events-are-not-approval rule, and terminal-state cleanup. commit-pr
  Step 6a, swarm-pr-review, and swarm-pr-feedback now cross-link the lifecycle.

- **Subscription-sweep leak fixed**: `hasUnaddressedEvents` was set on every
  event and never cleared, making subscriptions permanently TTL-sweep-immune.
  It is now cleared after successful delivery.

- **Doc drift fixed** (`docs/configuration.md`): the pr_monitor section claimed a
  `CancellationToken` with SIGTERM/SIGINT handlers; the worker actually uses
  `isTimedOut` closures and a `process.on('exit')` cleanup. The docs now match
  the code, and document all new options.

## Why

The PR monitor detected far more than it delivered, and what it delivered could
not act: advisories surfaced only on the next user-triggered turn, so an idle
session never responded to CI failures or review comments. This release makes
the subscribe step a first-class, end-to-end member of the PR pipeline — events
are pushed down into the session and the swarm acts on them autonomously,
matching the behavior of hosted PR-watching agents while remaining a local,
cross-platform, polling-based plugin with no public webhook endpoint.

## How to use

Enable the monitor (`pr_monitor.enabled: true`). After `gh pr create`, the
session auto-subscribes (disable with `auto_subscribe_on_pr_create: false`).
Events wake the session by default; set `event_delivery: 'advisory'` for the
legacy passive behavior. Tune per-event gates (`notify_*`) as needed;
`notify_ci_success` is off by default to keep sessions quiet on green.

## Invariant audit

- INV-1 (plugin init): delivery registration reuses the existing
  enabled-gated dynamic-import pattern; repro-704 T1 51.7 ms (< 400 ms)
- INV-7 (tests): new sub-500-line bun:test files with `_internals` DI seams;
  no `mock.module` on node builtins without spread-real-exports
- INV-8 (session state): delivery queues keyed by sessionID, bounded
  (64-session FIFO eviction, 20-event queue cap) with eviction tests
- INV-10 (chat hooks): advisory drain path untouched; wake is an SDK user
  prompt, no system-message shape changes
- INV-11 (tool registration): command policy change covered by
  registry.tool-policy, registration-parity, shortcut, and index-commands tests
- INV-12 (release): this fragment; `package.json#files` gained the bundled
  skill directory, validated by package-smoke and bundled-skills-coherence
