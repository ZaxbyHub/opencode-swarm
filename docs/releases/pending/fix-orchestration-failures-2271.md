# Fix: multiple orchestration failures — settlement baselines, worktree lanes, SAST gate, model preflight, scope idle expiry, session reports

Issue: #2271

## What changed

### Bug 1 — worktree lanes could host coder sessions without being real git worktrees
- `provisionWorktree` now verifies the lane after `git worktree add` (`.git` link present + `git rev-parse --git-dir` succeeds inside the lane, 5 s bounded) and returns `WORKTREE_VERIFICATION_FAILED` (after best-effort lane removal) when the lane is not a registered worktree. Previously a lane left plain by a prune/partial-removal race hosted a coder whose writes git could never attribute → settlement recorded `dispatch_no_mutation` → retry circuit breaker.
- `beginCoderSettlement` fails a dispatch fast with `CODER_SETTLEMENT_BASELINE_UNAVAILABLE` when the observation directory has no git HEAD while the project root does (the unregistered-lane signature), instead of dispatching into guaranteed attribution failure. Non-git projects keep the existing (#2214) settle-time abort; transient capture failures stay retryable.
- When `worktree.policy: "auto"` degrades a coder to run un-isolated in the project root, a `worktree_isolation_degraded` record is appended to `.swarm/events.jsonl` so a later `dispatch_no_mutation` is explainable from the ledger; failed lane cleanup after a session-create failure is now logged instead of silently swallowed.

### Bug 2 — `.swarm/` runtime writes no longer poison settlement
- Workspace snapshots (`captureWorkspaceSnapshot`) filter plugin runtime-state data files under `.swarm/` (telemetry, session state, knowledge events, evidence, …) from the porcelain payload BEFORE hashing and parsing, so `changedFiles`, `dirtyHash`, and Stage-B freshness are all consistently `.swarm`-immune. `changedFilesSinceSnapshot` also strips `.swarm` data paths from legacy baselines and from committed-path attribution.
- The `CODER_SETTLEMENT_CLEAN_BASELINE_REQUIRED` message now notes that `.swarm/` runtime state is auto-excluded. A repo with a tracked or un-excluded `.swarm/` can now dispatch coders.
- Anti-evasion preserved: source-code files under `.swarm/` (e.g. `.swarm/payload.ts`) are NOT runtime state and stay visible to attribution.

### Bug 3 — `sast_scan` passes non-code-only diffs
- A scan whose every input file has no SAST language profile (markdown-only, JSON-only, unknown non-code extensions) now returns `verdict: "pass"` with `summary.files_skipped_non_code` instead of hard-failing with "zero files were scanned". This un-wedges markdown-only tasks that were stuck in `rework_required` with `TASK_WORKFLOW_STAGE_A_REQUIRED`.
- Zero-input scans, scannable-but-unscannable inputs (oversized/binary), and `capture_baseline` zero-coverage keep the hard fail.

### Bug 4 — agent model-resolution preflight
- New `src/services/model-preflight.ts` validates configured agent models (defaults + `agents.<role>.model` overrides + `fallback_models`) against the live provider catalog (`client.provider.list()`, ≤2 s, fail-open on any catalog error).
- Wired into: `/swarm config doctor` (per-unresolved-model findings), plugin init (post-resolution advisory listing unresolved models — never blocks init), and BOTH critic gates — the architect's plan-critic dispatch (delegation gate: `PLAN_CRITIC_MODEL_UNRESOLVED` fail-fast denial instead of a wedged gate) and the full-auto oversight critic (actionable PENDING + escalation instead of silent permanent dispatch failure).
- New `model_unresolved` telemetry event (catalog + observability docs updated).

### Bug 5 — idle scope bindings auto-recover
- A v2 scope binding that merely expired while the owning session was idle is now revived at the authorization gate when it is the single unambiguous live-state generation, within 24 h of expiry, and not covered by a deliberate deny overlay — via the same serialized CAS as lease refresh (revision bump + new expiry). Purely time-based in-memory sweep tombstones no longer block revival and are cleared with it; `SCOPE_BINDING_EXPIRED` fail-closed behavior is unchanged for deliberate revocations, tombstones, ambiguity, and beyond-window idles. Every revival appends a `scope_binding_auto_recovered` audit event to `.swarm/events.jsonl`.

### Bug 6 — session reports count ledger rejections
- Session reflection now derives rejection counts from `.swarm/events.jsonl` (`coder_retry_circuit_breaker`, `plan_critic_gate_manual_approval`, `architect_loop_detected`, `agent_conflict_detected`), reading the live ledger (finalize runs before archive) with a newest-archive fallback. When the closing session's id is known, events explicitly attributed to a DIFFERENT session are excluded; sessionless rejection events (several writers emit no session field) still count so the undercount cannot return. The close-summary no longer claims "No tool failures or gate rejections recorded this session" while the ledger shows rejections — gate denials never fired `toolAfter`, so tool counters structurally could not see them. (`sounding_board_consulted` is deliberately not counted — advisory consultation, not a rejection; `prm_hard_stop*` is telemetry.jsonl-only and has no events.jsonl writer.)

## Consumer impact
- Settlement/Stage-B snapshots ignore `.swarm/` data-file churn (behavior change by design). The shared `parsePorcelainV2Snapshot` remains UNFILTERED so the PR-workflow `SWARM_STATE_TRACKING_ERROR` fail-closed guard keeps seeing tracked `.swarm` dirt; filtering is applied only to the settlement-side snapshot payload. PR-gate clean-tree checks (`resolveIsWorkingTreeClean`, porcelain-v1) are intentionally untouched.
- Model preflight caches the provider catalog for 30 s; the critic dispatch gates pay at most one bounded catalog call per cache window.
- Two pre-existing sast zero-coverage tests were updated to the new non-code-pass contract (the issue explicitly supersedes it); genuinely-failing zero-coverage cases retain coverage.
- Existing #2214 settlement contracts (non-git project settle-abort; transient capture retry) are regression-tested as unchanged.

## Validation
- 8 new test files (43 new tests) across background/workflow/worktree/hooks/tools/services/scope; per-file isolation loops green for every touched suite (background, workflow, worktree, scope, delegation-gate hooks, sast/pre-check tools, services, commands, full-auto, observability, config).
- `tsc --noEmit` clean; `bun run build` green; bundle-portability + plugin-shape tests green; `node --input-type=module -e "await import('./dist/index.js')"` OK; `check-invariants.sh` all pass; `drift:check` clean; biome clean.
- Mutation (falsification) checks confirmed each key regression test fails when its fix is disabled.
