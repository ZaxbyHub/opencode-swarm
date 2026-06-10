# Fail-closed guard for OpenCode background subagents (issue #1151, PR 1)

## What

Swarm now **fail-closed-blocks** background subagent delegations. OpenCode v1.16.2 added
background subagents — the `Task` tool accepts `background=true` (gated upstream by
`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`), which returns a "running" placeholder
immediately and delivers the real result later via a synthetic parent message.

- `src/hooks/delegation-gate.ts` `toolBefore`: throws `SWARM_BACKGROUND_TASK_BLOCKED`
  before dispatch when a `Task` call targets a swarm role (resolved via the existing
  `isKnownCanonicalRole(stripKnownSwarmPrefix(...))` normalization) **and** `background`
  is `true` (the boolean `true` or the stringified `'true'`). The throw propagates through
  the fail-closed `tool.execute.before` chain, so OpenCode rejects the call before
  launching the background task.
- `toolAfter`: belt-and-suspenders early-return — if a background swarm `Task` still
  reaches it (a running placeholder, detected from args or the result shape
  `state:"running"` / `metadata.background===true`), it does **not** advance Stage B or
  record gate evidence, and cleans up any stored args.
- Docs: new "Background Subagent Task Rejected" section in
  `docs/troubleshooting/recovery-guide.md`.

## Why

The delegation gate equates a `Task` result with delegation completion. For
`background=true`, the immediate running placeholder would be interpreted as a finished
reviewer/test_engineer delegation, prematurely advancing the task state machine and
recording gate evidence before any output exists. Blocking the capability — explicitly,
not silently — keeps swarm gate state and evidence correct until durable background
completion ingestion lands.

## Migration

No action for existing users. Foreground swarm delegations are unchanged. Non-swarm
OpenCode `Task` usage (e.g. the native `general` agent) is not affected. To use a swarm
delegation, omit `background` (or set `background=false`).

## Scope / follow-up

This is PR 1 of the two-PR path in issue #1151. PR 2 (durable background completion
ingestion — separate dispatch/completion events, exact-once correlation, timeout/recovery,
concurrency, spoofing resistance) is intentionally deferred and gated on an upstream
metadata/trust spike confirming a trusted completion signal (the synthetic-prompt
`synthetic:true` marker plus `jobId`/session correlation). It is not part of this change.
