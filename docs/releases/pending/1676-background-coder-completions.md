# Reliable background coder completion ingestion

## What changed

- Opted-in background coder Tasks now settle trusted terminal completions into
  exact parent workflow state, task-keyed modified-file attribution, coder
  evidence, and a durable mid-turn architect advisory.
- Standard isolated-worktree coders capture their changes and verify merge-back
  before any completion state is published. Partial or failed merges preserve
  recovery provenance and remain unconsumed; init orphan recovery now protects
  worktrees owned by either the primary ledger or its independent fallback.
- Running placeholders restore architect continuation without emitting false
  completed telemetry or pipeline advisories.
- Background completion retries are idempotent across ledger ingestion,
  worktree settlement, advisory delivery, and reverse-order concurrent coders.
- Ingestion claims and advisory preparations use bounded, restart-reclaimable
  leases. Advisory delivery is marked complete only when a later host transform
  reflects the exact injected text back in conversation history, eliminating
  the crash window between mutation and transform return.
- If the primary append-only ledger cannot accept a just-launched dispatch, an
  atomically written per-correlation fallback retains its exact ownership,
  baseline, and worktree coordinates until promotion succeeds.
- If both correlation stores fail after an isolated coder has launched, swarm
  creates a non-mutating Git ownership tag and records durable recovery
  protection so startup orphan cleanup cannot reclaim the live worktree. Tag
  scan errors, malformed refs/records, timeouts, and overflow across every
  ownership store now stop destructive cleanup and surface a recovery advisory
  instead of being treated as no owner.
- Standard worktree provisioning now publishes a provisional durable owner
  while holding the same lifecycle lock as init recovery, so cleanup cannot
  snapshot an empty owner set and then race a newly created lane.
- A conflicted merge-back under the default `merge` strategy now records its
  preserved settlement durably. Git reports merge conflicts on stdout and
  leaves stderr empty, so the settlement reason was blank, failed record
  validation, and was silently discarded — leaving the lane stuck mid-settle
  across restarts. The reason is now captured from either stream and bounded,
  and the architect advisory built from it is bounded too.

## Why

The original coder path recorded dispatch provenance and returned early. It
could consume stale completions, omit workflow/file updates, remain silent when
the real terminal result landed, and bypass isolated-worktree merge-back.

## Migration

No migration is required. `hooks.background_subagents` remains `false` by
default because OpenCode still classifies the capability as experimental.
Opt-in users must also enable either
`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` or
`OPENCODE_EXPERIMENTAL=true` upstream.

## Breaking changes

None.

## Known caveats

The default will not change until OpenCode removes the experimental gate and
the cross-platform readiness checklist in the recovery guide is satisfied.
