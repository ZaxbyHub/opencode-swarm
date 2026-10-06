# Epic Mode — maintainer guide

This guide is for maintainers of `src/epic/`, both automated (bots) and human. Read it before changing Epic code, an Epic seam in a shared file, or the `epic` config block. The user-facing contract lives in [`docs/modes.md` → Epic Mode](../../docs/modes.md#epic-mode-preview), and the keys are documented in [`docs/configuration.md` → `epic`](../../docs/configuration.md). [`AGENTS.md`](../../AGENTS.md) and [`docs/engineering-invariants.md`](../../docs/engineering-invariants.md) still apply in full. Nothing here is an exception to them.

**Rule zero: Epic off means upstream behaviour.** A project whose config does not set `epic.mode.enabled: true` (or the legacy `turbo.epic.mode.enabled: true`) must behave exactly as it would without Epic. When an epic is not open, the shared-file hooks must cost no more than one `existsSync` (see [Seams](#seams-in-shared-files)). `tests/integration/epic-lifecycle-contract-final-off.test.ts` pins this end to end.

---

## Mental model

| Epic term | Means | Where it lives |
|---|---|---|
| **epic** | one **plan**, from `/swarm epic start` to `/swarm epic close` | the lifecycle row (`lifecycle.ts`) |
| **phase** | an **iteration** of the plan; phases run strictly in order | `plan.phases[]`; `EpicPhaseRecord` |
| **task** | a **story**: one coder unit with a declared scope | `plan.phases[].tasks[]` |
| **wave** | a **parallel delivery**: ready tasks whose declared scopes do not conflict, dispatched together | `EpicWaveRecord` (scopes frozen at issue) |
| **close** | the **retrospective**: the report and scorecard, the learning merge, and the branch landing | `close.ts`, `scorecard.ts`, `learning-store.ts` |

Epic is its own mode. It is **not** a Turbo overlay: it enables neither Turbo nor Lean Turbo, and it never waives per-task QA. It reuses Lean Turbo's conflict predicates by import (`src/turbo/lean/conflicts.ts`, `partition-common.ts`, `planner.ts`) and **never modifies** `src/turbo/lean/`.

## Lifecycle

```
/swarm epic start ──► epic_next_wave ──► Task × wave (one message) ──► per-task QA ──┐
  (sizing, refusals,     ▲  (closes the previous wave, issues the next)              │
   epic branch, row,     └───────────────────────────────────────────────────────────┘
   sentinel, base ref)   │ phase done
                         ▼
               phase-ready-for-review ──► epic_phase_review ──► phase_complete ──► next phase …
                                                                                    │ all phases
                                                                                    ▼
                                                    epic-complete ──► /swarm epic close [--land squash|merge|none]
```

| Step | Entry point | Implementation |
|---|---|---|
| Shape (before start) | `save_plan` result `epic_shaping`; `/swarm coupling --suggest` | `plan-shaping-seam.ts` → `shaping.ts` / `shaping-suggestions.ts` / `shaping-sizing.ts` |
| Start | `/swarm epic start [--force]` (`src/commands/epic.ts`) | `start.ts`. Checks in order, first one wins: `epic-disabled-by-config`; `no-plan` / `plan-ledger-unreadable`; `epic-state-unreadable`; an epic already open for the same plan returns `already-open` (idempotent success, not a refusal), and one open for another plan refuses `epic-open-for-other-plan`; `turbo-active`; (git) `dirty-baseline`, `detached-head`, `epic-branch-exists`; `in-flight-coders`; `not-epic-sized` (`--force` overrides, recorded); `branch-create-failed` (`git checkout -b` failed after the row was created, so the row and sentinel are rolled back). |
| Next wave | tool `epic_next_wave` (`src/tools/epic-next-wave.ts`) | `next-wave.ts` → `wave-close.ts` (close the active wave) → `wave-select.ts` → `components.ts` (pick the next one) → `next-wave-format.ts` (result and text) |
| Dispatch | the architect's `Task` calls, admitted by the delegation gate | `gate-policy.ts` (`resolveEpicDispatchPolicy`, `computeEpicWaveVerdict`) |
| Landing | the worktree merge-back of each coder | `task-landing.ts` (merge commit `swarm(task <id>): …` + `Swarm-Plan:` trailer from `plan-key.ts`) |
| Residue | non-coder writers (test_engineer, docs) in the main tree | `residue-commit.ts` |
| Phase review | tool `epic_phase_review` (`src/tools/epic-phase-review.ts`), then `phase_complete` | `phase-readiness.ts` (gate `epic_phase_readiness`) |
| Close | `/swarm epic close`; `/swarm close` finalizes an open epic as `abandoned-by-swarm-close` | `close.ts`, `epic-branch.ts` (landing), `markers.ts` (refs), `learning-store.ts` (prior merge) |
| Inspect | `/swarm epic status [--repair-refs]`, `report`, `learning`, `prior`, `clear-merge-failure` | `src/commands/epic.ts`, `report.ts`, `src/commands/epic-learning.ts`, `merge-epoch.ts` |

`epic_next_wave` statuses: `dispatch | declare-scopes | in-progress | blocked | phase-ready-for-review | epic-complete | refused`. Refusal reasons are `EpicNextWaveRefusal`, and blocked reasons are `EpicNextWaveBlockReason`, both in `next-wave-format.ts`. The architect banner (`EPIC_MODE_BANNER`, `src/config/constants.ts`) says only "call `epic_next_wave` and do what its status says". The procedure travels in the tool's response text.

## Module map

| File | Responsibility | Key exports |
|---|---|---|
| `config.ts` | **The only place that knows where Epic settings live**: top-level `epic`, plus the legacy `turbo.epic` migration. Has no runtime imports. | `resolveEpicConfig`, `isEpicModeConfigEnabled`, `isEpicCochangeConfigEnabled`, `migrateLegacyEpicConfig`, `hasLegacyEpicConfig`, `legacyEpicIssuePath`, `annotateLegacyEpicKeys`, `LEGACY_EPIC_CONFIG_WARNING` |
| `config-gate.ts` | Directory-keyed gate (loads config, fails closed) and the disabled message; re-exports the pure gates | `isEpicModeConfigEnabledForDirectory`, `EPIC_MODE_CONFIG_DISABLED_MESSAGE` |
| `lifecycle.ts` | Authoritative lifecycle row (coordination namespace `turbo.epic.lifecycle`), sentinel projection, the probe, and CAS writes | `isEpicOpenForProject`, `epicSentinelExists`, `getOpenEpic`, `inspectEpic`, `createEpicRecord`, `updateEpicRecord`, `markEpicClosing`, `deleteEpicState`, `repairEpicSentinel`, `EpicRecordV1`, `EpicWaveRecord`, `EpicTaskOutcome` |
| `start.ts` | `/swarm epic start` orchestration and refusals | `startEpic`, `findTurboActivity`, `findDirtyBaseline`, `findInFlightCoderWork`, `computeEpicSizing` |
| `sizing.ts` | Pure sizing verdict (T, C, S, S_eff thresholds) | `evaluateEpicSizing`, `resolveEpicSizingThresholds`, `computeEffectiveSpeedup` |
| `shaping-sizing.ts` | THE plan sizing: a dry run of the component planner, under a work budget | `sizeEpicPlan`, `epicSizingContextFor`, `epicWaveWidth`, `estimateEpicScopes` |
| `shaping.ts` | Pure plan shaping: ranks suggestions and what-ifs | `shapeEpicPlan`, `formatEpicShapingLines` |
| `shaping-suggestions.ts` | Suggestion builders, each one a concrete `save_plan` patch | `EpicShapingSuggestion`, `narrowScopeSuggestion`, `fileSuggestion`, `splitSuggestion`, `mergeSuggestion` |
| `plan-shaping-seam.ts` | The `save_plan` → `epic_shaping` seam, plus the per-plan iteration counter | `computeSavePlanEpicShaping`, `bumpShapingIteration` |
| `next-wave.ts` | `epic_next_wave`: refusals, closing a wave, choosing the next, issuing it | `runEpicNextWave`, `completedBeforeEpic` |
| `next-wave-format.ts` | Pure result shapes and architect-facing text | `EpicNextWaveResult`, `EpicNextWaveBlockReason`, `EpicNextWaveRefusal`, `buildDispatchInstructions` |
| `wave-select.ts` | Chooses the next wave of the current phase (no writes) | `selectNextEpicWave`, `cochangePairsWithin` |
| `components.ts` | Pure wave planner: conflict graph → components → modes → greedy wave; the sizing dry run | `planNextEpicWave`, `buildEpicConflictGraph`, `partitionEpicComponents`, `dryRunEpicPhase` |
| `planning-signals.ts` | Planner inputs read once per planning call (learned hot files and co-writes, co-change, density threshold) | `loadEpicPlanningSignals` |
| `wave-close.ts` | Closes a wave: outcomes, divergence, attribution, learning update | `computeWaveClose`, `applyWaveClose`, `recordEpicWaveLearning` |
| `gate-policy.ts` | The delegation gate's authority while an epic is open; THE wave verdict | `resolveEpicDispatchPolicy`, `computeEpicWaveVerdict` |
| `task-landing.ts` | Coder landing as a commit on the epic branch; isolation-degraded refusal | `epicCommitLandingFor`, `resolveEpicTaskContext`, `epicIsolationDegradedMessage` |
| `residue-commit.ts` | Residue commits for non-coder main-tree writes; dirty-baseline classification | `commitEpicResidueAfterDelegation`, `commitTaskResidue`, `classifyDirtyBaseline` |
| `epic-branch.ts` | `commit_policy`, the `swarm/epic/<epicKey>` branch, the landing preflight, landing at close | `resolveEpicCommitPolicy`, `checkEpicBranch`, `preflightEpicLanding`, `epicBranchName` |
| `markers.ts` | Git refs `refs/swarm/epics/<epicKey>/{base,waves/<seq>,tasks/<id>}` (sync, repair, delete) | `writeEpicRef`, `syncEpicRefs`, `deleteEpicRefs`, `planEpicTaskRefRepair` |
| `plan-key.ts` | Plan identity for commit markers (`Swarm-Plan:` trailer) | `computePlanKey`, `formatEpicTaskCommitMessage`, `resolvePlanMarkerScope`, `parseTaskMarkerLog` |
| `git-once.ts` | Single-attempt git for state-changing commands | `gitExecOnce`, `gitProbeExitCode` |
| `merge-epoch.ts` | Plan-epoch filter over the shared worktree merge-status registry | `relevantMergeFailure`, `epicMergeFailureSkipsCheckpoint`, `clearMergeFailureCommand` |
| `phase-readiness.ts` | Phase reviewer and phase critic dispatch, evidence, and the `phase_complete` gate | `verifyEpicPhaseReadiness`, `computeEpicPhaseBinding`, `EPIC_PHASE_REVIEW_TOOL` |
| `close.ts` | `/swarm epic close` and `/swarm close` finalization; close reports | `closeEpic`, `finalizeOpenEpicOnSwarmClose`, `pruneEpicPriorReports` |
| `scorecard.ts` | Pure scorecard over the epic record | `computeEpicScorecard`, `formatEpicScorecardLines` |
| `report.ts` | `/swarm epic report`: the live or past scorecard | `selectEpicReport`, `liveEpicScorecard`, `listEpicPriorReports` |
| `learning.ts` | Pure learning model (scope expansion, decaying hot set) | `resolveEpicLearningSettings`, `EPIC_LEARNING_INCIDENT_WEIGHTS`, `DEFAULT_EPIC_LEARNING_SETTINGS` |
| `learning-store.ts` | Persistence of the project prior and the epic posterior; the v1 import | `loadEpicLearningView`, `initEpicPosterior`, `applyClosedWavesToPosterior`, `readEpicPrior` |
| `legacy-migration.ts` | One-time retirement of Epic v1 session state | `retireLegacyEpicSessionState` |
| `declared-scopes.ts` | Declared scopes from live v2 `declare_scope` bindings only | `resolveEpicDeclaredScopes` |
| `cochange-conflict.ts` | Path + co-change pair predicate (conservative: it can only add a conflict) | `epicPairConflict` |
| `cochange-source.ts` | Co-change pairs from git history, cached per HEAD (FIFO, 10 directories) | `getCoChangePairs`, `getCoChangeData`, `peekCoChangeData` |
| `coupling-report.ts` | `/swarm coupling` metric `p` and the per-module contention | `computeCouplingReport`, `formatCouplingReportMarkdown` |

Epic files outside `src/epic/`: `src/commands/epic.ts` and `src/commands/epic-learning.ts` (the slash command), `src/commands/coupling.ts`, `src/tools/epic-next-wave.ts`, and `src/tools/epic-phase-review.ts`. Tool wiring is in `src/tools/tool-metadata.ts` (`agents: []`), `src/tools/manifest.ts`, `src/tools/index.ts`, `src/tools/plugin-registration.ts` (`epic_phase_review` needs the review dispatcher), and the opt-in `EPIC_AGENT_TOOL_MAP` (`src/config/constants.ts`, architect only). The planner regression harness lives in `scripts/lib/epic-sim.ts` and `scripts/epic-bench.ts` (never bundled).

## Invariants that must hold

1. **Epic off ⇒ upstream behaviour.** Every seam in a shared file either reads config that is already loaded (no I/O) or probes sentinel-first (`epicSentinelExists` / `isEpicOpenForProject`), so a project with no open epic costs at most **one `existsSync`** and adds no `await`. Non-Epic outputs stay byte-identical. Proof: `final-off` contract, `tests/unit/epic/disabled-passthrough.test.ts`, and the per-seam tests below.
2. **Every multi-task wave that is issued is `all_disjoint` under `computeEpicWaveVerdict`**, the exact call the delegation gate repeats at dispatch over the frozen scopes. `next-wave.ts:assertWaveDisjoint` narrows a non-disjoint selection to one task and raises a critical warning, because that would be a planner bug. Proof: `tests/unit/epic/next-wave-verdict.test.ts`.
3. **Planner predicate ⊇ gate verdict relation.** The component planner's conflict edges (path ∪ co-change on declared scopes, plus learned scope expansion, which only ADDS path edges) are a superset of the verdict's, so the planner never picks a wave the gate would serialize. Co-change keeps using declared scopes: its "exclusively owns one side" rule is not monotone. Proof: `tests/unit/epic/components-property.test.ts` (seeded property test), and the C5/C6 contract tests.
4. **State changes are token-guarded CAS.** Lifecycle writes run inside the coordination store's `BEGIN IMMEDIATE` transaction. A create is CAS from `expectedRevision: null`, an update is CAS on the revision with an optional `expectedToken`, and the sentinel is removed compare-and-delete on epicKey + token. A late close can never delete a newer epic. Proof: `tests/unit/epic/lifecycle-writes.test.ts`, `lifecycle-probe.test.ts`.
5. **Git writes are single-attempt.** Epic's own state-changing git commands go through `git-once.ts` (no transient retry), and the real repository state is re-read after a failure. Coder landings use the shared worktree merge path with Epic's commit message (`src/worktree/merge.ts`, `landingCommitMessage`).
6. **Refs are create-only, then CAS.** `writeEpicRef` creates a missing ref with `update-ref <ref> <sha> ""`, leaves an equal one unchanged, and otherwise updates by compare-and-swap from the recorded old value. It never force-writes. Deletes are guarded by the expected old value. Refs are never pushed.
7. **Learning starts neutral and stays bounded.** An empty or clean history has no hot files and no expansion. A file is hot only when it has excess incidents (`α' ≥ 1` and `r − m0 > hot_excess`). State is capped at `MAX_EPIC_LEARNING_FILES` and `MAX_EPIC_LEARNING_EDGES`, decays `× decay_per_epic` per learning epic and by whole half-lives, and drops entries below 0.05. Learning is planner analysis only, **never write authorization**. Proof: `tests/unit/epic/learning*.test.ts`.
8. **The `save_plan` seam runs after the plan lock, fails open, and is bounded.** It runs only when the already-loaded config has Epic on, and it does nothing while an epic is open. It uses a warm co-change cache only (no git scan) and a work budget (`skipped-budget` beyond it). A throw leaves the save successful, without `epic_shaping`. Proof: `tests/unit/epic/plan-shaping-seam.test.ts`, `tests/unit/tools/save-plan-epic-shaping*.test.ts`.
9. **The plan ledger stays authoritative** (AGENTS.md §5). Epic never writes `plan.json`. Fix tasks are added through `save_plan`, and phases close through `phase_complete`.
10. **One open epic per project, bound to one plan identity.** A renamed or replaced plan orphans the epic: the probe answers "no open epic", and `/swarm epic close --abandon` repairs it.

## Seams in shared files

Each seam is Epic-gated, and none of them changes non-Epic output. "One `existsSync`" means the sentinel `.swarm/epic/epic.json` check.

| File : function | What it does for Epic | Why it is a no-op with Epic off | Proving test(s) |
|---|---|---|---|
| `src/config/loader.ts:buildConfigWithMeta` (step 0, before the user + project merge; recovery labels) | Moves each file's legacy `turbo.epic` to that file's top-level `epic` (per-key merge, the file's top-level wins), warns once, labels recovered keys `(from turbo.epic)` | `hasLegacyEpicConfig` is a pure own-key check; without it each raw file is used unchanged (same reference) and `annotateLegacyEpicKeys` returns its input | `tests/unit/config/epic-config-path.test.ts` |
| `src/services/config-doctor.ts:collectRawRetiredEpicKeyFindings` / `collectRawLegacyEpicConfigFindings` | `retired-config-key` and `legacy-epic-config-path` findings (report-only) | Returns before any file read when `resolveEpicConfig(config)` is undefined | `epic-retired-config-keys.test.ts`, `epic-config-path.test.ts` |
| `src/services/config-doctor.ts:collectRawStrictSectionFindings` / `collectRawValueConstraintFindings` | Validate each raw file as the loader does (`migrateLegacyEpicConfig` first) and report issues at the written path (`legacyEpicIssuePath`) | Both helpers return their input unchanged for a file without `turbo.epic` | `epic-config-path-doctor.test.ts` |
| `src/agents/index.ts:createSwarmAgents`, `getAgentConfigs` | Architect gets the Epic tools and prompt lines (`EPIC_AGENT_TOOL_MAP`) | `isEpicModeConfigEnabled(config)` is false: a pure property read | `tests/unit/agents/epic-tool-gating.test.ts` |
| `src/full-auto/policy.ts:resolveAgentCapabilityTools` | Same grant for the Full-Auto capability derivation | Same pure gate | `epic-tool-gating.test.ts` |
| `src/tools/save-plan.ts:executeSavePlan` | `epic_shaping` in the result | Gate on the loaded config, so there is no read, I/O or await | `save-plan-epic-shaping*.test.ts`, `final-off` |
| `src/hooks/delegation-gate.ts:createDelegationGateHook` (coder before-hook) | Active wave = dispatch authority; required isolation; `EPIC_ISOLATION_DEGRADED`; a PR-feedback coder overlapping an issued wave's frozen scope is refused (`EPIC_PR_FEEDBACK_SCOPE_OVERLAP`) | `epicSentinelExists` false ⇒ `epicPolicy = null`, no PR-feedback overlap check, and every expression keeps its original value | `delegation-gate-epic-wave.test.ts`, `delegation-gate-epic-isolation.test.ts`, `delegation-gate-epic-pr-feedback.test.ts`, `delegation-gate-epic-pr-feedback-wave.test.ts` |
| `src/hooks/delegation-gate.ts:createDelegationGateHook` (Task after-hook) | Residue commit for non-coder writers | Synchronous `epicSentinelExists` gate, with no extra await | `tests/unit/epic/residue-commit.test.ts`, `epic-phase-handoff.test.ts` |
| `src/hooks/delegation-gate.ts:buildParallelExecutionGuidance` | Suppresses the SERIAL/Lean advisory while an epic is open | Sentinel-first probe | `delegation-gate-epic-guidance.test.ts` |
| `src/hooks/delegation-gate/worktree-isolation.ts:finishStandardWorktreeDispatch` | Lane lands as a `swarm(task …)` merge commit, or is refused `EPIC_LANDING_INDEX_DIRTY` | `epicCommitLandingFor` returns `undefined` after one `existsSync` | `tests/unit/epic/task-landing.test.ts`, contract C3 |
| `src/background/completion-observer.ts:createBackgroundCompletionObserver` | Residue commit for background non-coder writers | Synchronous `epicSentinelExists` gate | `completion-observer-epic-residue.test.ts` |
| `src/plan/manager.ts:updateTaskStatus` | Skips the #2582 auto-checkpoint for an epic task whose merge-back failed | `epicMergeFailureSkipsCheckpoint` is sentinel-first | `manager-auto-checkpoint-2582.test.ts`, `epic-worktree-merge-guard.test.ts` |
| `src/state.ts:completeModifiedFilesForTask` | Keeps per-task write attribution until wave close | `isEpicOpenForProject` false ⇒ the original reset | `tests/unit/state/task-modified-files.test.ts` |
| `src/state.ts:resolveInitialTurboMode` | Config `turbo_mode` does not seed Turbo while an epic is open | Sentinel-first, evaluated only when `turbo_mode` is true | `turbo-mode-seeding-epic-sentinel.test.ts` |
| `src/session/snapshot-reader.ts:rehydrateState` | A restored session comes back with Turbo off while an epic is open | Probed only for a session that would restore Turbo | `snapshot-mode-state-regression.test.ts` |
| `src/session/snapshot-writer.ts` | Keeps writing the legacy `epicModeActive: false` constant | Byte-identical snapshot JSON | snapshot tests |
| `src/hooks/system-enhancer.ts:createSystemEnhancerHook` | `EPIC_MODE_BANNER` for the architect | Sentinel-first probe | `system-enhancer-epic-banner.test.ts`, `system-enhancer-epic-open-banner.test.ts` |
| `src/tools/phase-complete.ts:executePhaseComplete` | Adds `epic_phase_readiness` and makes Lean readiness not applicable | Check pushed only when an epic is open, so the gate report stays byte-identical | `phase-complete-epic-readiness.test.ts`, contract C1a |
| `src/commands/turbo.ts:handleTurboCommand` | Refuses Turbo-enabling paths while an epic is open; `turbo epic` redirects | Sentinel-first probe; the replies are upstream text | `turbo-epic-redirect.test.ts` |
| `src/commands/close/orchestrator.ts:handleCloseCommand` | Finalizes an open epic before the archive stage | `finalizeOpenEpicOnSwarmClose` returns null on the config gate (no I/O) | `tests/unit/epic/close-finalize.test.ts`, `close-finalizer-clean.test.ts` |
| `src/worktree/merge.ts` | Optional `landingCommitMessage` (explicit `--no-ff` merge commit) | Absent ⇒ the plain `git merge --no-edit` | `task-landing.test.ts` |
| `src/hooks/guardrails/index.ts:toolBefore` (gate tools, e.g. `pre_check_batch`) | In a multi-task wave, credits the gate run by its `files` to the one wave task whose frozen scope owns them (`resolveEpicGateTaskAttribution`), or to none with an advisory | Sentinel-first; `none` (no epic / single-task wave) keeps the upstream `currentTaskId` path | `tests/unit/epic/gate-attribution.test.ts`, `tests/unit/hooks/guardrails-epic-stage-a-attribution.test.ts` |
| `src/review/contracts.ts:ReviewDispatchRequest` / `createReviewModelDispatcher` | Optional `tools` map, used only by `epic_phase_review`'s provider-refusal retry (`EPIC_PHASE_REVIEW_BASH_RETRY_TOOLS`: the read-only map with `bash` re-enabled, because OpenCode Zen's free tier answers a `bash`-disabled request with HTTP 403; still narrower than the standard reviewer/critic agents, whose own config denies only write/edit/patch among the built-ins; the retry fires on any empty completion, since the dispatcher reports every provider-side error that way) | Absent ⇒ the shared `DEFAULT_READ_ONLY_TOOLS`, exactly as before | `tests/unit/review/dispatcher.test.ts`, `tests/unit/epic/phase-readiness-provider-retry.test.ts` |
| `src/db/coordination-store.ts:listCoordinationStateKeys` | Key-only listing for corrupt-row recovery | Called only by Epic | `lifecycle-writes.test.ts` (corrupt-state repair) |

**Upstream consumers of Epic modules (not gated, so be careful):** `src/plan/parallel-verdict.ts` and `src/tools/plan-conflict-check.ts` use `cochange-conflict.ts` / `cochange-source.ts` for **non-Epic** parallel verdicts. A change to those two modules changes non-Epic behaviour.

## Data and persistence

| Artifact | Writer | Lifetime | Retention row |
|---|---|---|---|
| coordination row, namespace `turbo.epic.lifecycle` (authority) | `lifecycle.ts` | one per project; deleted at close | `epic-lifecycle` |
| `.swarm/epic/epic.json` (sentinel projection) | `lifecycle.ts` | while open | `epic-lifecycle` |
| `.swarm/epic/shaping.json` (shaping iteration) | `plan-shaping-seam.ts` | per plan identity | `epic-lifecycle` |
| `.swarm/epic/reports/<key>.json` | `close.ts` | archived and cleaned by `/swarm close` | `epic-lifecycle` |
| `.swarm/epic/posterior.json` | `learning-store.ts` | open epic; merged into the prior at close | `epic-learning` |
| `.swarm/epic-prior/learning.json` (project prior) | `learning-store.ts` | **survives `/swarm close`**; `/swarm epic prior reset` clears it | `epic-learning` |
| `.swarm/epic-prior/reports/<epicKey>-<stamp>.json` (`epic-report-v2`) | `close.ts` | newest 50 kept; survives `/swarm close` | `epic-prior-reports` |
| `.swarm/evidence/{phase}/epic-phase-review.json` | `phase-readiness.ts` | one per phase, overwritten | `lean-turbo-evidence` |
| `.swarm/epic/coupling-report.json` | `src/commands/coupling.ts` (`/swarm coupling --persist` only) | one file, rewritten per run; cleaned with `.swarm/epic/` by `/swarm close` | `epic-turbo-state` |
| `.swarm/epic-state.json`, `.swarm/epic/{calibration.json,divergence.jsonl}`, namespace `turbo.epic.session` | no writer; `legacy-migration.ts` retires the v1 session rows and renames the projection, and `learning-store.ts` imports the calibration files once | swept | `epic-turbo-state` |
| `refs/swarm/epics/<epicKey>/{base,waves/<seq>,tasks/<id>}` | `markers.ts` | deleted at close unless `epic.retain_refs`; never pushed | — |
| branch `swarm/epic/<epicKey>` | `epic-branch.ts` | kept after close (user deletes it) | — |

**Which state wins.** The coordination row is the authority for "an epic is open". The sentinel is only its projection, written and removed inside the same lifecycle transaction. A sentinel without a row means no open epic, and `/swarm epic status` repairs it. A row whose plan identity no longer matches the current plan is orphaned: the probe answers "no open epic". The plan ledger stays the authority for task status, and Epic only reads it. The epic record's wave, task and phase state is the authority for Epic decisions; the git refs mirror it (`syncEpicRefs`) and `--repair-refs` reconciles them. The project prior outlives epics, and the posterior belongs to the open epic and is merged into the prior at close. For config precedence, see [Config](#config).

The rows live in `scripts/retention-registry.data.ts` and are rendered in `docs/observability-retention-registry.md`. Keep the line citations there exact, because `bun run check:registry-citations` verifies them. **Never rename the `turbo.epic.*` coordination namespaces.** They are persisted data names from before the move to `src/epic/`, not config paths.

## Hosts

Epic needs the OpenCode SDK client (`swarmState.opencodeClient`) for worktree-isolated coders (`STANDARD_WORKTREE_ISOLATION_UNAVAILABLE` → `EPIC_ISOLATION_DEGRADED`) and for `epic_phase_review` (`src/review/contracts.ts`). The OpenCode 2 adapter initializes the plugin with `client: undefined` (`src/host/v2/setup.ts`), so `startEpic` refuses `host-unsupported` there (`_internals.hostProvidesClient`; `null` means an uninitialized process such as a test and is allowed). Keep the check capability-based: when the v2 adapter gains a session-capable client (OpenCode 2's plugin API has `session.create`/`prompt`/`wait` and a `worktree` domain), Epic must start working there without an Epic change. Proof: `tests/unit/epic/start-host-unsupported.test.ts`.

## Config

- The canonical block is top-level `epic` (`EpicConfigSchema` in `src/config/schema.ts`): `mode {enabled, activation_threshold}`, `cochange {enabled, threshold, min_co_changes}`, `learning {enabled, decay_per_epic, half_life_days, hot_excess}`, `sizing {min_tasks, min_scope_coverage, min_effective_speedup, coder_fraction}`, `commit_policy`, `retain_refs`, and `phase_review {timeout_ms}` (per-role `epic_phase_review` dispatch budget, read by `resolveEpicPhaseReviewTimeoutMs`; same bounds and default as `auto_review.timeout_ms`). All of these are strict, and they need no `turbo` block. Defaults and meanings are in `docs/configuration.md`.
- **One resolver.** Every reader goes through `resolveEpicConfig(config)` (`config.ts`), either directly or via `config-gate.ts`. Never read `config.epic` or `config.turbo.epic` anywhere else.
- **The legacy `turbo.epic` path is accepted permanently**, and that is tested behaviour, not a TODO.
  - **Precedence.** The loader migrates each raw config file before the user + project merge. Within a file, top-level `epic` wins per key and the legacy block fills in the rest. Across files the normal precedence applies (project over user), whichever path each file used.
  - **The `turbo` block.** A `turbo` block left holding nothing is dropped, so `turbo.strategy` is no longer needed.
  - **Warnings and recovery.** The loader warns once per advisory-dedup window whenever any file has `turbo.epic` (`LEGACY_EPIC_CONFIG_WARNING`), and labels keys it recovers from a legacy block `(from turbo.epic)`. An invalid `epic` value goes through the standard recovery ladder, like any known key.
  - **Doctor.** It validates each raw file as the loader does and reports at the path the user wrote. It reports `legacy-epic-config-path` and never auto-fixes, because its fix model edits one value in one file and has no move-and-merge.
  - **JSON schema.** It marks the path `deprecated`, but it still requires `turbo.strategy` for editor validation; this is documented.
  - **Parsed configs that skip the loader.** `resolveEpicConfig` falls back to `turbo.epic`, and top-level wins whole.
- **Retired keys** (`mode.min_commits_for_signal`, `calibration`) are accepted and stripped under both paths, warned once (`findRetiredEpicConfigKeys`, `RETIRED_EPIC_*` in `schema.ts`), reported by the doctor, and kept `deprecated` in the JSON schema.
- Epic also reads `turbo.lean.max_parallel_coders` for a git epic's wave width when a Lean block exists (default 4; 1 in a non-git project).

## Tests

- **Unit:** `tests/unit/epic/` holds one area per file, with fixtures `*-fixture.ts`. Epic tests in shared directories: `tests/unit/agents/epic-tool-gating.test.ts`; `tests/unit/commands/{epic*,coupling*,turbo-epic-redirect}.test.ts`; `tests/unit/config/{epic-config-path,epic-config-path-doctor,epic-retired-config-keys,epic-learning-config,turbo-mode-seeding-epic-sentinel}.test.ts`; `tests/unit/hooks/{delegation-gate-epic-*,system-enhancer-epic-*}.test.ts`; `tests/unit/tools/{epic-*,phase-complete-epic-readiness,save-plan-epic-shaping*}.test.ts`; `tests/unit/background/completion-observer-epic-residue.test.ts`; and `tests/unit/state/task-modified-files.test.ts`.
- **Contracts** (`tests/integration/`): `epic-lifecycle-contract-c0` … `c7` each pin the behaviour one commit introduced. `epic-lifecycle-contract-final` is the full lifecycle on real git. `epic-lifecycle-contract-final-off` is the config-off twin and must stay byte-identical to the no-Epic baseline. Scenario tests: `epic-phase-fix-wave`, `epic-phase-handoff`, `epic-wave-planning`, and `epic-worktree-merge-guard`. Helpers: `tests/helpers/epic-{final-contract,landing,lifecycle}.ts`.
- **Planner regression harness:** `bun scripts/epic-bench.ts` prints the table (`scripts/epic-bench.ts` over `tests/fixtures/epic-bench/*.json`, simulated by `scripts/lib/epic-sim.ts`). The gate itself is the normal unit test `tests/unit/epic/epic-bench.test.ts`. After an **intended** planner or learning change, run `bun scripts/epic-bench.ts --write-golden`, review the `tests/fixtures/epic-bench/golden.json` diff line by line, and explain it in the commit. A golden change that nobody can explain is a regression.
- **Running:** run one file per process (AGENTS.md §6). Never use broad `test_runner` scopes.
  ```bash
  for f in tests/unit/epic/*.test.ts; do bun --smol test "$f" || echo "FAIL $f"; done
  for f in tests/integration/epic-*.test.ts; do bun --smol test "$f" --timeout 120000 || echo "FAIL $f"; done
  for f in $(grep -rliE 'epic' tests/unit --include='*.test.ts' | grep -v '^tests/unit/epic/'); do bun --smol test "$f" || echo "FAIL $f"; done
  bun run scripts/check-config-consumption.ts && bun run drift:check
  ```
  The third loop runs the Epic tests that live in shared directories, together with shared tests that touch Epic. Tests follow the repo rules: `bun:test`, a frozen clock (`tests/helpers/test-clock`), `canonicalMkdtemp`, `_internals` DI, and a 500-line limit per file.

## Recipes

**Add a plan-shaping suggestion type**
1. Add the variant to `EpicShapingSuggestion` and a builder in `shaping-suggestions.ts`. It must emit a concrete `save_plan` patch: complete resulting `files_touched` / `depends` for each touched task, plus valid unused ids for new tasks.
2. Wire it into `shapeEpicPlan` (`shaping.ts`). Respect the rank table (`declare-scope` → … → `merge-tasks`), the what-if guard (a patch that increases unscheduled tasks is rejected), and the work budget.
3. Format it in `formatEpicShapingLines`, and check the `/swarm coupling --suggest` output (`src/commands/coupling.ts`).
4. Add tests in `shaping.test.ts` / `shaping-patches.test.ts` that apply the patch through `save_plan`, as `save-plan-epic-shaping-apply.test.ts` does. Update the list in `docs/modes.md` (Plan shaping) and in the registry text of `/swarm coupling` (`src/commands/registry.ts`), then run `bun run generate:commands-docs --write`.

**Add an `epic_next_wave` blocked reason**
1. Add it to `EpicNextWaveBlockReason` (`next-wave-format.ts`), and produce it in `next-wave.ts` with a message that names the remedy.
2. Keep the call idempotent: calling it again with nothing changed must return the same answer. The architect is told to call `epic_next_wave` again whenever it is unsure.
3. Add a test in the matching `tests/unit/epic/next-wave-*.test.ts`, document it in `docs/modes.md` (the `epic_next_wave` flow), and update the tool description in `src/tools/tool-metadata.ts` if the status list changes.

**Change a learning weight or threshold**
1. Edit `EPIC_LEARNING_INCIDENT_WEIGHTS` / the constants in `learning.ts`, or the defaults in `EpicConfigSchema.learning` together with `DEFAULT_EPIC_LEARNING_SETTINGS` (they must agree).
2. Update `learning.test.ts`, then `bun scripts/epic-bench.ts --write-golden` and explain the golden diff. The harness guards the hot set and density demotion.
3. Update the formula in the `learning.ts` header and in `docs/modes.md` (Learning) and `docs/configuration.md`.

**Add an Epic config key**
1. Add it to `EpicConfigSchema` (`src/config/schema.ts`) inside the right strict sub-object, with a default and a doc comment. Read it **only** through `resolveEpicConfig(config)?.…`.
2. Regenerate: `bun run schema:generate` (updates `opencode-swarm.schema.json` and the generated key table in `docs/configuration.md`). Document the key in the `epic` section of `docs/configuration.md` and in the table in `docs/modes.md`.
3. A nested key needs no ratchet entry, but `bun run scripts/check-config-consumption.ts` must still pass. A **new top-level** key needs a `CONFIG_CONSUMERS` entry in `src/config/consumers.ts` (#2904 ratchet) and a doctor `validateConfigKey` case, and it moves the pinned key count in `tests/unit/scripts/check-config-consumption-cli.test.ts`.
4. Test the top-level path and the legacy `turbo.epic` path (the migration carries any key). To retire a key, add it to `RETIRED_EPIC_MODE_KEYS` / `RETIRED_EPIC_KEYS` with a replacement hint. Keep accepting it.

**Debug a stuck epic**
- `/swarm epic status` (or bare `/swarm epic`) shows the epic, waves, phases, components, divergence, orphan detection, sentinel/row repair, and recorded merge failures (blocking, undated or stale, with the remedy).
- Call `epic_next_wave` and read `status` and `reason`. `blocked: merge-failed` means a recorded worktree merge failure. Once the task's work is really in the tree, or the record belongs to another plan, run `/swarm epic clear-merge-failure <taskId>` (preview) and then `--confirm`.
- Task refs that a rebase or amend made unreachable: `/swarm epic status --repair-refs`.
- `epic-branch-mismatch`: run `git checkout swarm/epic/<epicKey>`.
- Unreadable or orphaned state, or a plan that is gone: `/swarm epic close --abandon` works even with the config gate off, once no coder is still running (it refuses `coders-live` while a coder settlement is owned by a live dispatch). It never lands, and it switches back to the original branch when the tree is clean.
- To see what the planner learned, use `/swarm epic learning`. To start from a clean prior, use `/swarm epic prior reset`, which prints a single-use confirm token.

## Design rationale and decisions

This section records why things are the way they are. Do not undo a decision listed here without understanding the failure it prevents.

- **No non-Epic change.** Epic lives in shared files only behind gates that cost at most one `existsSync` (the sentinel) or a read of config that is already loaded. Bugs found in shared code are worked around on the Epic side, not fixed in the Epic change set; they are listed under Known caveats. The only approved non-Epic difference is that the architect no longer gets the Epic tools by default: `EPIC_AGENT_TOOL_MAP` grants them only when `epic.mode.enabled` is true, so non-Epic prompts and permissions stay clean.
- **Commit at landing, not at completion.** Epic v1 committed a task when it completed (the "Rule 2" marker commits). That deadlocked in-wave rework: the first attempt landed unstaged, the rework worktree was cut from a HEAD that lacked it, and the second landing overlapped the uncommitted bytes forever. Now each coder's worktree lands as a real `--no-ff` merge commit, so the work is in HEAD before anything depends on it. Non-coder writers (tests, docs) get residue commits for the same reason. `update_task_status` does no git writes.
- **Plan-scoped markers.** Task ids repeat across plans (every plan has a `1.1`). Commit markers therefore carry a `Swarm-Plan: <planKey>` trailer, and merge failures are filtered by epoch on the Epic side. The shared merge-status registry also serves `/swarm lanes` and recovery, so Epic does not re-key it. A failure with no date counts as relevant (fail closed), and `clear-merge-failure` is the way out.
- **Epic branch plus squash landing by default.** Epic commits never pollute the user's branch while the epic runs. Closing stages a squash for the user to review and commit, and the user's own hooks and signing run on that final commit. `current-branch` keeps the old behaviour for people who want it.
- **Sentinel separate from the row, with token CAS.** The row in the coordination store is the authority, but opening the database on every hot-path probe would cost non-Epic users I/O. The sentinel file makes "Epic is off" cost one `existsSync`. Writes happen inside a `BEGIN IMMEDIATE` transaction, and removals compare epicKey + token, so concurrent or late closes can never delete a newer epic. The probe has no memo, because a memo goes stale across processes.
- **The wave is the gate's authority, with one verdict.** Live scope bindings expire and follow plan revisions, so the gate decides from the scopes frozen when `epic_next_wave` issued the wave. `epic_next_wave` asserts the same `computeEpicWaveVerdict` call that the gate repeats. The gate therefore never serializes a wave the planner issued, and never admits a coder outside the active wave.
- **Per-component planning, not a plan-wide coupling gate.** The v1 plan-wide `p` threshold serialized whole plans because of one dense cluster. Components let independent clusters run in parallel, and only a dense component runs one task per wave (`activation_threshold`, reused as the density threshold). Sizing at start uses Amdahl's law (`S_eff`), because QA stays serial.
- **Learning model.** Two signals, both analysis only and never write authorization:
  - Learned scope expansion only ADDS planner edges, so it can never break the verdict parity above.
  - A hot file needs excess evidence (a Beta prior, and `α' ≥ 1`), so a cold start is neutral: an empty history serializes nothing.
  - The strongest-co-writer discount stops one declarer writing a file from counting as heat, because expansion already separates them.
  - Age decay is a step function in whole half-lives (full weight for a whole half-life), plus `decay_per_epic`, and the state is capped. This keeps the prior bounded and current.
- **Shaping work budget.** `save_plan` sits on the architect's critical path, so shaping is pure, uses only the warm co-change cache (no git scan), runs after the plan lock is released, fails open, and is cut off by a work budget (`skipped-budget`). Every suggestion is a concrete `save_plan` patch judged by a what-if, never prose.
- **Config is top-level `epic`, and the legacy path migrates permanently.** Epic is not a Turbo overlay, and under `turbo` a missing `strategy` silently dropped the whole block. Removing the legacy path would break existing configs, so it is migrated forever: per file, then merged with the normal precedence. Retired keys are accepted and stripped rather than rejected. An old config then loads without any recovery and with a precise "retired" warning, instead of an unrecognized-key recovery.
- **Tool-owned lifecycle.** The banner says only "call `epic_next_wave`". The procedure travels in the tool's response, so weaker models cannot drift from it, and `epic_next_wave` is idempotent so that repeat calls are safe.

## Known caveats

- These are user-facing limits, and each has a remedy. They are listed in `docs/modes.md` (Epic Mode): a manual edit to an undeclared tracked file blocks the next wave (`dirty-baseline`); landing and residue commits skip hooks and signing until the squash at close; a plain `git rebase` drops landing merges (use `--repair-refs`); Turbo enabled in a different OpenCode process is not detectable; learned signals are path heuristics.
- The scorecard's concurrency factor, sizing's effective speedup, and the harness are estimates, not speed measurements.
- CI: the pull-request platform-path filter in `.github/workflows/ci.yml` (job output `touches-platform-paths`) lists `src/turbo/` but not `src/epic/`. The workflow is pinned by the required-check contract hash (`scripts/required-check-contract.json`), so editing it requires recapturing the contract. A pull request that touches only `src/epic/` therefore runs only the Ubuntu unit matrix, while `merge_group` always runs the full three-OS matrix.

**Non-Epic upstream issues observed while building Epic** (Epic works around them and does not change them):
- Lean `planLeanTurboLanes` produces one lane in practice (`src/turbo/lean/planner.ts`), and its scope read uses the v1 projection.
- `/swarm turbo` and Lean texts (`TURBO_MODE_BANNER`, `LEAN_TURBO_BANNER`, `TURBO_BYPASS_DISCLOSURE`) still describe old Stage B bypass behaviour.
- Stale comments name deleted Epic v1 modules: `src/utils/logger.ts` (epic-promotions), `src/turbo/lean/partition-common.ts` (`planEpicWaves`), `src/turbo/lean/planner.ts`.
- The delegation gate's tier-3 `startsWith('3.')` heuristic.
- The worktree lifecycle lock retries for about 310 ms.
- Foreground coder write attribution lands on the child session (#2926).
- Some upstream tests fail or leak on a pristine upstream checkout independently of Epic. Examples are `tests/unit/tools/phase-complete-phase-council.adversarial.test.ts` and `system-guidance-delivery-fail-open-2780`, which writes into the real data directory. Before blaming Epic for a failure, compare against a clean upstream checkout.
