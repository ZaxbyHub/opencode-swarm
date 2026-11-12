---
issue: 3655
title: Coder committed output reaches reviewer dispatch (#3655); swarm_memory tools honor the enabled flag (#3659)
---

# Coder committed output no longer wedges reviewer dispatch; swarm_memory tools honor the enabled flag

## What

Two shared-root workflow fixes:

- A coder delegation whose declared output was committed, left uncommitted, or
  otherwise missed guardrail write-routing now reaches the reviewer gate (in
  git workspaces; a workspace with no git at all still cannot dispatch the
  reviewer — the pre-existing `head_timeout` denial — but guardrail-routed
  completions now proceed when the git channel is merely degraded, e.g. the
  coder dispatched into a repo before its first commit). At
  every coder completion whose declared scope still has unrouted files, the
  reviewer-scope generation reconciles declared-scope changes from two sources
  — the committed diff since the dispatch-time HEAD and the declared-scope
  working tree — routing each with its fingerprint. Reconciliation is
  path-base correct for workspaces whose project root is a subdirectory of
  the git repository (paths are normalized to the project root, so monorepo
  layouts attribute correctly). Output that guardrail routing never observed
  no longer strands the generation and throws terminal
  `REVIEWER_SCOPE_STALE (retryable=false)`.
- Attribution problems now surface typed, actionable denials instead of one
  terminal code. A generation with no routed writes and no provable committed
  change denies reviewer dispatch with `REVIEWER_ATTRIBUTION_EMPTY`
  (retryable=true). Routed files with incomplete fingerprints deny with
  `REVIEWER_CAPTURE_INCOMPLETE` (retryable, re-dispatch the coder) or, for
  permanent capture failures, `REVIEWER_CAPTURE_FAILED` with a repair-then-
  re-dispatch-the-coder action (the collecting-state denial sanitizes the
  failure file before interpolation). Declared-scope change sets exceeding the 256-file generation cap are
  refused up front with a `REVIEWER_SCOPE_GENERATION_OVERFLOW` advisory
  instead of silently destroying the generation. Genuine post-capture drift on
  a ready generation remains terminal `REVIEWER_SCOPE_STALE` and now states
  `retryable=false` in its own text.
- The no-change verdict is runtime-aware, scope-truthful, and per-file:
  plugin-owned `.swarm/` dirt no longer flips a truthful no-change completion
  into a guardrail-bypass suspicion (including wholly untracked `.swarm/`
  directories, now enumerated per file), `REVIEWER_SCOPE_NO_CHANGE` says "no
  committed or working-tree change exists within the declared reviewer scope"
  instead of claiming a globally empty workspace diff, and the verdict is
  path-base correct in subdirectory project roots. A clean working tree whose
  committed diff cannot be proven is treated as degraded (typed denial),
  never as proof of no mutation. Routing-time fingerprint captures carry the
  same batch deadline and bounded retry as every other hook-path capture.
- `swarm_memory_recall` / `swarm_memory_propose` / `swarm_memory_outcome` are
  no longer registered in the main session when `memory.enabled` is false (the
  schema default). Registration now matches the subagent opt-in gating
  (AGENTS.md invariant 11), so a memory-disabled session keeps three dead tool
  schemas out of context. The execute-time disabled checks remain as a
  backstop, and the disabled message now addresses the operator and names the
  real configuration key (`memory.enabled` in opencode-swarm.json), not the
  model.

## Why

Issue #3655: every coder delegation on a workspace with any untracked path at
completion wedged Stage B — `REVIEWER_SCOPE_STALE retryable=false` with no
architect action able to clear it, blocking `update_task_status(completed)` and
stalling `depends`-chained tasks. Issue #3659: with `memory.enabled=false` the
main session kept three dead tool schemas in every prompt; small models looped
on the disabled tool (32 consecutive `swarm_memory_recall` calls observed).
