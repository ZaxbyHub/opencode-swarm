# 5 playbook skills from session #1685 post-mortem

## What changed
Added 5 focused playbook skills derived from a ~2,400-tool-call session post-mortem + independent reviewer review:
- `worktree-retry-cleanup` — protocol for cleaning parallel-coder worktree lanes before retry
- `skill-edit-validation` — content-assertion sweep after editing SKILL.md files
- `merge-queue-readiness` — pre-queue merge-group CI simulation
- `gate-attribution` — per-task gate dispatch protocol + parallel-lane optimization
- `ci-failure-batching` — batch collection and fix protocol for CI failures (reviewer proposal)

Each playbook is a focused protocol referenced via short `file:` trigger points, avoiding inline skill bloat (per reviewer architectural guidance). Four of the five (`worktree-retry-cleanup`, `merge-queue-readiness`, `gate-attribution`, `ci-failure-batching`) are referenced from mode skills (`execute`, `commit-pr`, `swarm-ci-monitor`, `swarm-pr-feedback`); `skill-edit-validation` is referenced from `commit-pr`'s pre-commit hygiene step and from the dev-repo `editing-skills` contract doc, since it is not itself a mode skill. See issue #1806 for the reachability wiring that landed these references.

## Why
These playbooks address the highest-impact friction points observed across the session: worktree provisioning failures (~15 interventions), stale test assertions (~5 CI failure cycles), merge-queue kick-outs (~3), gate ceremony overhead (~10 extra dispatches), and serial CI fix cycles (~8 pushes reduced to ~3).

## How to use
The playbooks are reachable via an explicit `file:.swarm/bundled-skills/<slug>/SKILL.md` reference embedded in the owning skill's body — not via automatic keyword-scoring of `.swarm/bundled-skills` (that root is intentionally excluded from the scoring scan; see issue #1806). No separate hook injection and no user action needed: the playbook loads as part of the owning skill's own protocol whenever that skill is loaded.

## Migration
No migration required. The playbooks are additive — they don't change existing skill behavior, only add new focused protocols.

## Related
- Code-level root causes tracked in issue #1746
- Session post-mortem analysis in .swarm/archive/
