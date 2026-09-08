/**
 * Machine-readable SQLite/legacy compatibility contract for issue #2487.
 *
 * This file is intentionally data-only. The checker derives migration and
 * source-reachability facts independently from the repository and compares
 * them with these rows; citations in this file are descriptive evidence, not
 * the authority for whether a surface exists.
 */

import { RETENTION_REGISTRY } from './retention-registry.data';

export type CompatibilitySurface = 'sqlite-table' | 'legacy-stream';
export type AuthorityState = 'authoritative' | 'operational' | 'derived';
export type Disposition = 'supported' | 'retained-legacy' | 'retired';
export type EvidenceScenario =
	| 'cross-runtime'
	| 'recovery'
	| 'kill-switches'
	| 'archive-restore'
	| 'reachability'
	| 'field-scale';
export type QualificationGroup =
	| 'project-constraints-cross-runtime'
	| 'observability-production-retention'
	| 'schema-migration-open-recovery'
	| 'legacy-import-reachability';

export type AuthorityControl =
	| {
			kind: 'always-on-authority';
			justification: string;
			recoveryOperation: string;
			rollbackOperation: string;
			scenario: EvidenceScenario;
	  }
	| {
			kind: 'production-read-switch';
			name: string;
			enabledEvidence: string;
			disabledEvidence: string;
			scenario: EvidenceScenario;
	  };

export interface CompatibilityRow {
	id: string;
	surface: CompatibilitySurface;
	table?: string;
	legacyPath?: string;
	migrationVersion?: number;
	writers: readonly string[];
	readers: readonly string[];
	authority: AuthorityState;
	rollout: string;
	rollback: string;
	fallback: string;
	archiveRestore: string;
	disposition: Disposition;
	evidenceScenario: EvidenceScenario;
	control: AuthorityControl;
	qualificationGroup: QualificationGroup;
	qualificationRationale: string;
}

/**
 * A runtime representative is a production API exercised under both Bun and
 * Node.  The semantic suites are deliberately separate: they pin the
 * table-specific behavior which is shared by the two SQLite drivers.  This
 * avoids the misleading claim that opening a schema proves every writer.
 */
export interface SqliteEquivalencePartition {
	id: string;
	tables: readonly string[];
	runtimeOperation: string;
	productionApis: readonly string[];
	semanticTests: readonly string[];
}

const alwaysOn = (
	scenario: EvidenceScenario,
	justification: string,
): AuthorityControl => ({
	kind: 'always-on-authority',
	justification: `always-on-authority: ${justification}`,
	recoveryOperation: 'getProjectDb, closeProjectDb, reopen the same project root, and replay/read the canonical rows',
	rollbackOperation: 'archiveSqliteSnapshot, restore the archived database or legacy source, closeProjectDb, and reopen through getProjectDb',
	scenario,
});

const sqlite = (
	id: string,
	table: string,
	migrationVersion: number,
	authority: AuthorityState,
	evidenceScenario: EvidenceScenario,
	writers: readonly string[],
	readers: readonly string[],
	qualificationGroup: QualificationGroup = 'schema-migration-open-recovery',
	qualificationRationale = 'getProjectDb opens and migrates this table as part of the independently checked schema; row-level behavior remains owned by the table-specific API tests.',
): CompatibilityRow => ({
	id,
	surface: 'sqlite-table',
	table,
	migrationVersion,
	writers,
	readers,
	authority,
	rollout: 'SQLite table is opened through the canonical project database after migrations complete',
	rollback: 'Restore the WAL-consistent swarm.db archive and reopen through getProjectDb',
	fallback: 'Recovery preserves the legacy/export source where the owning store has one; no silent unregistered store is permitted',
	archiveRestore: 'closeProjectDb before archive; restore swarm.db; reopen and compare canonical evidence',
	disposition: 'supported',
	evidenceScenario,
	control: alwaysOn(evidenceScenario, 'The production API has no independent read switch for this durable table; recovery is explicit and tested.'),
	qualificationGroup,
	qualificationRationale,
});

export const SQLITE_COMPATIBILITY_ROWS: readonly CompatibilityRow[] = [
	sqlite('project-constraints', 'project_constraints', 1, 'authoritative', 'recovery', ['src/db/project-db.ts'], ['src/db/project-db.ts'], 'project-constraints-cross-runtime', 'Bun writes and Node reads a durable project constraint while the complete migrated table catalog is compared.'),
	sqlite('qa-gate-profile', 'qa_gate_profile', 2, 'authoritative', 'recovery', ['src/db/qa-gate-profile.ts'], ['src/db/qa-gate-profile.ts']),
	sqlite('qa-gate-profile-identity', 'qa_gate_profile_identity', 8, 'authoritative', 'recovery', ['src/db/qa-gate-profile.ts'], ['src/db/qa-gate-profile.ts']),
	sqlite('task-checkpoint-receipt', 'task_checkpoint_receipt', 11, 'authoritative', 'recovery', ['src/db/task-checkpoint-receipt.ts'], ['src/db/task-checkpoint-receipt.ts']),
	sqlite('migration-failures', 'migration_failures', 14, 'operational', 'recovery', ['src/db/project-db.ts'], ['src/db/project-db.ts']),
	sqlite('insight-candidate', 'insight_candidate', 15, 'operational', 'cross-runtime', ['src/db/insight-candidate-store.ts'], ['src/db/insight-candidate-store.ts'], 'legacy-import-reachability', 'The production legacy import path creates this table and the reachability group checks its source symbols.'),
	sqlite('phase-report', 'phase_report', 17, 'derived', 'archive-restore', ['src/db/phase-report-store.ts'], ['src/db/phase-report-store.ts'], 'legacy-import-reachability', 'The production legacy phase-report import path creates this table and the reachability group checks its source symbols.'),
	sqlite('coordination-event', 'coordination_event', 18, 'authoritative', 'cross-runtime', ['src/db/coordination-store.ts'], ['src/db/coordination-store.ts']),
	sqlite('coordination-state', 'coordination_state', 20, 'authoritative', 'cross-runtime', ['src/db/coordination-store.ts'], ['src/db/coordination-store.ts']),
	sqlite('coordination-lease', 'coordination_lease', 22, 'authoritative', 'recovery', ['src/db/coordination-store.ts'], ['src/db/coordination-store.ts']),
	sqlite('coordination-import', 'coordination_import', 24, 'operational', 'reachability', ['src/db/coordination-store.ts'], ['src/db/coordination-store.ts']),
	sqlite('coordination-event-fence', 'coordination_event_fence', 26, 'authoritative', 'kill-switches', ['src/db/coordination-store.ts'], ['src/db/coordination-store.ts']),
	sqlite('observability-event', 'observability_event', 29, 'operational', 'cross-runtime', ['src/db/observability-event-store.ts'], ['src/db/observability-event-store.ts', 'src/commands/report.ts'], 'observability-production-retention', 'The production telemetry listener, retention, and report query paths exercise identity, payload, ordering, relationships, and survivor fields.'),
	sqlite('observability-sink-health', 'observability_sink_health', 31, 'operational', 'kill-switches', ['src/db/observability-event-store.ts'], ['src/db/observability-event-store.ts', 'src/commands/report.ts'], 'observability-production-retention', 'The production telemetry listener persists bounded accepted/error health alongside the retention soak.'),
	sqlite('observability-import', 'observability_import', 32, 'operational', 'reachability', ['src/db/observability-event-store.ts'], ['src/db/observability-event-store.ts'], 'observability-production-retention', 'The production legacy telemetry import records its source fingerprint and report join evidence.'),
	sqlite('plan-ledger-event', 'plan_ledger_event', 33, 'authoritative', 'cross-runtime', ['src/plan/ledger-sqlite.ts'], ['src/plan/ledger-sqlite.ts'], 'schema-migration-open-recovery', 'The open/recovery group qualifies migration and retry integrity; plan-ledger row semantics remain covered by its table-specific API tests.'),
	sqlite('plan-ledger-state', 'plan_ledger_state', 34, 'authoritative', 'recovery', ['src/plan/ledger-sqlite.ts'], ['src/plan/ledger-sqlite.ts'], 'schema-migration-open-recovery', 'The open/recovery group qualifies migration and retry integrity; plan-ledger row semantics remain covered by its table-specific API tests.'),
	sqlite('plan-ledger-import', 'plan_ledger_import', 35, 'operational', 'archive-restore', ['src/plan/ledger-sqlite.ts'], ['src/plan/ledger-sqlite.ts'], 'schema-migration-open-recovery', 'The migration rollback fixture deliberately fails and retries the v37 index over this table.'),
];

const legacy = (
	id: string,
	path: string,
	evidenceScenario: EvidenceScenario,
	readers: readonly string[],
	writers: readonly string[],
): CompatibilityRow => ({
	id,
	surface: 'legacy-stream',
	legacyPath: path,
	writers,
	readers,
	authority: 'operational',
	rollout: 'Retained as an explicit compatibility or recovery input; SQLite authority remains separately qualified',
	rollback: 'Restore the named legacy artifact and rerun its production import/recovery path',
	fallback: 'Legacy input is bounded and visible in health/report evidence; it is never an implicit authority promotion',
	archiveRestore: 'Archive or restore the named artifact through the close/recovery path before retrying import',
	disposition: 'retained-legacy',
	evidenceScenario,
	control: alwaysOn(evidenceScenario, 'Legacy compatibility remains reachable by design until its owning migration has a measured retirement proof.'),
	qualificationGroup: 'legacy-import-reachability',
	qualificationRationale: 'The exact code-defined legacy source is exercised through its production import/recovery path or retained as an explicit archive input.',
});

/** The retention registry is the authoritative legacy-universe declaration. */
export const LEGACY_COMPATIBILITY_ROWS: readonly CompatibilityRow[] = RETENTION_REGISTRY
	.filter((row) => row.issue2487Legacy !== undefined)
	.map((row) => {
		const source = row.issue2487Legacy!;
		return legacy(
			row.id,
			source.path,
			'reachability',
			source.readers,
			source.writers,
		);
	});

export const ISSUE_2487_COMPATIBILITY_ROWS: readonly CompatibilityRow[] = [
	...SQLITE_COMPATIBILITY_ROWS,
	...LEGACY_COMPATIBILITY_ROWS,
];

/**
 * Complete, non-overlapping table partition for the qualification runner.
 * `repro:2487` executes each representative via the shipped API bundle under
 * both drivers, closes and reopens between them, then runs the listed focused
 * semantic tests in isolated Bun processes.  A table cannot be added to the
 * migration catalog without appearing here because the compatibility checker
 * compares this set to the independently parsed schema.
 */
export const SQLITE_EQUIVALENCE_PARTITIONS: readonly SqliteEquivalencePartition[] = [
	{
		id: 'project-schema',
		tables: ['project_constraints', 'migration_failures'],
		runtimeOperation: 'project-schema',
		productionApis: ['getProjectDb', 'closeProjectDb', 'runProjectMigrations'],
		semanticTests: ['tests/unit/db/project-db-hardening.test.ts', 'tests/unit/db/project-db-compatibility-2487.test.ts'],
	},
	{
		id: 'qa-profile',
		tables: ['qa_gate_profile', 'qa_gate_profile_identity'],
		runtimeOperation: 'qa-profile',
		productionApis: ['getOrCreateProfile', 'getProfile'],
		semanticTests: ['tests/unit/tools/get-qa-gate-profile.test.ts'],
	},
	{
		id: 'checkpoint-receipt',
		tables: ['task_checkpoint_receipt'],
		runtimeOperation: 'checkpoint-receipt',
		productionApis: ['ensureTaskCheckpointReceipt', 'readTaskCheckpointReceipt'],
		semanticTests: ['tests/unit/db/durability.test.ts'],
	},
	{
		id: 'legacy-imports',
		tables: ['insight_candidate', 'phase_report'],
		runtimeOperation: 'legacy-imports',
		productionApis: ['appendInsightCandidatesDb', 'consumeInsightCandidatesDb', 'upsertPhaseReportDb', 'readPhaseReportsDb'],
		semanticTests: ['tests/unit/db/insight-candidate-store.test.ts', 'tests/unit/db/phase-report-store.test.ts'],
	},
	{
		id: 'coordination',
		tables: ['coordination_event', 'coordination_state', 'coordination_lease', 'coordination_import', 'coordination_event_fence'],
		runtimeOperation: 'coordination',
		productionApis: ['transitionCoordinationState', 'acquireCoordinationLease', 'importCoordinationOnce'],
		semanticTests: ['tests/unit/db/coordination-store-2487.test.ts'],
	},
	{
		id: 'observability',
		tables: ['observability_event', 'observability_sink_health', 'observability_import'],
		runtimeOperation: 'observability',
		productionApis: ['emit', 'registerObservabilityEventSink', 'queryObservabilityEvents', 'syncObservabilityImport'],
		semanticTests: ['tests/unit/db/observability-event-store.test.ts', 'tests/unit/db/observability-dedup-parity-2487.test.ts', 'tests/unit/db/observability-listener-fail-open-2487.test.ts'],
	},
	{
		id: 'plan-ledger',
		tables: ['plan_ledger_event', 'plan_ledger_state', 'plan_ledger_import'],
		runtimeOperation: 'plan-ledger',
		productionApis: ['importSqliteLedger', 'appendSqliteLedger', 'readSqliteLedgerEvents'],
		semanticTests: ['tests/unit/plan/ledger-sqlite-store.test.ts'],
	},
];

export const COMPATIBILITY_SCHEMA_VERSION = 1;
export const SUPPORTED_PROJECT_SCHEMA_VERSION = 37;
