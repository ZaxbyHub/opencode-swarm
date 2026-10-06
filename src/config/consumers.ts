/**
 * Config-consumption declaration (issue #2904) - the single source of truth for
 * WHICH production code consumes each top-level `PluginConfigSchema` key.
 *
 * Every key MUST declare either `consumers` (repo-relative `path:symbol` citations,
 * each verified by `bun run scripts/check-config-consumption.ts`) or `inert` (a
 * reason string; `/swarm config doctor` then warns when a user's config file
 * sets the key).
 * Exhaustive by construction: `Record<TopLevelConfigKey, ...>` fails `bun run typecheck`
 * the moment a schema key is added without an entry here.
 *
 * Citation rules (enforced by the gate):
 *  - citations live in non-test `src/**`; `src/config/schema.ts` is never a consumer
 *    (schema-definition is not consumption)
 *  - a citation into `src/services/config-doctor.ts` never satisfies the ratchet alone
 *    (that file references every key via its validateConfigKey cases); keys genuinely
 *    owned by the doctor are enumerated in the gate's DOCTOR_FILE_EXEMPT
 *  - DI/test seams (`_internals`, `_test_exports`) are never consumers
 *  - a reference means member access, bracket access, destructure shorthand, or a
 *    quoted case label - in code, not comments or string text (matcher details in
 *    scripts/check-config-consumption.ts)
 */
import type { PluginConfigSchema } from './schema.js';

export type TopLevelConfigKey = keyof typeof PluginConfigSchema.shape;

/** `'src/path/to/file.ts:symbol'` - the symbol is a representative exported
 * declaration in the cited file. The gate verifies the symbol is DECLARED in the
 * file and that the FILE references the key (file-level reference; the symbol
 * anchors the citation for human readers, it does not scope the search). */
export type ConsumerCitation = string;

export type ConfigConsumerDeclaration =
	| { consumers: ConsumerCitation[] }
	| { inert: string };

export const CONFIG_CONSUMERS: Record<
	TopLevelConfigKey,
	ConfigConsumerDeclaration
> = {
	$schema: { consumers: ['src/services/config-doctor.ts:validateConfigKey'] },
	config_format_version: {
		consumers: [
			'src/services/config-doctor.ts:validateConfigKey',
			'src/services/config-doctor.ts:runConfigDoctor',
		],
	},
	preset: {
		consumers: [
			'src/commands/council.ts:parseArgs',
			'src/config/loader.ts:loadRawConfigFromPath',
			'src/index.ts:initializeOpenCodeSwarm',
			'src/tools/phase-complete/gates/final-review-gate.ts:runFinalReviewGate',
		],
	},
	agents: {
		consumers: [
			'src/agents/index.ts:_swarmAgentsMap',
			'src/commands/full-auto.ts:handleFullAutoCommand',
		],
	},
	default_agent: {
		consumers: [
			'src/agents/index.ts:getAgentConfigs',
			'src/services/model-preflight.ts:collectEnabledAgentModels',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	auto_select_architect: {
		consumers: [
			'src/index.ts:initializeOpenCodeSwarm',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	swarms: {
		consumers: [
			'src/agents/index.ts:createAgents',
			'src/config/agent-model.ts:resolveAgentTarget',
			'src/index.ts:initializeOpenCodeSwarm',
			'src/review/runtime.ts:effectiveAgentConfig',
		],
	},
	max_iterations: {
		consumers: [
			'src/index.ts:initializeOpenCodeSwarm',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	pipeline: {
		consumers: [
			'src/hooks/system-enhancer.ts:createSystemEnhancerHook',
			'src/memory/embeddings/local-provider.ts:LocalEmbeddingProvider',
			'src/memory/embeddings/reranker.ts:CrossEncoderReranker',
			'src/memory/pii.ts:NerPiiDetector',
		],
	},
	phase_complete: {
		consumers: [
			'src/index.ts:initializeOpenCodeSwarm',
			'src/tools/phase-complete.ts:executePhaseComplete',
			'src/tools/plugin-registration.ts:buildPluginToolObject',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	qa_retry_limit: {
		consumers: [
			'src/agents/index.ts:createSwarmAgents',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	execution_mode: {
		consumers: [
			'src/agents/architect.ts:createArchitectAgent',
			'src/agents/index.ts:createSwarmAgents',
			'src/index.ts:initializeOpenCodeSwarm',
			'src/plan/planning-profile.ts:resolveRepositoryDefaultPlanningProfile',
		],
	},
	inject_phase_reminders: {
		consumers: [
			'src/hooks/pipeline-tracker.ts:createPipelineTrackerHook',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	hooks: {
		consumers: [
			'src/commands/registry.ts:handlePrFeedbackCommandWithTransition',
			'src/hooks/agent-activity.ts:createAgentActivityHooks',
			'src/hooks/compaction-customizer.ts:createCompactionCustomizerHook',
			'src/hooks/delegation-tracker.ts:createDelegationTrackerHook',
		],
	},
	pr_review_resilience: {
		consumers: [
			'src/tools/dispatch-lanes.ts:executeDispatchLanesAsync',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	review_routing: {
		consumers: [
			'src/background/stage-b-gates.ts:ingestBackgroundStageBCompletion',
			'src/hooks/delegation-gate.ts:createDelegationGateHook',
			'src/tools/update-task-status.ts:routeGateAllowsTask',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	lane_liveness_watchdog: {
		consumers: [
			'src/commands/registry.ts:handlePrFeedbackCommandWithTransition',
			'src/tools/abort-pr-workflow.ts:executeAbortPrWorkflow',
			'src/tools/complete-pr-workflow.ts:executeCompletePrWorkflow',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	dispatch_protection: {
		consumers: [
			'src/index.ts:initializeOpenCodeSwarm',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	pr_review_legacy_transcript_compatibility: {
		consumers: [
			'src/tools/dispatch-lanes.ts:launchAsyncLane',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	gates: {
		consumers: [
			'src/config/loader.ts:sanitizeGatesConfig',
			'src/commands/qa-gates.ts:handleQaGatesCommand',
			'src/commands/gate-audit.ts:parseArgs',
		],
	},
	context_budget: {
		consumers: [
			'src/hooks/context-budget.ts:createContextBudgetHandler',
			'src/hooks/final-context-accounting.ts:createFinalContextAccountingStep',
			'src/hooks/system-enhancer.ts:createSystemEnhancerHook',
			'src/index.ts:initializeOpenCodeSwarm',
		],
	},
	pricing: {
		consumers: [
			'src/background/delegation-lifecycle.ts:emitDelegationCostObservation',
			'src/evaluation/ephemeral-agent-dispatcher.ts:unavailableCostFields',
			'src/index.ts:emitPendingCostCorrection',
			'src/services/cost-accounting.ts:extractCostEvidence',
		],
	},
	guardrails: {
		consumers: [
			'src/config/loader.ts:buildConfigWithMeta',
			'src/hooks/full-auto-permission.ts:createFullAutoPermissionHook',
			'src/index.ts:initializeOpenCodeSwarm',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	watchdog: {
		consumers: [
			'src/hooks/pr-workflow-gate.ts:evaluateLaneLivenessWatchdogEscalation',
			'src/index.ts:initializeOpenCodeSwarm',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	self_review: {
		consumers: [
			'src/index.ts:initializeOpenCodeSwarm',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	auto_review: {
		consumers: [
			'src/agents/index.ts:createSwarmAgents',
			'src/index.ts:initializeOpenCodeSwarm',
			'src/tools/phase-complete/gates/final-review-gate.ts:runFinalReviewGate',
			'src/tools/plugin-registration.ts:buildPluginToolObject',
		],
	},
	tool_filter: {
		consumers: [
			'src/agents/index.ts:getAgentConfigs',
			'src/full-auto/policy.ts:resolveAgentCapabilityTools',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	authority: {
		consumers: [
			'src/hooks/delegation-gate/worktree-isolation.ts:maybeSelectRecoverableAuthority',
			'src/hooks/delegation-gate/worktree-recovery-authority.ts:publishWorktreeRecoveryAuthorityUnlocked',
			'src/index.ts:initializeOpenCodeSwarm',
			'src/learning/provenance.ts:stampLearningProvenance',
		],
	},
	plan_cursor: {
		consumers: [
			'src/hooks/system-enhancer.ts:createSystemEnhancerHook',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	context_map: {
		consumers: [
			'src/hooks/context-capsule-inject.ts:createContextCapsuleInjectHook',
			'src/index.ts:initializeOpenCodeSwarm',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	repo_graph: {
		consumers: [
			'src/evaluation/retrieval-quality.ts:materializeDisposableWorkspace',
			'src/hooks/repo-graph-injection.ts:buildLaneOrientationBlock',
			'src/hooks/system-enhancer.ts:createSystemEnhancerHook',
			'src/index.ts:initializeOpenCodeSwarm',
		],
	},
	evidence: {
		consumers: [
			'src/background/candidate-parser.ts:parseText',
			'src/background/pr-review-trigger-contract.ts:buildPrReviewTriggerReceiptV2',
			'src/background/stage-b-gates.ts:resolveBackgroundStageBRoute',
			'src/commands/archive.ts:handleArchiveCommand',
		],
	},
	summaries: {
		consumers: [
			'src/commands/close/orchestrator.ts:handleCloseCommand',
			'src/index.ts:createSwarmCommandSystemRuleHook',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	retention: {
		consumers: [
			'src/commands/close/orchestrator.ts:handleCloseCommand',
			'src/index.ts:initializeOpenCodeSwarm',
			'src/training/vault.ts:sweepTrainingVaultExpiry',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	review_passes: {
		consumers: [
			'src/hooks/system-enhancer.ts:createSystemEnhancerHook',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	adversarial_detection: {
		consumers: [
			'src/hooks/system-enhancer.ts:createSystemEnhancerHook',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	adversarial_testing: {
		consumers: [
			'src/agents/index.ts:createSwarmAgents',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	integration_analysis: {
		consumers: [
			'src/hooks/system-enhancer.ts:createSystemEnhancerHook',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	docs: {
		consumers: [
			'src/hooks/system-enhancer.ts:createSystemEnhancerHook',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	design_docs: {
		consumers: [
			'src/agents/index.ts:createSwarmAgents',
			'src/commands/design-docs.ts:handleDesignDocsCommand',
			'src/services/model-preflight.ts:collectConfiguredAgentModels',
			'src/tools/phase-complete.ts:executePhaseComplete',
		],
	},
	speckit_checkoff: {
		consumers: [
			'src/sdd/speckit-checkoff.ts:maybePropagateSpeckitCheckoff',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	git: { consumers: ['src/config/loader.ts:exposedGitBinary'] },
	ui_review: {
		consumers: [
			'src/agents/index.ts:createSwarmAgents',
			'src/hooks/system-enhancer.ts:createSystemEnhancerHook',
			'src/services/model-preflight.ts:collectConfiguredAgentModels',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	compaction_advisory: {
		consumers: [
			'src/hooks/system-enhancer.ts:createSystemEnhancerHook',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	lint: {
		consumers: [
			'src/agents/project-context.ts:selectLintCommand',
			'src/hooks/system-enhancer.ts:createSystemEnhancerHook',
			'src/services/trajectory-cluster.ts:motifPredicate',
			'src/tools/pre-check-batch.ts:serializePreCheckResult',
		],
	},
	secretscan: {
		consumers: [
			'src/hooks/system-enhancer.ts:createSystemEnhancerHook',
			'src/tools/secretscan.ts:runSecretscan',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	checkpoint: {
		consumers: [
			'src/background/delegation-health.ts:writeDelegationHealthArtifact',
			'src/hooks/knowledge-receipt-ledger.ts:validateRecordPayload',
			'src/plan/auto-checkpoint.ts:maybeSaveAutoCheckpoint',
			'src/services/status-service.ts:formatStatusMarkdown',
		],
	},
	apply_patch: {
		consumers: [
			'src/tools/apply-patch.ts:isUnsupportedPatchFormat',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	automation: {
		consumers: [
			'src/hooks/system-enhancer.ts:createSystemEnhancerHook',
			'src/index.ts:initializeOpenCodeSwarm',
			'src/services/status-service.ts:collectDecisionDriftSnapshot',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	knowledge: {
		consumers: [
			'src/commands/close/orchestrator.ts:handleCloseCommand',
			'src/commands/consolidate.ts:handleConsolidateCommand',
			'src/commands/curate.ts:handleCurateCommand',
			'src/commands/knowledge.ts:authorizeUserCuration',
		],
	},
	memory: {
		consumers: [
			'src/agents/index.ts:createSwarmAgents',
			'src/commands/close/orchestrator.ts:handleCloseCommand',
			'src/commands/memory-link.ts:handleMemoryLinkCommand',
			'src/commands/memory.ts:handleMemoryConsolidationLogCommand',
		],
	},
	forge: {
		consumers: [
			'src/providers/forge-provider.ts:resolveForgeContextFromPluginConfig',
		],
	},
	observability: {
		consumers: [
			'src/index.ts:initializeOpenCodeSwarm',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	learning: {
		consumers: [
			'src/hooks/knowledge-dedup-sweep.ts:sweepActiveNearDuplicates',
			'src/hooks/system-enhancer.ts:createSystemEnhancerHook',
			'src/index.ts:initializeOpenCodeSwarm',
			'src/memory/config.ts:resolveMemoryConfig',
		],
	},
	consensus: {
		consumers: [
			'src/tools/consensus-mine.ts:consensus_mine',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	curator: {
		consumers: [
			'src/hooks/phase-monitor.ts:createPhaseMonitorHook',
			'src/services/diagnose-service.ts:checkCurator',
		],
	},
	architectural_supervision: {
		consumers: [
			'src/agents/index.ts:createSwarmAgents',
			'src/hooks/phase-monitor.ts:createPhaseMonitorHook',
			'src/tools/phase-complete/gates/architecture-supervisor-gate.ts:runArchitectureSupervisorGate',
			'src/tools/phase-complete.ts:executePhaseComplete',
		],
	},
	knowledge_application: {
		consumers: [
			'src/index.ts:initializeOpenCodeSwarm',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	skillPropagation: {
		consumers: [
			'src/index.ts:initializeOpenCodeSwarm',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	skill_improver: {
		consumers: [
			'src/commands/close/finalize-stage.ts:runFinalizeStage',
			'src/commands/consolidate.ts:handleConsolidateCommand',
			'src/index.ts:initializeOpenCodeSwarm',
			'src/tools/phase-complete.ts:executePhaseComplete',
		],
	},
	harness_evolution: {
		consumers: [
			'src/commands/harness.ts:getHarnessConfig',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	harness_opt: {
		consumers: [
			'src/commands/harness-opt.ts:readHarnessOptConfigFromProject',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	spec_writer: { consumers: ['src/tools/spec-write.ts:MAX_SPEC_BYTES'] },
	tool_output: {
		consumers: [
			'src/index.ts:initializeOpenCodeSwarm',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	slop_detector: {
		consumers: [
			'src/index.ts:initializeOpenCodeSwarm',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	todo_gate: {
		consumers: [
			'src/tools/check-gate-status.ts:readEvidenceFile',
			'src/tools/phase-complete/gates/todo-gate.ts:runTodoGateGate',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	incremental_verify: {
		consumers: [
			'src/index.ts:initializeOpenCodeSwarm',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	compaction_service: {
		consumers: [
			'src/index.ts:initializeOpenCodeSwarm',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	prm: {
		consumers: [
			'src/index.ts:initializeOpenCodeSwarm',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	council: {
		consumers: [
			'src/agents/index.ts:createSwarmAgents',
			'src/commands/pr-review.ts:parseArgs',
			'src/full-auto/policy.ts:resolveAgentCapabilityTools',
			'src/gate-evidence.ts:clearWorkflowGateProof',
		],
	},
	parallelization: {
		inert:
			'PR-1 dark foundation — no production code path branches on enabled=true yet, so setting this key has no runtime effect. For live parallel dispatch use the plan execution_profile (parallelization_enabled, max_concurrent_tasks, set per-plan by the architect; see /swarm concurrency).',
	},
	worktree: {
		consumers: [
			'src/background/completion-observer.ts:createBackgroundCompletionObserver',
			'src/background/pending-delegations.ts:isUnsettledWorktreeOwner',
			'src/config/worktree-isolation-config.ts:resolveWorktreeIsolationConfig',
			'src/hooks/delegation-gate/worktree-collision-ownership.ts:classifyRecord',
		],
	},
	turbo: {
		consumers: [
			'src/agents/index.ts:createSwarmAgents',
			'src/commands/turbo.ts:handleTurboCommand',
			'src/config/worktree-isolation-config.ts:resolveWorktreeIsolationConfig',
			// Epic: the legacy `turbo.epic` fallback + the Lean wave width
			'src/epic/config.ts:resolveEpicConfig',
			'src/epic/shaping-sizing.ts:epicWaveWidth',
		],
	},
	// Epic Mode (top-level `epic`): every reader resolves it through
	// resolveEpicConfig; migrateLegacyEpicConfig folds the legacy `turbo.epic`
	// path into it in the loader (src/epic/README.md, "Config").
	epic: {
		consumers: [
			'src/epic/config.ts:resolveEpicConfig',
			'src/epic/config.ts:migrateLegacyEpicConfig',
		],
	},
	turbo_mode: {
		consumers: [
			'src/state.ts:resolveInitialTurboMode',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	quiet: {
		consumers: [
			'src/agents/index.ts:createSwarmAgents',
			'src/hooks/skill-injection.ts:SKILL_INJECTION_TOP_N',
			'src/index.ts:initializeOpenCodeSwarm',
			'src/utils/gitignore-warning.ts:ensureSwarmGitExcluded',
		],
	},
	version_check: {
		consumers: [
			'src/index.ts:initializeOpenCodeSwarm',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	full_auto: {
		consumers: [
			'src/commands/full-auto.ts:handleFullAutoCommand',
			'src/config/loader.ts:rawFullAutoLocked',
			'src/full-auto/cadence.ts:configCadence',
			'src/hooks/full-auto-delegation.ts:scanForProtectedPaths',
		],
	},
	pr_feedback_loop: {
		consumers: [
			'src/background/pr-feedback-loop-runtime.ts:isPrFeedbackLoopEnabled',
			'src/background/pr-feedback-loop.ts:claimAndProcessPrFeedbackEventUnlocked',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	pr_monitor: {
		consumers: [
			'src/background/pr-feedback-loop-runtime.ts:isPrFeedbackLoopEnabled',
			'src/commands/pr-subscribe.ts:handlePrSubscribeCommand',
			'src/index.ts:initializeOpenCodeSwarm',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	external_skills: {
		consumers: [
			'src/agents/index.ts:createSwarmAgents',
			'src/full-auto/policy.ts:resolveAgentCapabilityTools',
		],
	},
	skills: {
		consumers: [
			'src/agents/index.ts:createSwarmAgents',
			'src/config/lane-permissions.ts:LastWinsRuleMap',
			'src/full-auto/policy.ts:resolveAgentCapabilityTools',
			'src/services/skill-improver.ts:buildUserPrompt',
		],
	},
	skill_opt: {
		consumers: [
			'src/commands/skill-opt.ts:readSkillOptConfigFromProject',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
	dashboard: {
		consumers: [
			'src/index.ts:initializeOpenCodeSwarm',
			'src/services/config-doctor.ts:validateConfigKey',
		],
	},
};

// The map is repo-authored, ratchet-enforced truth; freezing it keeps
// test files (which read it directly for production-map pins) from ever
// silently mutating the production declarations.
Object.freeze(CONFIG_CONSUMERS);
