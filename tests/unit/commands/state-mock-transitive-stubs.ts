/**
 * Runtime state exports reached only through command-test transitive imports.
 * Close-command suites replace their directly exercised stateful bindings
 * separately; these inert bindings keep unrelated hook modules loadable.
 */
export const STATE_MOCK_TRANSITIVE_STUBS = {
	// State's test seam is imported by transitive guardrail modules. Close tests
	// do not execute it, but the export must exist while state.js is mocked.
	_internals: {},
	// Per-session context budget. Reached transitively through index.ts and
	// services/compaction-service.ts; a missing binding makes Bun throw
	// "Export named 'getSessionBudgetPct' not found" at import time and fail
	// the whole file before a single test runs.
	getSessionBudgetPct: () => 0,
	getSessionBudgetTokens: () => 0,
	setSessionBudget: () => undefined,
	getDisplayBudget: () => null,
	// #2107 §3 final-prompt-pressure exports. Reached transitively through
	// services/compaction-service.ts (and the final-context-accounting hook
	// module via index.ts); same missing-binding failure class as above.
	setFinalPromptPressure: () => undefined,
	getFinalPromptPressure: () => undefined,
	getDisplayFinalPromptPressure: () => null,
	setFinalAccountingWarningBand: () => undefined,
	getFinalAccountingWarningBand: () => false,
	clearFinalAccountingWarningBands: () => undefined,
	// Issue #3320: primary-owner / swarm-ownership exports reached transitively
	// through delegation-tracker.ts, guardrails/tool-before.ts, and the v2
	// adapters (all in the chat/tool hook graph the close commands import);
	// same missing-binding failure class as above.
	recordPrimaryOwner: () => undefined,
	getPrimaryOwner: () => undefined,
	isRegisteredSwarmSubagent: () => false,
	isSwarmOwnedSession: () => false,
	// Issue #3036: dispatch-lineage exports reached transitively through the
	// delegation-gate / delegate-directive-injection / knowledge-receipt-tool
	// importers; same missing-binding failure class as above.
	recordPendingDispatchAuthorization: () => undefined,
	resolveDispatchParent: () => undefined,
	clearDispatchLineageForSession: () => undefined,
	// #3403: generation-stamped lineage writes + attempt-scoped rollback,
	// consumed by the delegation gate's taskMetadata through the same
	// transitive importers as the lineage exports above.
	writeDispatchParentEntry: () => 0,
	restoreDispatchParentEntry: () => undefined,
	MAX_TRACKED_DISPATCH_PARENTS: 200,
	PENDING_DISPATCH_AUTHORIZATION_TTL_MS: 600_000,
	MAX_TRACKED_BUDGET_SESSIONS: 500,
	MAX_TRACKED_TASK_FILE_ATTRIBUTIONS: 128,
	applyRehydrationCache: () => undefined,
	buildRehydrationCache: async () => undefined,
	beginInvocation: () => undefined,
	getActiveWindow: () => undefined,
	advanceTaskState: () => undefined,
	advanceTaskStateAndPersist: async () => undefined,
	getTaskState: () => undefined,
	recordStageBCompletion: () => undefined,
	setCriticalShownIds: () => undefined,
	clearCriticalShownIds: () => undefined,
	// #2672: instruction-pairing (memory barrel -> commands/memory.ts graph)
	// transitively imports the live-context identity exports from state.js;
	// same missing-binding failure class as above while state.js is mocked.
	getLiveContextModelIdentity: () => null,
	getLiveContextWindow: () => null,
	// Issue #2491 route-bound Stage-B projection. Close-command tests do not
	// exercise these bindings, but transitive imports resolve every named export
	// while state.ts is mocked.
	recordStageBRouteEvidence: () => undefined,
	reserveStageBRouteEvidence: () => null,
	getStageBRouteEvidence: () => [],
	clearStageBRouteEvidence: () => undefined,
	markStageBRouteRequired: () => undefined,
	isStageBRouteRequired: () => false,
	clearStageBRouteRequired: () => undefined,
	hasBothStageBCompletions: () => false,
	isCouncilGateActive: async () => false,
	MAX_REVIEWER_SCOPE_GENERATION_FILES: 256,
	MAX_REVIEWER_SCOPE_GENERATIONS: 256,
	MAX_REVIEWER_SCOPE_OWNERSHIP_HISTORY: 256,
	REVIEWER_SCOPE_GENERATION_TTL_MS: 30 * 60 * 1000,
	startReviewerScopeGeneration: () => undefined,
	recordReviewerScopeGenerationFile: () => undefined,
	recordReviewerScopeGenerationFileFingerprint: () => undefined,
	markReviewerScopeGenerationReady: () => false,
	getReviewerScopeGenerationForCoderCall: () => undefined,
	peekReadyReviewerScopeGeneration: () => undefined,
	claimReviewerScopeGeneration: () => undefined,
	attachReviewerScopeGenerationDispatchSnapshot: () => false,
	takeReviewerScopeGeneration: () => undefined,
	getReviewerScopeOwnershipHistory: () => [],
	peekReviewerScopeGenerationClaim: () => undefined,
	discardReviewerScopeGenerationClaim: () => undefined,
	reviewerScopeGenerationHasDeclaredOverlap: () => false,
	discardReviewerScopeGenerationForCoderCall: () => undefined,
	isReviewerScopeGenerationCurrent: () => false,
	markReviewerScopeGenerationNoChange: () => false,
	markReviewerScopeGenerationMergebackPending: () => false,
	settleReviewerScopeMergeback: () => false,
	peekReviewerScopeGenerationByStatus: () => undefined,
	recordReviewerScopeGenerationCaptureFailure: () => false,
	resetModifiedFilesForTask: () => false,
	recordModifiedFilesForTask: () => false,
	recordModifiedFileForTask: () => false,
	getModifiedFilesForTask: () => [],
	// Issue #2002 — lane-workspace-root recording/resolution. Not exercised by
	// close-command assertions, but reached transitively via the delegation
	// gate / scope-guard import graph. recordSessionWorkspaceRoot is a no-op
	// (no session bookkeeping needed here); resolveSessionWorkspaceDirectory
	// mirrors the real fail-closed default of returning fallbackDirectory
	// unconditionally, since this mock never records a workspace root.
	recordSessionWorkspaceRoot: () => undefined,
	resolveSessionWorkspaceDirectory: (
		_sessionId: string,
		fallbackDirectory: string,
	) => fallbackDirectory,
} as const;
