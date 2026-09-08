/**
 * Production API barrel for the issue #2487 qualification harness.
 *
 * This file is bundled only into gitignored Bun/Node fixtures. It exposes the
 * shipped DB, archive, telemetry, and observability entry points without
 * changing the plugin manifest or adding a runtime export.
 */
export {
	closeProjectDb,
	getProjectDb,
	getOpenProjectDbCount,
	runProjectMigrations,
	withProjectDbReadOnly,
} from '../src/db/project-db.js';
export { archiveSqliteSnapshot } from '../src/commands/archive-sqlite.js';
export { loadDatabaseCtor } from '../src/db/sqlite-loader.js';
export {
	MAX_OBSERVABILITY_EVENT_ROWS,
	RETENTION_CHECK_INTERVAL,
	registerObservabilityEventSink,
	resetObservabilityEventSinkForTesting,
	queryObservabilityEvents,
	readObservabilityCoverage,
	readObservabilitySinkHealth,
	syncObservabilityImport,
} from '../src/db/observability-event-store.js';
export {
	emit,
	flushAndDrainTelemetry,
	initTelemetry,
	resetTelemetryForTesting,
	telemetry,
} from '../src/telemetry.js';
export { readTelemetryEvents, summarizeTelemetryCosts } from '../src/services/cost-accounting.js';
export { handleCostsCommand } from '../src/commands/costs.js';
export { handleReportCommand } from '../src/commands/report.js';
export { getOrCreateProfile, getProfile } from '../src/db/qa-gate-profile.js';
export {
	ensureTaskCheckpointReceipt,
	readTaskCheckpointReceipt,
} from '../src/db/task-checkpoint-receipt.js';
export {
	appendInsightCandidatesDb,
	consumeInsightCandidatesDb,
	countPendingInsightCandidatesDb,
} from '../src/db/insight-candidate-store.js';
export {
	readPhaseReportsDb,
	upsertPhaseReportDb,
} from '../src/db/phase-report-store.js';
export {
	acquireCoordinationLease,
	getCoordinationLease,
	getCoordinationState,
	importCoordinationOnce,
	transitionCoordinationState,
} from '../src/db/coordination-store.js';
export {
	appendSqliteLedger,
	importSqliteLedger,
	readSqliteLedgerEvents,
} from '../src/plan/ledger-sqlite.js';
