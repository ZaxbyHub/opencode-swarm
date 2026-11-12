---
issues: [3655, 3659]
---

# Coder committed output no longer wedges reviewer dispatch; swarm_memory tools honor the enabled flag

## What

Two shared-root workflow fixes:

- A coder delegation whose declared file was written and committed now reaches
  the reviewer gate. At coder completion the reviewer-scope generation
  reconciles committed git changes since the dispatch-time HEAD into the
  generation (routing each in-scope committed file with its fingerprint), so
  output that guardrail write-routing never observed — shell/git writes, a
  binding miss — no longer strands the generation and throws terminal
  `REVIEWER_SCOPE_STALE (retryable=false)`.
- Attribution problems now surface typed, actionable denials instead of one
  terminal code. A generation with zero routed writes and no provable committed
  change denies reviewer dispatch with `REVIEWER_ATTRIBUTION_EMPTY`
  (retryable=true). Routed files with incomplete fingerprints deny with
  `REVIEWER_CAPTURE_INCOMPLETE` (retryable, re-dispatch the coder) or, for
  permanent capture failures, `REVIEWER_CAPTURE_FAILED` with a repair-then-
  re-dispatch-the-coder action. Genuine post-capture drift on a ready
  generation remains terminal `REVIEWER_SCOPE_STALE` and now states
  `retryable=false` in its own text.
- The no-change verdict is runtime-aware and scope-truthful: plugin-owned
  `.swarm/` dirt no longer flips a truthful no-change completion into a
  guardrail-bypass suspicion, and `REVIEWER_SCOPE_NO_CHANGE` now says "no
  committed or working-tree change exists within the declared reviewer scope"
  instead of claiming a globally empty workspace diff. A clean working tree
  whose committed diff cannot be proven is treated as degraded (typed denial),
  never as proof of no mutation.
- `swarm_memory_recall` / `swarm_memory_propose` / `swarm_memory_outcome` are
  no longer registered in the main session when `memory.enabled` is false (the
  schema default). Registration now matches the subagent opt-in gating
  (AGENTS.md invariant 11), so a memory-disabled session keeps three dead tool
  schemas out of context. The execute-time disabled checks remain as a
  backstop, and the disabled message now addresses the operator ("this is an
  operator configuration setting"), not the model.

## Why

Issue #3655: every coder delegation on a workspace with any untracked path at
completion wedged Stage B — `REVIEWER_SCOPE_STALE retryable=false` with no
architect action able to clear it, blocking `update_task_status(completed)` and
stalling `depends`-chained tasks. Issue #3659: with `memory.enabled=false` the
main session kept three dead tool schemas in every prompt; small models looped
on the disabled tool (32 consecutive `swarm_memory_recall` calls observed).
