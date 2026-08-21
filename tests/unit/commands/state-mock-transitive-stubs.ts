/**
 * Runtime state exports reached only through command-test transitive imports.
 * Close-command suites replace their directly exercised stateful bindings
 * separately; these inert bindings keep unrelated hook modules loadable.
 */
export const STATE_MOCK_TRANSITIVE_STUBS = {
	// Per-session context budget. Reached transitively through index.ts and
	// services/compaction-service.ts; a missing binding makes Bun throw
	// "Export named 'getSessionBudgetPct' not found" at import time and fail
	// the whole file before a single test runs.
	getSessionBudgetPct: () => 0,
	getSessionBudgetTokens: () => 0,
	setSessionBudget: () => undefined,
	getDisplayBudget: () => null,
	MAX_TRACKED_BUDGET_SESSIONS: 500,
	beginInvocation: () => undefined,
	getActiveWindow: () => undefined,
	advanceTaskState: () => undefined,
	advanceTaskStateAndPersist: async () => undefined,
	getTaskState: () => undefined,
	recordStageBCompletion: () => undefined,
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
