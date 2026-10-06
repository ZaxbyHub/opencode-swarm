# Epic Mode catch-up: config opt-in enforced, v2 declared scopes, phase readiness gate

## What changed

- **Config opt-in is now enforced (behavior change).** `epic.mode.enabled` (default `false`) was documented as Epic Mode's master gate but was never read. It is now checked by every Epic entry point (`/swarm epic start` and the Epic tools, which return reason `epic-disabled-by-config` with remediation — see `epic-mode-v2.md` for the final command and tool set), and by the project-scoped Epic probe that drives every Epic behaviour (see `epic-mode-v2.md`) and the Epic branches of `phase_complete`. `epic.cochange.enabled` now actually gates the git co-change signal: when off, Epic separates tasks on declared-path conflicts only, and `/swarm coupling` (no longer independent of that key) records `cochangeSignal: 'disabled-by-config'`. The single source of truth is `src/epic/config-gate.ts`.
- **Epic reads declared scopes only from v2 bindings.** Epic's planning and `/swarm coupling` read declared scope only from live `declare_scope` bindings pinned to the exact plan identity (bindings live 1 h; a plan revision voids them); stale legacy `.swarm/scopes/scope-<taskId>.json` files are ignored. Epic resolves these scopes itself and passes them explicitly to the shared partition planner.
- **New `epic_phase_review` tool and `epic_phase_readiness` gate.** While Epic Mode is active for the project, `phase_complete` requires an APPROVED read-only phase reviewer and, after it, an APPROVED phase critic — both dispatched by `epic_phase_review` itself and recorded to `.swarm/evidence/{phase}/epic-phase-review.json`, bound to the plan and to every phase task's evidence (24 h TTL). Block codes: `EPIC_PHASE_REVIEW_MISSING`, `EPIC_PHASE_REVIEW_INVALID`, `EPIC_PHASE_REVIEWER_NOT_APPROVED`, `EPIC_PHASE_CRITIC_MISSING`, `EPIC_PHASE_CRITIC_NOT_APPROVED`, `EPIC_PHASE_REVIEW_STALE`, `EPIC_PHASE_PLAN_UNREADABLE`. Under Epic it replaces Lean Turbo's `lean_turbo_readiness` gate. The gate appears in the `phase_complete` gate report only while Epic is active; without Epic the report is unchanged.
- **Divergence attribution is complete.** Foreground coder writes are attributed to the coder's own session; Epic now unions a task's writes across every same-project session, never records a "clean" task from absent attribution, and treats a declared directory as covering the files beneath it.
- **Per-task QA is always required under Epic:** Stage A (`pre_check_batch`) and Stage B (reviewer + test_engineer) before `update_task_status(completed)`, matching runtime enforcement.
- **Dead code removed:** the legacy `epic_run_phase` execution path (`executeEpicRunPhase`) and unused Epic state helpers.
- The MCP read-only surface's write-tool denylist covers every `epic_*` tool.

## Why

A catch-up audit found Epic Mode's documented contract and its runtime had drifted: the config gates were inert, planners could trust stale v1 scope files, the per-task completion commit ("Rule 2", since replaced by commit-at-landing — see `epic-mode-v2.md`) could commit unrelated staged files or mark uncommitted work as committed, abandoned sessions could keep Epic on for the whole project indefinitely, and nothing reviewed concurrently executed waves as a whole before a phase closed.

## Migration steps

- To keep using Epic Mode, set `epic.mode.enabled: true` in the top-level `epic` block, e.g. `{ "epic": { "mode": { "enabled": true } } }` — no `turbo` block is needed. The older `turbo.epic` path keeps working (migrated, with a deprecation warning — see `epic-mode-v2.md`).
- To keep the co-change signal, also set `epic.cochange.enabled: true`.
- Under Epic Mode, call `epic_phase_review(phase)` before `phase_complete`.

## Breaking changes

- Projects that used Epic Mode without `epic.mode.enabled: true` are refused until they opt in.
- `/swarm coupling` and Epic wave composition no longer use the co-change signal unless `epic.cochange.enabled: true`.
- `phase_complete` blocks under Epic Mode until `epic_phase_review` records approving verdicts.

## Known caveats

- Declared scopes expire after 1 h. Long-running phases must re-run `declare_scope` before `epic_next_wave` can issue a wave for tasks whose bindings have lapsed.
