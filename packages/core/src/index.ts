/**
 * Core Package Barrel
 *
 * Re-exports all public symbols from core submodules for convenient importing.
 */

// Re-export agents module
export * from './agents';
// Re-export background module
export * from './background';
// Re-export config module (constants, evidence-schema, loader, plan-schema, schema)
export * from './config/index';
// Re-export additional loader items not in config/index
export { loadRawConfigFromPath, MAX_CONFIG_FILE_BYTES } from './config/loader';
// Re-export config schema exports needed by opencode commands
export type { KnowledgeConfig } from './config/schema';
export { KnowledgeConfigSchema, SummaryConfigSchema } from './config/schema';
// Re-export evidence module
export * from './evidence';
// Re-export specific evidence utilities needed by opencode
export { isValidEvidenceType, VALID_EVIDENCE_TYPES } from './evidence/manager';
// Re-export gate-evidence module
export * from './gate-evidence';

// Re-export hooks module (selective to avoid conflicts with knowledge exports)
export {
	classifyMessage,
	classifyMessages,
	composeHandlers,
	consolidateSystemMessages,
	containsPlanContent,
	createAgentActivityHooks,
	createCompactionCustomizerHook,
	createContextBudgetHandler,
	createDelegationGateHook,
	createDelegationSanitizerHook,
	createDelegationTrackerHook,
	createGuardrailsHooks,
	createPhaseMonitorHook,
	createPipelineTrackerHook,
	createSystemEnhancerHook,
	createToolSummarizerHook,
	extractCurrentPhase,
	extractCurrentPhaseFromPlan,
	extractCurrentTask,
	extractCurrentTaskFromPlan,
	extractDecisions,
	extractIncompleteTasks,
	extractIncompleteTasksFromPlan,
	extractModelInfo,
	extractPatterns,
	isDuplicateToolRead,
	isStaleError,
	isToolResult,
	MessagePriority,
	type MessagePriorityType,
	NATIVE_MODEL_LIMITS,
	PROVIDER_CAPS,
	readSwarmFileAsync,
	resetSummaryIdCounter,
	resolveModelLimit,
	safeHook,
	validateSwarmPath,
	// Note: estimateTokens excluded to avoid conflict with services/context-budget-service
} from './hooks';

// Export remaining hooks directly from their modules
export { createCoChangeSuggesterHook } from './hooks/co-change-suggester';
export { createDarkMatterDetectorHook } from './hooks/dark-matter-detector';
// Re-export knowledge helpers used by opencode commands
export type { HivePromotionSummary } from './hooks/hive-promoter';
export {
	checkHivePromotions,
	createHivePromoterHook,
	promoteFromSwarm,
	promoteToHive,
} from './hooks/hive-promoter';
export { createKnowledgeCuratorHook } from './hooks/knowledge-curator';
export { createKnowledgeInjectorHook } from './hooks/knowledge-injector';
export type { MigrationResult } from './hooks/knowledge-migrator';
export { migrateContextToKnowledge } from './hooks/knowledge-migrator';
export {
	appendKnowledge,
	appendRejectedLesson,
	computeConfidence,
	findNearDuplicate,
	getPlatformConfigDir,
	inferTags,
	jaccardBigram,
	normalize,
	readKnowledge,
	readRejectedLessons,
	resolveHiveKnowledgePath,
	resolveHiveRejectedPath,
	resolveSwarmKnowledgePath,
	resolveSwarmRejectedPath,
	rewriteKnowledge,
	wordBigrams,
} from './hooks/knowledge-store';
export type {
	HiveKnowledgeEntry,
	KnowledgeCategory,
	KnowledgeEntryBase,
	MessageInfo,
	MessagePart,
	PhaseConfirmationRecord,
	ProjectConfirmationRecord,
	RejectedLesson,
	RetrievalOutcome,
	SwarmKnowledgeEntry,
	// Note: KnowledgeConfig and MessageWithParts excluded to avoid conflicts
} from './hooks/knowledge-types';
export type {
	EntryHealthResult,
	QuarantinedEntry,
	ValidationResult,
} from './hooks/knowledge-validator';
export {
	auditEntryHealth,
	DANGEROUS_COMMAND_PATTERNS,
	INJECTION_PATTERNS,
	quarantineEntry,
	restoreEntry,
	SECURITY_DEGRADING_PATTERNS,
	validateLesson,
} from './hooks/knowledge-validator';
export { createSteeringConsumedHook } from './hooks/steering-consumed';
// Re-export lang module (language detection and profiles) - explicit re-export to disambiguate TestFramework
export {
	type BuildCommand,
	detectProjectLanguages,
	getProfileForFile,
	LANGUAGE_REGISTRY,
	type LanguageProfile,
	LanguageRegistry,
	type LintTool,
	type TestFramework,
} from './lang';
// Re-export plan module
export * from './plan';
export {
	applySafeAutoFixes,
	type ConfigBackup,
	type ConfigDoctorResult,
	type ConfigFinding,
	type ConfigFix,
	createConfigBackup,
	type FindingSeverity,
	getConfigPaths,
	runConfigDoctor,
	runConfigDoctorWithFixes,
	shouldRunOnStartup,
	writeBackupArtifact,
	writeDoctorArtifact,
} from './services/config-doctor';
export {
	type BudgetState,
	type ContextBudgetConfig,
	type ContextBudgetReport,
	DEFAULT_CONTEXT_BUDGET_CONFIG,
	estimateTokens,
	formatBudgetWarning,
	getContextBudgetReport,
	getDefaultConfig,
} from './services/context-budget-service';
// Re-export services module (selective to avoid conflict with hooks estimateTokens)
export {
	analyzeDecisionDrift,
	DEFAULT_DRIFT_CONFIG,
	type Decision,
	type DriftAnalysisResult,
	type DriftAnalyzerConfig,
	type DriftSeverity,
	type DriftSignal,
	extractDecisionsFromContext,
	findContradictions,
	formatDriftForContext,
} from './services/decision-drift-analyzer';
export {
	type DiagnoseData,
	formatDiagnoseMarkdown,
	getDiagnoseData,
	type HealthCheck,
	handleDiagnoseCommand,
} from './services/diagnose-service';
export {
	type EvidenceEntryData,
	type EvidenceListData,
	formatEvidenceListMarkdown,
	formatTaskEvidenceMarkdown,
	getEvidenceListData,
	getTaskEvidenceData,
	getVerdictEmoji,
	handleEvidenceCommand,
	handleEvidenceSummaryCommand,
	type TaskEvidenceData,
} from './services/evidence-service';
export {
	buildEvidenceSummary,
	EVIDENCE_SUMMARY_VERSION,
	type EvidenceSummaryArtifact,
	isAutoSummaryEnabled,
	type PhaseBlocker,
	type PhaseEvidenceSummary,
	REQUIRED_EVIDENCE_TYPES,
	type TaskEvidenceSummary,
} from './services/evidence-summary-service';
export {
	type ExportData,
	formatExportMarkdown,
	getExportData,
	handleExportCommand,
} from './services/export-service';
export {
	type DelegationState,
	formatHandoffMarkdown,
	getHandoffData,
	type HandoffData,
	type PendingQA,
} from './services/handoff-service';
export {
	formatHistoryMarkdown,
	getHistoryData,
	type HistoryData,
	handleHistoryCommand,
	type PhaseHistoryData,
} from './services/history-service';
export {
	formatPlanMarkdown,
	getPlanData,
	handlePlanCommand,
	type PlanData,
} from './services/plan-service';
export {
	createPreflightIntegration,
	type PreflightIntegrationConfig,
	runManualPreflight,
} from './services/preflight-integration';
export {
	formatPreflightMarkdown,
	handlePreflightCommand,
	type PreflightCheckResult,
	type PreflightCheckType,
	type PreflightConfig,
	type PreflightReport,
	runPreflight,
} from './services/preflight-service';
export {
	formatStatusMarkdown,
	getStatusData,
	handleStatusCommand,
	type StatusData,
} from './services/status-service';
// Re-export session snapshot utilities
export * from './session/snapshot-reader';
export * from './session/snapshot-writer';
// Re-export state module
export * from './state';
// Re-export summaries module
export * from './summaries';
// Telemetry writer — EventWriter and getEventWriter for claude-code hook scripts
export { EventWriter, getEventWriter } from './telemetry/writer';
// Re-export tools module
export * from './tools';
// Re-export types
export * from './types/delegation';
export * from './types/events';
// Re-export utils module
export * from './utils';
// Runtime-portability shim for Bun.* primitives (issue #3151) — every direct
// Bun.write/file/spawn/spawnSync/hash call routes through this module so the
// plugin functions under Node hosts.
export * from './utils/bun-compat';
export { truncateToolOutput } from './utils/tool-output';
