/**
 * Independent issue #2487 legacy-source census.
 *
 * This is deliberately separate from both the retention registry and the
 * compatibility rows.  Each entry names production symbols which make the
 * source reachable; the compatibility checker verifies those symbols are
 * still present before comparing the resulting facts with the declarations.
 * A retention `issue2487Legacy` tag is evidence/ownership metadata, never the
 * source of truth for whether a legacy input exists.
 */

export interface Issue2487LegacySourceDefinition {
	id: string;
	retentionId: string;
	path: string;
	sourceFile: string;
	tokens: readonly string[];
}

export const ISSUE_2487_LEGACY_SOURCE_CENSUS: readonly Issue2487LegacySourceDefinition[] = [
	{
		id: 'telemetry-jsonl',
		retentionId: 'telemetry-jsonl',
		path: '.swarm/telemetry.jsonl(.1)',
		sourceFile: 'src/observability/legacy.ts',
		tokens: ['telemetry.jsonl', 'LEGACY_TELEMETRY_SOURCE_STORE'],
	},
	{
		id: 'events-jsonl',
		retentionId: 'events-jsonl',
		path: '.swarm/events.jsonl',
		sourceFile: 'src/events/core-events.ts',
		tokens: ['events.jsonl', 'appendCoreEventSync'],
	},
	{
		id: 'context-telemetry',
		retentionId: 'context-telemetry',
		path: '.swarm/context-telemetry.jsonl',
		sourceFile: 'src/context-map/telemetry.ts',
		tokens: ['context-telemetry.jsonl', 'recordTelemetry'],
	},
	{
		id: 'pr-monitor-subscriptions',
		retentionId: 'pr-monitor-subscriptions',
		path: '.swarm/pr-monitor/subscriptions.jsonl (+ subscriptions.checkpoint.json and subscriptions.legacy.jsonl)',
		sourceFile: 'src/background/pr-subscriptions.ts',
		tokens: ['PR_SUBSCRIPTIONS_FILE', 'PR_SUBSCRIPTIONS_CHECKPOINT_FILE', 'LEGACY_ARCHIVE_FILE', 'importCoordinationOnce'],
	},
	{
		id: 'insight-candidates',
		retentionId: 'insight-candidates',
		path: '.swarm/insight-candidates.jsonl',
		sourceFile: 'src/db/insight-candidate-store.ts',
		tokens: ['INSIGHT_CANDIDATES_LEGACY_FILE', 'ensureInsightLegacyImported'],
	},
	{
		id: 'plan-ledger',
		retentionId: 'plan-ledger',
		path: '.swarm/plan-ledger.jsonl',
		sourceFile: 'src/plan/ledger.ts',
		tokens: ['LEDGER_FILENAME', 'importSqliteLedger'],
	},
	{
		id: 'knowledge-application-legacy',
		retentionId: 'knowledge-application-legacy',
		path: '.swarm/knowledge-application.jsonl',
		sourceFile: 'src/hooks/knowledge-application.ts',
		tokens: ['knowledge-application.jsonl', 'appendAudit'],
	},
	{
		id: 'drift-reports',
		retentionId: 'drift-reports',
		path: '.swarm/drift-report-phase-{N}.json',
		sourceFile: 'src/db/phase-report-store.ts',
		tokens: ['drift-report-phase-', 'curator_drift'],
	},
	{
		id: 'doc-drift-signals',
		retentionId: 'doc-drift-signals',
		path: '.swarm/doc-drift-phase-{N}.json',
		sourceFile: 'src/db/phase-report-store.ts',
		tokens: ['doc-drift-phase-', 'design_doc_drift'],
	},
	{
		id: 'scopes-family',
		retentionId: 'scopes-family',
		path: '.swarm/scopes/{scope-{taskId}.json,binding-*.json,claim-{digest}.json}',
		sourceFile: 'src/scope/scope-persistence.ts',
		tokens: ['SCOPE_BINDING_COORDINATION_IMPORT_SOURCE', 'collectLegacyScopeBindingsForImport', 'binding-', 'claim-'],
	},
	{
		id: 'epic-turbo-state',
		retentionId: 'epic-turbo-state',
		path: '.swarm/epic-state.json + .swarm/turbo-state.json',
		sourceFile: 'src/turbo/epic/state.ts',
		tokens: ['turbo.epic.session', 'turbo.lean.session', 'importLegacyStateIfNeeded', 'importCoordinationOnce'],
	},
	{
		id: 'background-delegations-ledger',
		retentionId: 'background-delegations-ledger',
		path: '.swarm/background-delegations.jsonl (+ checkpoint and manifest)',
		sourceFile: 'src/background/pending-delegations.ts',
		tokens: ['BACKGROUND_DELEGATIONS_FILE', 'loadLegacyLedger', 'ensureDelegationCoordinationImported'],
	},
	{
		id: 'background-delegations-fallback',
		retentionId: 'background-delegations-fallback',
		path: '.swarm/background-delegation-fallback/*.json + background-coder-reservations.json',
		sourceFile: 'src/background/pending-delegations.ts',
		tokens: ['BACKGROUND_DELEGATION_FALLBACK_DIR', 'BACKGROUND_CODER_RESERVATIONS_FILE', 'scanBackgroundCoderReservationsForAdmission', 'readFallbackDirectory'],
	},
	{
		id: 'pr-review-reentry-authorizations',
		retentionId: 'pr-review-reentry-authorizations',
		path: '.swarm/pr-review/reentry-authorizations/{session-stem}.json',
		sourceFile: 'src/pr-review/authorization.ts',
		tokens: ['AUTHORIZATION_COORDINATION_PREFIX', 'reentryAuthorizationFilePath', 'importCoordinationOnce'],
	},
	{
		id: 'pr-review-workflow-gate-state',
		retentionId: 'pr-review-workflow-gate-state',
		path: '.swarm/pr-workflow-gates/{session-stem}.json',
		sourceFile: 'src/pr-review/persistence.ts',
		tokens: ['WORKFLOW_GATE_DIR', 'workflowGateStateRelativePath', 'importLegacyPrWorkflowGateStateIfNeeded', 'importCoordinationOnce'],
	},
	{
		id: 'session-state-snapshot',
		retentionId: 'session-state-snapshot',
		path: '.swarm/session/state.json',
		sourceFile: 'src/session/snapshot-store.ts',
		tokens: ['SNAPSHOT_PROJECTION_SOURCE', 'importSnapshotRowsOnce', 'session/state.json'],
	},
] as const;
