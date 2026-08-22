export type { MemoryConfig } from './config';
export { DEFAULT_MEMORY_CONFIG, resolveMemoryConfig } from './config';
export { MemoryDisabledError, MemoryValidationError } from './errors';
export {
	evaluateMemoryRecallFixtures,
	loadRecallEvaluationFixtures,
	type RecallEvaluationMetrics,
	type RecallEvaluationMode,
	type RecallEvaluationOptions,
	type RecallEvaluationProviderName,
	type RecallEvaluationReport,
	type RecallEvaluationRun,
} from './evaluation';
export type {
	MemoryGatewayOptions,
	ProposeMemoryInput,
	RecallMemoryInput,
	RecordMemoryOutcomeInput,
} from './gateway';
export {
	createConfiguredMemoryProvider,
	createConfiguredMemoryProviderForRoot,
	createMemoryGateway,
	MemoryGateway,
} from './gateway';
export {
	createMemoryLifecycleHooks,
	type MemoryLifecycleHookOptions,
	type MemoryLifecycleHooks,
} from './injector';
export {
	backupLegacyJsonl,
	getLegacyJsonlFileStatus,
	getLegacyOutcomeJsonlSignature,
	type JsonlBackupResult,
	type JsonlImportPayload,
	type JsonlInvalidRow,
	type JsonlMigrationReport,
	LEGACY_JSONL_MIGRATION_NAME,
	LEGACY_JSONL_MIGRATION_VERSION,
	LEGACY_JSONL_OUTCOME_META_KEY,
	readLegacyJsonl,
	readMigrationReport,
	resolveMemoryStorageDir,
	resolveSqliteDatabasePath,
	writeJsonlExport,
	writeMigrationReport,
} from './jsonl-migration';
export { LocalJsonlMemoryProvider } from './local-jsonl-provider';
export {
	buildMemoryMaintenanceReport,
	type MemoryMaintenanceReport,
	type MemoryMaintenanceReportOptions,
	type MemoryRecallUsageByMemory,
	type MemoryRecallUsageByRole,
	type MemorySupersededChain,
	shouldCompactMemory,
} from './maintenance';
// #1850 Linked Knowledge 5/5: cohort memory sharing.
export {
	invalidateMemoryStoreDirCache,
	isMemoryLinked,
	MEMORY_LINK_POINTER_FILENAME,
	type MemoryLinkPointer,
	readMemoryLinkPointer,
	removeMemoryLinkPointer,
	resolveMemoryStoreDir,
	writeMemoryLinkPointer,
} from './memory-link';
export type { MemoryOutcomeEvent } from './outcome-events';
export { buildRecallPromptBlock } from './prompt-block';
export type {
	MemoryCompactOptions,
	MemoryCompactResult,
	MemoryProposalStore,
	MemoryProvider,
	MemoryRecallUsageEvent,
	MemoryRecallUsageFilter,
} from './provider';
export {
	buildMemoryRecallPlan,
	type MemoryRecallPlan,
	type MemoryRecallPlannerInput,
} from './recall-planner';
export {
	buildMemoryCohortFingerprintInput,
	computeMemoryCohortFingerprint,
	computeRedactionPolicyVersion,
	FINGERPRINT_ALGORITHM_VERSION,
	findSecrets,
	redactSecrets,
} from './redaction';
export {
	readDeadAnchorMemoryIds,
	readReflectionDigest,
	recordOutcomeWithReflection,
	regenerateMemoryReflection,
} from './reflection-service';
export {
	MEMORY_RECALL_PROFILES,
	type MemoryRecallProfile,
	normalizeMemoryAgentRole,
	resolveMemoryRecallProfile,
} from './role-profiles';
export { appendMemoryRunLog, sanitizeRunId } from './run-log';
export {
	computeMemoryContentHash,
	createBundleId,
	createMemoryId,
	createProposalId,
	isExpired,
	MemoryAnchorSchema,
	normalizeMemoryAnchorFile,
	normalizeMemoryText,
	validateCuratorMemoryDecision,
	validateMemoryProposal,
	validateMemoryRecordRules,
} from './schema';
export { SQLiteMemoryProvider } from './sqlite-provider';
export {
	isCohortRoot,
	isLocalRoot,
	resolveVettedMemoryRoot,
	rootStoragePath,
	type VettedMemoryRoot,
	wrapLocalRoot,
} from './storage-root';
export type {
	AppliedMemoryChange,
	CuratorMemoryDecision,
	MemoryAnchor,
	MemoryContext,
	MemoryKind,
	MemoryListFilter,
	MemoryOutcome,
	MemoryPatch,
	MemoryProposal,
	MemoryRecord,
	MemoryScopeRef,
	MemoryScopeType,
	NewMemoryRecord,
	RecallBundle,
	RecallInjectionSkipReason,
	RecallMode,
	RecallRequest,
	RecallResultItem,
	ResolvedCuratorMemoryDecision,
} from './types';
