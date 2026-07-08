# 5 playbook skills from session #1685 post-mortem

## What changed
Added 5 focused playbook skills derived from a ~2,400-tool-call session post-mortem + independent reviewer review:
- `worktree-retry-cleanup` — protocol for cleaning parallel-coder worktree lanes before retry
- `skill-edit-validation` — content-assertion sweep after editing SKILL.md files
- `merge-queue-readiness` — pre-queue merge-group CI simulation
- `gate-attribution` — per-task gate dispatch protocol + parallel-lane optimization
- `ci-failure-batching` — batch collection and fix protocol for CI failures (reviewer proposal)

Each playbook is a focused protocol referenced by mode skills via short trigger points, avoiding inline skill bloat (per reviewer architectural guidance).

## Why
These playbooks address the highest-impact friction points observed across the session: worktree provisioning failures (~15 interventions), stale test assertions (~5 CI failure cycles), merge-queue kick-outs (~3), gate ceremony overhead (~10 extra dispatches), and serial CI fix cycles (~8 pushes reduced to ~3).

## How to use
The playbooks auto-trigger from the architect's skill system when the relevant condition is met (re-dispatching a coder with an existing lane, editing a SKILL.md, preparing for merge queue, etc.). No user action needed.

## Migration
No migration required. The playbooks are additive — they don't change existing skill behavior, only add new focused protocols.

## Related
- Code-level root causes tracked in issue #1746
- Session post-mortem analysis in .swarm/archive/
