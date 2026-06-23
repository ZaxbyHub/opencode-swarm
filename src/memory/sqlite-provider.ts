import type { Database, SQLQueryBindings } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { validateSwarmPath } from '../hooks/utils';
import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from './config';
import {
	applyPatchToMemory,
	buildCuratorDecisionEvent,
	curatorDecisionReason,
	markProposalReviewed,
	validateCuratorPromotableMemory,
	validateDecisionMatchesProposal,
} from './curator-decision-helpers';
import { MemoryValidationError } from './errors';
import {
	backupLegacyJsonl,
	type JsonlMigrationReport,
	LEGACY_JSONL_MIGRATION_NAME,
	LEGACY_JSONL_MIGRATION_VERSION,
	readLegacyJsonl,
	writeJsonlExport,
	writeMigrationReport,
} from './jsonl-migration';
import { shouldCompactMemory } from './maintenance';
import type {
	MemoryCompactOptions,
	MemoryCompactResult,
	MemoryProposalStore,
	MemoryProvider,
	MemoryRecallUsageEvent,
	MemoryRecallUsageFilter,
} from './provider';
import {
	stableScopeKey,
	validateMemoryProposal,
	validateMemoryRecordRules,
} from './schema';
import type { RecallScoringDiagnostics } from './scoring';
import { scoreMemoryRecordsWithDiagnostics } from './scoring';
import type {
	AppliedMemoryChange,
	MemoryListFilter,
	MemoryProposal,
	MemoryRecord,
	MemoryScopeRef,
	RecallRequest,
	RecallResultItem,
	ResolvedCuratorMemoryDecision,
} from './types';

// See src/db/project-db.ts for the portability rationale. The main plugin bundle
// is Node-ESM-loadable, so the Bun SQLite driver must be resolved only when the
// SQLite memory provider is selected and initialized.
let _DatabaseCtor: typeof Database | null = null;
function loadDatabaseCtor(): typeof Database {
	if (_DatabaseCtor) return _DatabaseCtor;
	const req = createRequire(import.meta.url);
	_DatabaseCtor = (req('bun:sqlite') as { Database: typeof Database }).Database;
	return _DatabaseCtor;
}

type EventOperation =
	| 'upsert'
	| 'delete'
	| 'proposal'
	| 'recall'
	| 'migration'
	| 'compact'
	| 'compact_triggered'
	| 'curator_decision'
	| 'invalid_load';

interface Migration {
	version: number;
	name: string;
	sql: string;
}

// FTS shadow table migration. Version 3 is used because version 2 is
// already occupied by LEGACY_JSONL_MIGRATION_VERSION (legacy JSONL import
// marker — see src/memory/jsonl-migration.ts:9). schema_migrations.version
// is INTEGER PRIMARY KEY, so two migrations cannot share a version number.
// Stale schema_migrations rows with version=3 from prior inits (when this
// was an out-of-band marker stamped by initializeFtsIndex) are TOLERATED
// WITHOUT CLEANUP — they happen to align with the new in-array version 3,
// so runMigrations sees MAX(version) >= 3 and skips re-applying. The
// hasMigration(FTS_SCHEMA_MIGRATION_NAME) name-guard plus CREATE VIRTUAL
// TABLE IF NOT EXISTS in the else branch make this safe.
const RECALL_CANDIDATE_LIMIT = 1000;
const FTS_SCHEMA_MIGRATION_VERSION = 3;
const FTS_SCHEMA_MIGRATION_NAME = 'create_memory_fts5_shadow_index';
const FTS_TABLE_NAME = 'memory_items_fts';
const FTS_INDEX_COLUMNS = [
	{
		name: 'text',
		value: (record: MemoryRecord) => record.text,
	},
	{
		name: 'tags',
		value: (record: MemoryRecord) => record.tags.join(' '),
	},
	{
		name: 'kind',
		value: (record: MemoryRecord) => record.kind.replace(/_/g, ' '),
	},
	{
		name: 'source_file_path',
		value: (record: MemoryRecord) => record.source.filePath ?? '',
	},
	{
		name: 'source_ref',
		value: (record: MemoryRecord) => record.source.ref ?? '',
	},
	{
		name: 'metadata_symbols',
		value: (record: MemoryRecord) =>
			collectMetadataSearchStrings(record.metadata, ['symbol', 'symbols']).join(
				' ',
			),
	},
	{
		name: 'metadata_files',
		value: (record: MemoryRecord) =>
			collectMetadataSearchStrings(record.metadata, [
				'file',
				'filePath',
				'files',
				'touchedFiles',
			]).join(' '),
	},
] as const;
const FTS_INSERT_COLUMNS = [
	'id',
	...FTS_INDEX_COLUMNS.map((column) => column.name),
];

export const MIGRATIONS: Migration[] = [
	{
		version: 1,
		name: 'create_memory_provider_tables',
		sql: `
			CREATE TABLE IF NOT EXISTS memory_items (
				id TEXT PRIMARY KEY,
				scope_key TEXT NOT NULL,
				kind TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				expires_at TEXT,
				superseded_by TEXT,
				deleted INTEGER NOT NULL DEFAULT 0,
				record_json TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_memory_items_scope_kind
				ON memory_items(scope_key, kind);
			CREATE INDEX IF NOT EXISTS idx_memory_items_updated_at
				ON memory_items(updated_at);

			CREATE TABLE IF NOT EXISTS memory_proposals (
				id TEXT PRIMARY KEY,
				status TEXT NOT NULL,
				created_at TEXT NOT NULL,
				proposal_json TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_memory_proposals_status_created
				ON memory_proposals(status, created_at);

			CREATE TABLE IF NOT EXISTS memory_events (
				id TEXT PRIMARY KEY,
				operation TEXT NOT NULL,
				target_id TEXT NOT NULL,
				reason TEXT,
				timestamp TEXT NOT NULL,
				event_json TEXT
			);

			CREATE TABLE IF NOT EXISTS memory_recall_usage (
				id TEXT PRIMARY KEY,
				bundle_id TEXT NOT NULL,
				timestamp TEXT NOT NULL,
				usage_json TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_memory_recall_usage_bundle
				ON memory_recall_usage(bundle_id);
		`,
	},
	{
		version: 3,
		name: 'create_memory_fts5_shadow_index',
		sql: `
			CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE_NAME} USING fts5(
				${ftsCreateColumnsSql()}
			);
		`,
	},
	{
		version: 4,
		name: 'create_meta_table',
		sql: `
			CREATE TABLE IF NOT EXISTS _meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
		`,
	},
	{
		version: 5,
		name: 'create_recall_usage_timestamp_index',
		sql: `
			CREATE INDEX IF NOT EXISTS idx_memory_recall_usage_timestamp
				ON memory_recall_usage(timestamp DESC);
		`,
	},
];

interface MemoryItemRow {
	id: string;
	record_json: string;
}

interface FtsCandidateRow {
	id: string;
	rank: number;
}

interface ProposalRow {
	id: string;
	proposal_json: string;
}

interface RecallUsageRow {
	usage_json: string;
}

interface DecisionTransactionResult {
	change: AppliedMemoryChange;
	proposal: MemoryProposal;
	memories: MemoryRecord[];
	removeMemoryIds: string[];
}

interface MigrationRow {
	version: number;
	name: string;
}

export interface SQLiteJsonlImportResult {
	importedMemories: number;
	importedProposals: number;
	invalidRows: JsonlMigrationReport['invalidRows'];
	totalRows: number;
}

export class SQLiteMemoryProvider
	implements MemoryProvider, MemoryProposalStore
{
	readonly name = 'sqlite';
	private readonly rootDirectory: string;
	private readonly config: MemoryConfig;
	private initialized = false;
	private initPromise: Promise<void> | null = null;
	private db: Database | null = null;
	private ftsAvailable = false;
	private memories = new Map<string, MemoryRecord>();
	private proposals = new Map<string, MemoryProposal>();
	private lastAutomaticJsonlMigration: SQLiteJsonlImportResult | null = null;
	private recallCountSinceLastCompaction = 0;

	constructor(rootDirectory: string, config: Partial<MemoryConfig> = {}) {
		this.rootDirectory = rootDirectory;
		this.config = {
			...DEFAULT_MEMORY_CONFIG,
			...config,
			sqlite: {
				...DEFAULT_MEMORY_CONFIG.sqlite,
				...(config.sqlite ?? {}),
			},
			recall: {
				...DEFAULT_MEMORY_CONFIG.recall,
				...(config.recall ?? {}),
				injection: {
					...DEFAULT_MEMORY_CONFIG.recall.injection,
					...(config.recall?.injection ?? {}),
				},
			},
			writes: {
				...DEFAULT_MEMORY_CONFIG.writes,
				...(config.writes ?? {}),
			},
			redaction: {
				...DEFAULT_MEMORY_CONFIG.redaction,
				...(config.redaction ?? {}),
			},
			maintenance: {
				...DEFAULT_MEMORY_CONFIG.maintenance,
				...(config.maintenance ?? {}),
			},
		};
	}

	private databasePath(): string {
		const relativePath = this.config.sqlite.path.replace(/^\.swarm[/\\]?/, '');
		return validateSwarmPath(this.rootDirectory, relativePath);
	}

	async initialize(): Promise<void> {
		if (this.initialized) return;
		if (!this.initPromise) {
			this.initPromise = this.doInitialize().catch((err) => {
				this.initPromise = null;
				throw err;
			});
		}
		return this.initPromise;
	}

	private async doInitialize(): Promise<void> {
		const dbPath = this.databasePath();
		mkdirSync(path.dirname(dbPath), { recursive: true });
		const Db = loadDatabaseCtor();
		this.db = new Db(dbPath);
		this.db.run('PRAGMA journal_mode = WAL;');
		this.db.run('PRAGMA synchronous = NORMAL;');
		const busyTimeoutMs = Math.min(
			60000,
			Math.max(0, Math.trunc(this.config.sqlite.busyTimeoutMs)),
		);
		this.db.run(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
		this.db.run('PRAGMA foreign_keys = ON;');
		this.runMigrations();
		this.backfillScopeKeys();
		this.ftsAvailable = this.initializeFtsIndex();
		this.lastAutomaticJsonlMigration = null;
		await this.migrateLegacyJsonlIfNeeded();
		const memoryLoad = this.loadMemories();
		const proposalLoad = this.loadProposals();
		this.memories = new Map(
			memoryLoad.records.map((record) => [record.id, record]),
		);
		this.proposals = new Map(
			proposalLoad.records.map((proposal) => [proposal.id, proposal]),
		);
		this.initialized = true;
		if (memoryLoad.invalidCount > 0) {
			await this.event(
				'invalid_load',
				'memory_items',
				`${memoryLoad.invalidCount} invalid SQLite memory row(s) skipped`,
			);
		}
		if (proposalLoad.invalidCount > 0) {
			await this.event(
				'invalid_load',
				'memory_proposals',
				`${proposalLoad.invalidCount} invalid SQLite proposal row(s) skipped`,
			);
		}
	}

	async upsert(record: MemoryRecord): Promise<MemoryRecord> {
		await this.initialize();
		const existing = this.memories.get(record.id);
		if (existing?.metadata.deleted === true) {
			throw new MemoryValidationError(
				'memory is tombstoned and cannot be upserted',
			);
		}
		const next = validateMemoryRecordRules(
			{
				...record,
				createdAt: existing?.createdAt ?? record.createdAt,
			},
			{ rejectDurableSecrets: this.config.redaction.rejectDurableSecrets },
		);
		this.memories.set(next.id, next);
		this.writeMemory(next);
		await this.event('upsert', next.id);
		return next;
	}

	async get(id: string): Promise<MemoryRecord | null> {
		await this.initialize();
		return this.memories.get(id) ?? null;
	}

	async delete(id: string, reason?: string): Promise<void> {
		await this.initialize();
		const existing = this.memories.get(id);
		if (!existing) return;
		if (this.config.hardDelete) {
			this.memories.delete(id);
			this.requireDb().run('DELETE FROM memory_items WHERE id = ?', [id]);
			this.deleteMemoryFts(id);
		} else {
			const tombstone: MemoryRecord = {
				...existing,
				updatedAt: new Date().toISOString(),
				metadata: { ...existing.metadata, deleted: true, deleteReason: reason },
			};
			this.memories.set(id, tombstone);
			this.writeMemory(tombstone);
		}
		await this.event('delete', id, reason);
	}

	async recall(request: RecallRequest): Promise<RecallResultItem[]> {
		return (await this.recallWithDiagnostics(request)).items;
	}

	async recallWithDiagnostics(request: RecallRequest): Promise<{
		items: RecallResultItem[];
		diagnostics: RecallScoringDiagnostics;
	}> {
		await this.initialize();
		const scopedRecords = await this.list({
			scopes: request.scopes,
			kinds: request.kinds,
			includeExpired: request.includeExpired,
			limit: RECALL_CANDIDATE_LIMIT,
		});
		const candidates = this.selectRecallCandidates(request, scopedRecords);
		const result = scoreMemoryRecordsWithDiagnostics(
			candidates.records,
			request,
		);
		const reranked = candidates.ftsOrder
			? rerankWithFts(result.items, candidates.ftsOrder)
			: result.items;
		return {
			items: reranked.slice(0, request.maxItems),
			diagnostics: {
				...result.diagnostics,
				returnedCount: Math.min(reranked.length, request.maxItems),
			},
		};
	}

	async recordRecallUsage(event: MemoryRecallUsageEvent): Promise<void> {
		await this.initialize();
		this.requireDb().run(
			`INSERT INTO memory_recall_usage (
				id,
				bundle_id,
				timestamp,
				usage_json
			) VALUES (?, ?, ?, ?)`,
			[randomUUID(), event.bundleId, event.timestamp, JSON.stringify(event)],
		);
		this.recallCountSinceLastCompaction++;
		const threshold = this.config.maintenance?.autoCompactEveryNRecalls ?? 50;
		if (threshold > 0 && this.recallCountSinceLastCompaction >= threshold) {
			this.recallCountSinceLastCompaction = 0;
			void this.compactMaintenance({ dryRun: false })
				.then((result) => {
					const rowsInspected =
						result.remaining +
						result.removedDeleted +
						result.removedSuperseded +
						result.removedExpiredScratch;
					const rowsPurged =
						result.removedDeleted +
						result.removedSuperseded +
						result.removedExpiredScratch;
					return this.insertEvent(
						'compact_triggered',
						'memory_items',
						'auto compaction triggered',
						JSON.stringify({
							trigger: 'auto',
							threshold,
							rowsInspected,
							rowsPurged,
							timestamp: new Date().toISOString(),
						}),
					);
				})
				.catch((err) => {
					if (process.env.OPENCODE_SWARM_DEBUG === '1') {
						console.debug(`[memory] auto-compaction failed: ${err}`);
					}
				});
		}
	}

	async listRecallUsage(
		filter: MemoryRecallUsageFilter = {},
	): Promise<MemoryRecallUsageEvent[]> {
		await this.initialize();
		const rows =
			typeof filter.limit === 'number'
				? this.requireDb()
						.query<RecallUsageRow, [number]>(
							`SELECT usage_json
				FROM memory_recall_usage
				ORDER BY timestamp DESC
				LIMIT ?`,
						)
						.all(Math.max(1, Math.trunc(filter.limit)))
				: this.requireDb()
						.query<RecallUsageRow, []>(
							`SELECT usage_json
				FROM memory_recall_usage
				ORDER BY timestamp DESC
				`,
						)
						.all();
		const events: MemoryRecallUsageEvent[] = [];
		for (const row of rows) {
			try {
				const parsed = JSON.parse(row.usage_json) as MemoryRecallUsageEvent;
				if (
					Array.isArray(parsed.memoryIds) &&
					typeof parsed.query === 'string'
				) {
					events.push(parsed);
				}
			} catch {
				// Ignore corrupt recall usage rows; maintenance reports are advisory.
			}
		}
		return events;
	}

	async list(filter: MemoryListFilter = {}): Promise<MemoryRecord[]> {
		await this.initialize();
		const db = this.requireDb();

		const conditions: string[] = [];
		const params: SQLQueryBindings[] = [];

		if (filter.scopes && filter.scopes.length > 0) {
			const scopeKeys = filter.scopes.map((scope) => stableScopeKey(scope));
			const placeholders = scopeKeys.map(() => '?').join(', ');
			conditions.push(`scope_key IN (${placeholders})`);
			params.push(...scopeKeys);
		}

		if (filter.kinds && filter.kinds.length > 0) {
			if (filter.kinds.length === 1) {
				conditions.push('kind = ?');
				params.push(filter.kinds[0]);
			} else {
				const placeholders = filter.kinds.map(() => '?').join(', ');
				conditions.push(`kind IN (${placeholders})`);
				params.push(...filter.kinds);
			}
		}

		if (!filter.includeInactive) {
			conditions.push('superseded_by IS NULL');
			conditions.push('deleted = 0');
		}

		if (!filter.includeExpired) {
			const nowIso = new Date().toISOString();
			conditions.push('(expires_at IS NULL OR expires_at > ?)');
			params.push(nowIso);
		}

		const whereClause =
			conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

		let sql = `SELECT id, record_json FROM memory_items ${whereClause} ORDER BY updated_at DESC`;

		if (typeof filter.limit === 'number') {
			sql += ' LIMIT ?';
			params.push(Math.trunc(filter.limit));
		}

		const rows = db
			.query<MemoryItemRow, SQLQueryBindings[]>(sql)
			.all(...params);

		let records: MemoryRecord[] = [];
		for (const row of rows) {
			const parsed = this.parseMemoryRow(row);
			if (parsed) records.push(parsed);
		}

		// Post-filter: preserve the original includeExpired semantics for
		// non-finite expiresAt values that SQL date comparison may exclude.
		if (!filter.includeExpired) {
			const now = Date.now();
			records = records.filter((record) => {
				if (!record.expiresAt) return true;
				const expires = Date.parse(record.expiresAt);
				return !Number.isFinite(expires) || expires > now;
			});
		}

		return records;
	}

	async createProposal(proposal: MemoryProposal): Promise<MemoryProposal> {
		await this.initialize();
		const next = validateMemoryProposal(proposal);
		if (next.proposedRecord) {
			validateMemoryRecordRules(next.proposedRecord, {
				rejectDurableSecrets: this.config.redaction.rejectDurableSecrets,
			});
		}
		this.proposals.set(next.id, next);
		this.writeProposal(next);
		await this.event('proposal', next.id);
		return next;
	}

	async listProposals(
		filter: { status?: MemoryProposal['status']; limit?: number } = {},
	): Promise<MemoryProposal[]> {
		await this.initialize();
		let proposals = Array.from(this.proposals.values());
		if (filter.status) {
			proposals = proposals.filter(
				(proposal) => proposal.status === filter.status,
			);
		}
		proposals.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		return proposals.slice(0, filter.limit ?? proposals.length);
	}

	async applyCuratorDecision(
		decision: ResolvedCuratorMemoryDecision,
	): Promise<AppliedMemoryChange> {
		await this.initialize();
		const db = this.requireDb();
		const apply = db.transaction((): DecisionTransactionResult => {
			const appliedAt = new Date().toISOString();
			const proposal = this.readPendingProposal(decision.proposalId);
			validateDecisionMatchesProposal(decision, proposal);
			const result = this.applyDecisionToStorage(decision, proposal, appliedAt);
			this.writeProposal(result.proposal);
			const eventId = randomUUID();
			const eventJson = JSON.stringify(
				buildCuratorDecisionEvent(result.change, proposal),
			);
			this.insertEvent(
				'curator_decision',
				decision.proposalId,
				result.change.reason,
				eventJson,
				eventId,
			);
			return {
				...result,
				change: { ...result.change, eventId },
			};
		});
		const result = apply();
		this.proposals.set(result.proposal.id, result.proposal);
		for (const id of result.removeMemoryIds) {
			this.memories.delete(id);
		}
		for (const memory of result.memories) {
			this.memories.set(memory.id, memory);
		}
		return result.change;
	}

	close(): void {
		if (!this.db) return;
		this.db.close();
		this.db = null;
		this.ftsAvailable = false;
		this.initialized = false;
		this.initPromise = null;
		this.lastAutomaticJsonlMigration = null;
	}

	async importJsonl(): Promise<SQLiteJsonlImportResult> {
		const wasInitialized = this.initialized;
		await this.initialize();
		if (!wasInitialized && this.lastAutomaticJsonlMigration) {
			return this.lastAutomaticJsonlMigration;
		}
		return this.importLegacyJsonlRows();
	}

	async exportJsonl(): Promise<{
		directory: string;
		memoriesPath: string;
		proposalsPath: string;
		memories: number;
		proposals: number;
	}> {
		await this.initialize();
		const memories = await this.list({ includeExpired: true });
		const proposals = await this.listProposals();
		const output = await writeJsonlExport(
			this.rootDirectory,
			this.config,
			memories,
			proposals,
		);
		return {
			...output,
			memories: memories.length,
			proposals: proposals.length,
		};
	}

	async compactMaintenance(
		options: MemoryCompactOptions = {},
	): Promise<MemoryCompactResult> {
		await this.initialize();
		const now = options.now ? new Date(options.now) : new Date();
		const kept: MemoryRecord[] = [];
		const removeIds: string[] = [];
		const result: MemoryCompactResult = {
			dryRun: options.dryRun !== false,
			removedDeleted: 0,
			removedSuperseded: 0,
			removedExpiredScratch: 0,
			remaining: 0,
		};
		for (const memory of this.memories.values()) {
			const compactReason = shouldCompactMemory(memory, now);
			if (compactReason === 'deleted') {
				result.removedDeleted++;
				removeIds.push(memory.id);
				continue;
			}
			if (compactReason === 'superseded') {
				result.removedSuperseded++;
				removeIds.push(memory.id);
				continue;
			}
			if (compactReason === 'expired_scratch') {
				result.removedExpiredScratch++;
				removeIds.push(memory.id);
				continue;
			}
			kept.push(memory);
		}
		result.remaining = kept.length;
		if (result.dryRun) return result;

		const db = this.requireDb();
		const compact = db.transaction(() => {
			for (const id of removeIds) {
				db.run('DELETE FROM memory_items WHERE id = ?', [id]);
				this.deleteMemoryFts(id);
			}
			this.insertEvent(
				'compact',
				'memory_items',
				'removed deleted, superseded, and expired scratch memories',
				JSON.stringify(result),
			);
		});
		compact();
		this.memories = new Map(kept.map((memory) => [memory.id, memory]));
		return result;
	}

	hasMigration(name: string): boolean {
		const row = this.requireDb()
			.query<MigrationRow, [string]>(
				'SELECT version, name FROM schema_migrations WHERE name = ? LIMIT 1',
			)
			.get(name);
		return Boolean(row);
	}

	markMigration(version: number, name: string): void {
		this.requireDb().run(
			'INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)',
			[version, name],
		);
	}

	private selectRecallCandidates(
		request: RecallRequest,
		scopedRecords: MemoryRecord[],
	): {
		records: MemoryRecord[];
		usedFts: boolean;
		ftsOrder?: Map<string, number>;
	} {
		const ftsQuery = buildFtsQuery(request);
		if (!this.ftsAvailable || !ftsQuery) {
			return { records: scopedRecords, usedFts: false };
		}
		const scopedIds = new Set(scopedRecords.map((record) => record.id));
		if (scopedIds.size === 0) {
			return { records: [], usedFts: true, ftsOrder: new Map() };
		}
		try {
			const rows = this.requireDb()
				.query<FtsCandidateRow, [string, string, number]>(
					`SELECT id, bm25(${FTS_TABLE_NAME}) AS rank
					FROM ${FTS_TABLE_NAME}
					WHERE ${FTS_TABLE_NAME} MATCH ?
						AND id IN (SELECT value FROM json_each(?))
					ORDER BY rank ASC
					LIMIT ?`,
				)
				.all(
					ftsQuery,
					JSON.stringify(Array.from(scopedIds)),
					Math.max(100, request.maxItems * 20),
				);
			const ftsOrder = new Map<string, number>();
			for (const row of rows) {
				if (!scopedIds.has(row.id)) continue;
				ftsOrder.set(row.id, ftsOrder.size);
			}
			if (ftsOrder.size === 0 && (request.mode ?? 'manual') === 'manual') {
				return { records: scopedRecords, usedFts: false };
			}
			const records = scopedRecords.filter((record) => ftsOrder.has(record.id));
			return { records, usedFts: true, ftsOrder };
		} catch {
			this.ftsAvailable = false;
			return { records: scopedRecords, usedFts: false };
		}
	}

	private runMigrations(): void {
		const db = this.requireDb();
		db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			name TEXT NOT NULL,
			applied_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`);
		const row = db
			.query<{ version: number | null }, []>(
				'SELECT MAX(version) as version FROM schema_migrations',
			)
			.get();
		const currentVersion = row?.version ?? 0;
		for (const migration of MIGRATIONS) {
			if (migration.version <= currentVersion) continue;
			const apply = db.transaction(() => {
				for (const statement of splitSql(migration.sql)) {
					db.run(statement);
				}
				db.run('INSERT INTO schema_migrations (version, name) VALUES (?, ?)', [
					migration.version,
					migration.name,
				]);
				this.insertEvent(
					'migration',
					String(migration.version),
					migration.name,
				);
			});
			apply();
		}
	}

	private backfillScopeKeys(): void {
		const db = this.requireDb();

		// One-time guard: skip if backfill was already completed in a prior init.
		const metaRow = db
			.query<{ value: string }, [string]>(
				"SELECT value FROM _meta WHERE key = 'scope_key_backfilled'",
			)
			.get('scope_key_backfilled');
		if (metaRow?.value === '1') return;

		const rows = db
			.query<{ id: string; record_json: string; scope_key: string }, []>(
				'SELECT id, record_json, scope_key FROM memory_items',
			)
			.all();
		let backfillCount = 0;
		for (const row of rows) {
			try {
				const record = JSON.parse(row.record_json) as {
					scope: MemoryScopeRef;
				};
				const canonicalKey = stableScopeKey(record.scope);
				if (row.scope_key !== canonicalKey) {
					db.run('UPDATE memory_items SET scope_key = ? WHERE id = ?', [
						canonicalKey,
						row.id,
					]);
					backfillCount++;
				}
			} catch {
				// Skip unparseable records — they'll be handled by normal validation
			}
		}
		if (backfillCount > 0) {
			this.insertEvent(
				'migration',
				'backfill_scope_keys',
				`${backfillCount} memory item(s) scope_key backfilled to canonical form`,
			);
		}

		// Stamp completion so this full-table scan runs only once.
		db.run(
			"INSERT OR REPLACE INTO _meta (key, value) VALUES ('scope_key_backfilled', '1')",
		);
	}

	private initializeFtsIndex(): boolean {
		const db = this.requireDb();
		try {
			if (!this.hasMigration(FTS_SCHEMA_MIGRATION_NAME)) {
				this.recreateFtsIndex();
			} else {
				db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE_NAME} USING fts5(
					${ftsCreateColumnsSql()}
				)`);
			}
			this.ftsAvailable = true;
			const validMemoryCount = this.countValidMemoryRows();
			const ftsCount =
				db
					.query<{ count: number }, []>(
						`SELECT COUNT(*) AS count FROM ${FTS_TABLE_NAME}`,
					)
					.get()?.count ?? 0;
			if (validMemoryCount !== ftsCount) {
				this.rebuildFtsIndex();
			}
			return true;
		} catch {
			this.ftsAvailable = false;
			return false;
		}
	}

	private recreateFtsIndex(): void {
		const db = this.requireDb();
		const recreate = db.transaction(() => {
			db.run(`DROP TABLE IF EXISTS ${FTS_TABLE_NAME}`);
			db.run(`CREATE VIRTUAL TABLE ${FTS_TABLE_NAME} USING fts5(
				${ftsCreateColumnsSql()}
			)`);
		});
		recreate();
	}

	private rebuildFtsIndex(): void {
		const db = this.requireDb();
		const rebuild = db.transaction(() => {
			db.run(`DELETE FROM ${FTS_TABLE_NAME}`);
			for (const row of this.iterateMemoryRows()) {
				const record = this.parseMemoryRow(row);
				if (record) {
					this.writeMemoryFts(record);
				}
			}
		});
		rebuild();
	}

	private countValidMemoryRows(): number {
		let count = 0;
		for (const row of this.iterateMemoryRows()) {
			if (this.parseMemoryRow(row)) count++;
		}
		return count;
	}

	private *iterateMemoryRows(): IterableIterator<MemoryItemRow> {
		yield* this.requireDb()
			.query<MemoryItemRow, []>('SELECT id, record_json FROM memory_items')
			.iterate();
	}

	private parseMemoryRow(row: MemoryItemRow): MemoryRecord | null {
		try {
			return validateMemoryRecordRules(JSON.parse(row.record_json), {
				rejectDurableSecrets: this.config.redaction.rejectDurableSecrets,
			});
		} catch {
			return null;
		}
	}

	private loadMemories(): { records: MemoryRecord[]; invalidCount: number } {
		const rows = this.requireDb()
			.query<MemoryItemRow, []>(
				'SELECT id, record_json FROM memory_items ORDER BY updated_at ASC',
			)
			.all();
		const records: MemoryRecord[] = [];
		let invalidCount = 0;
		for (const row of rows) {
			const record = this.parseMemoryRow(row);
			if (record) {
				records.push(record);
			} else {
				invalidCount++;
			}
		}
		return { records, invalidCount };
	}

	private loadProposals(): {
		records: MemoryProposal[];
		invalidCount: number;
	} {
		const rows = this.requireDb()
			.query<ProposalRow, []>(
				'SELECT id, proposal_json FROM memory_proposals ORDER BY created_at ASC',
			)
			.all();
		const records: MemoryProposal[] = [];
		let invalidCount = 0;
		for (const row of rows) {
			try {
				const proposal = validateMemoryProposal(JSON.parse(row.proposal_json));
				if (proposal.proposedRecord) {
					validateMemoryRecordRules(proposal.proposedRecord, {
						rejectDurableSecrets: this.config.redaction.rejectDurableSecrets,
					});
				}
				records.push(proposal);
			} catch {
				invalidCount++;
			}
		}
		return { records, invalidCount };
	}

	private writeMemory(record: MemoryRecord): void {
		this.requireDb().run(
			`INSERT OR REPLACE INTO memory_items (
				id,
				scope_key,
				kind,
				updated_at,
				expires_at,
				superseded_by,
				deleted,
				record_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				record.id,
				stableScopeKey(record.scope),
				record.kind,
				record.updatedAt,
				record.expiresAt ?? null,
				record.supersededBy ?? null,
				record.metadata.deleted === true ? 1 : 0,
				JSON.stringify(record),
			],
		);
		this.writeMemoryFts(record);
	}

	private writeMemoryFts(record: MemoryRecord): void {
		if (!this.ftsAvailable) return;
		try {
			const db = this.requireDb();
			db.run(`DELETE FROM ${FTS_TABLE_NAME} WHERE id = ?`, [record.id]);
			db.run(
				`INSERT INTO ${FTS_TABLE_NAME} (
					${FTS_INSERT_COLUMNS.join(', ')}
				) VALUES (${FTS_INSERT_COLUMNS.map(() => '?').join(', ')})`,
				[record.id, ...ftsColumnValues(record)],
			);
		} catch {
			this.ftsAvailable = false;
		}
	}

	private deleteMemoryFts(id: string): void {
		if (!this.ftsAvailable) return;
		try {
			this.requireDb().run(`DELETE FROM ${FTS_TABLE_NAME} WHERE id = ?`, [id]);
		} catch {
			this.ftsAvailable = false;
		}
	}

	private writeProposal(proposal: MemoryProposal): void {
		this.requireDb().run(
			`INSERT OR REPLACE INTO memory_proposals (
				id,
				status,
				created_at,
				proposal_json
			) VALUES (?, ?, ?, ?)`,
			[
				proposal.id,
				proposal.status,
				proposal.createdAt,
				JSON.stringify(proposal),
			],
		);
	}

	private applyDecisionToStorage(
		decision: ResolvedCuratorMemoryDecision,
		proposal: MemoryProposal,
		appliedAt: string,
	): Omit<DecisionTransactionResult, 'change'> & {
		change: Omit<AppliedMemoryChange, 'eventId'>;
	} {
		const memories: MemoryRecord[] = [];
		const removeMemoryIds: string[] = [];
		let memoryId: string | undefined;
		let targetMemoryId: string | undefined;
		let oldMemoryId: string | undefined;
		let replacementMemoryId: string | undefined;

		if (decision.action === 'add') {
			const memory = this.validateDecisionMemory({
				...decision.memory,
				updatedAt: appliedAt,
			});
			validateCuratorPromotableMemory(memory);
			this.writeMemory(memory);
			memories.push(memory);
			memoryId = memory.id;
		} else if (decision.action === 'update') {
			const existing = this.readActiveMemory(decision.targetMemoryId);
			const updated = this.validateDecisionMemory(
				applyPatchToMemory(existing, decision.patch, appliedAt),
			);
			validateCuratorPromotableMemory(updated);
			if (updated.id !== existing.id) {
				// Update replacements are linked through updateReplacementId; the
				// supersedes graph is reserved for explicit supersede decisions.
				const tombstone = this.validateDecisionMemory({
					...existing,
					updatedAt: appliedAt,
					metadata: {
						...existing.metadata,
						deleted: true,
						deleteReason: decision.reason,
						updateReplacementId: updated.id,
					},
				});
				this.writeMemory(tombstone);
				memories.push(tombstone);
			}
			this.writeMemory(updated);
			memories.push(updated);
			memoryId = updated.id;
			targetMemoryId = existing.id;
		} else if (decision.action === 'supersede') {
			const oldMemory = this.readActiveMemory(decision.oldMemoryId);
			const replacement = this.validateDecisionMemory({
				...decision.replacement,
				updatedAt: appliedAt,
				supersedes: Array.from(
					new Set([...(decision.replacement.supersedes ?? []), oldMemory.id]),
				),
			});
			validateCuratorPromotableMemory(replacement);
			const superseded = this.validateDecisionMemory({
				...oldMemory,
				updatedAt: appliedAt,
				supersededBy: replacement.id,
				metadata: {
					...oldMemory.metadata,
					supersedeReason: decision.reason,
				},
			});
			this.writeMemory(superseded);
			this.writeMemory(replacement);
			memories.push(superseded, replacement);
			oldMemoryId = oldMemory.id;
			replacementMemoryId = replacement.id;
			memoryId = replacement.id;
		}

		const proposalStatus =
			decision.action === 'reject' ? 'rejected' : 'applied';
		const reviewedProposal = markProposalReviewed(
			proposal,
			decision,
			proposalStatus,
			appliedAt,
			{
				memoryId,
				targetMemoryId,
				oldMemoryId,
				replacementMemoryId,
			},
		);
		const change: Omit<AppliedMemoryChange, 'eventId'> = {
			action: decision.action,
			proposalId: decision.proposalId,
			proposalStatus,
			appliedAt,
			memoryId,
			targetMemoryId,
			oldMemoryId,
			replacementMemoryId,
			reason: curatorDecisionReason(decision),
		};
		return {
			change,
			proposal: reviewedProposal,
			memories,
			removeMemoryIds,
		};
	}

	private readPendingProposal(proposalId: string): MemoryProposal {
		const row = this.requireDb()
			.query<ProposalRow, [string]>(
				'SELECT id, proposal_json FROM memory_proposals WHERE id = ? LIMIT 1',
			)
			.get(proposalId);
		if (!row) {
			throw new MemoryValidationError('memory proposal was not found');
		}
		const proposal = validateMemoryProposal(JSON.parse(row.proposal_json));
		if (proposal.status !== 'pending') {
			throw new MemoryValidationError('memory proposal is not pending');
		}
		if (proposal.proposedRecord) {
			validateMemoryRecordRules(proposal.proposedRecord, {
				rejectDurableSecrets: this.config.redaction.rejectDurableSecrets,
			});
		}
		return proposal;
	}

	private readActiveMemory(memoryId: string): MemoryRecord {
		const row = this.requireDb()
			.query<MemoryItemRow, [string]>(
				'SELECT id, record_json FROM memory_items WHERE id = ? LIMIT 1',
			)
			.get(memoryId);
		if (!row) {
			throw new MemoryValidationError('target memory was not found');
		}
		const memory = this.validateDecisionMemory(JSON.parse(row.record_json));
		if (memory.metadata.deleted === true) {
			throw new MemoryValidationError('target memory is deleted');
		}
		if (memory.supersededBy) {
			throw new MemoryValidationError('target memory is superseded');
		}
		return memory;
	}

	private validateDecisionMemory(record: MemoryRecord): MemoryRecord {
		return validateMemoryRecordRules(record, {
			rejectDurableSecrets: this.config.redaction.rejectDurableSecrets,
		});
	}

	private async migrateLegacyJsonlIfNeeded(): Promise<void> {
		if (this.hasMigration(LEGACY_JSONL_MIGRATION_NAME)) return;
		const backups = await backupLegacyJsonl(this.rootDirectory, this.config);
		const result = await this.importLegacyJsonlRows();
		this.lastAutomaticJsonlMigration = result;
		this.markMigration(
			LEGACY_JSONL_MIGRATION_VERSION,
			LEGACY_JSONL_MIGRATION_NAME,
		);
		const report: JsonlMigrationReport = {
			migration: LEGACY_JSONL_MIGRATION_NAME,
			completedAt: new Date().toISOString(),
			skipped: false,
			importedMemories: result.importedMemories,
			importedProposals: result.importedProposals,
			invalidRows: result.invalidRows,
			backups,
		};
		await writeMigrationReport(this.rootDirectory, report, this.config);
		this.insertEvent(
			'migration',
			LEGACY_JSONL_MIGRATION_NAME,
			JSON.stringify({
				importedMemories: result.importedMemories,
				importedProposals: result.importedProposals,
				invalidRows: result.invalidRows.length,
			}),
		);
	}

	private async importLegacyJsonlRows(): Promise<SQLiteJsonlImportResult> {
		const payload = await readLegacyJsonl(this.rootDirectory, this.config);
		for (const record of payload.memories) {
			this.writeMemory(record);
		}
		for (const proposal of payload.proposals) {
			this.writeProposal(proposal);
		}
		return {
			importedMemories: payload.memories.length,
			importedProposals: payload.proposals.length,
			invalidRows: payload.invalidRows,
			totalRows: payload.totalRows,
		};
	}

	private async event(
		operation: EventOperation,
		targetId: string,
		reason?: string,
	): Promise<void> {
		this.insertEvent(operation, targetId, reason);
	}

	private insertEvent(
		operation: EventOperation,
		targetId: string,
		reason?: string,
		eventJson?: string,
		id = randomUUID(),
	): void {
		this.requireDb().run(
			`INSERT INTO memory_events (
				id,
				operation,
				target_id,
				reason,
				timestamp,
				event_json
			) VALUES (?, ?, ?, ?, ?, ?)`,
			[
				id,
				operation,
				targetId,
				reason ?? null,
				new Date().toISOString(),
				eventJson ?? (reason ? JSON.stringify({ reason }) : null),
			],
		);
	}

	private requireDb(): Database {
		if (!this.db)
			throw new MemoryValidationError(
				'SQLite memory provider is not initialized',
				'provider_not_initialized',
			);
		return this.db;
	}
}

// Naive split-on-';' was replaced with a stateful parser that respects single-quoted
// string literals and `--` line comments. Double-quoted SQLite identifiers are NOT in
// scope for Phase 1 (current migrations use only single-quoted strings); document as
// future work.
function splitSql(sql: string): string[] {
	const statements: string[] = [];
	let current = '';
	let inSingleQuote = false;
	let inLineComment = false;

	for (let i = 0; i < sql.length; i++) {
		const char = sql[i];
		const next = sql[i + 1];

		if (inLineComment) {
			if (char === '\n') {
				inLineComment = false;
			}
			continue; // skip comment chars entirely (they don't appear in statement output)
		}

		if (inSingleQuote) {
			if (char === "'" && next === "'") {
				current += "''"; // SQLite escaped single quote
				i++; // consume both characters
				continue;
			}
			current += char;
			if (char === "'") {
				inSingleQuote = false;
			}
			continue;
		}

		// Not in quote or comment
		if (char === '-' && next === '-') {
			inLineComment = true;
			i++; // consume the second '-'
			continue;
		}
		if (char === "'") {
			inSingleQuote = true;
			current += char;
			continue;
		}
		if (char === ';') {
			const trimmed = current.trim();
			if (trimmed) statements.push(trimmed);
			current = '';
			continue;
		}
		current += char;
	}

	// Handle trailing statement without semicolon
	const trimmed = current.trim();
	if (trimmed) statements.push(trimmed);

	return statements;
}

const FTS_STOP_WORDS = new Set([
	'a',
	'an',
	'and',
	'are',
	'as',
	'at',
	'be',
	'by',
	'for',
	'from',
	'goal',
	'how',
	'in',
	'into',
	'is',
	'it',
	'of',
	'on',
	'or',
	'role',
	'task',
	'that',
	'the',
	'this',
	'to',
	'user',
	'what',
	'when',
	'with',
]);

function buildFtsQuery(request: RecallRequest): string | null {
	const text =
		request.mode === 'injection' && request.task
			? `${request.task}\n${request.query}`
			: `${request.query}\n${request.task ?? ''}`;
	const terms = Array.from(extractFtsTerms(text)).slice(0, 40);
	if (terms.length === 0) return null;
	return terms.map((term) => `"${term}"`).join(' OR ');
}

function extractFtsTerms(text: string): Set<string> {
	const terms = new Set<string>();
	for (const match of text.toLowerCase().matchAll(/[a-z0-9_]{2,}/g)) {
		const term = match[0];
		if (FTS_STOP_WORDS.has(term)) continue;
		if (term.length < 3 && !/^\d+$/.test(term)) continue;
		terms.add(term);
	}
	return terms;
}

function ftsCreateColumnsSql(): string {
	return [
		'id UNINDEXED',
		...FTS_INDEX_COLUMNS.map((column) => column.name),
	].join(',\n\t\t\t\t');
}

function ftsColumnValues(record: MemoryRecord): string[] {
	return FTS_INDEX_COLUMNS.map((column) => column.value(record));
}

function collectMetadataSearchStrings(
	metadata: Record<string, unknown>,
	keys: string[],
): string[] {
	const values: string[] = [];
	for (const key of keys) {
		const value = metadata[key];
		if (typeof value === 'string') {
			values.push(value);
			continue;
		}
		if (!Array.isArray(value)) continue;
		for (const item of value) {
			if (typeof item === 'string') values.push(item);
		}
	}
	return values;
}

function rerankWithFts(
	items: RecallResultItem[],
	ftsOrder: Map<string, number>,
): RecallResultItem[] {
	const denominator = Math.max(ftsOrder.size, 1);
	return items
		.map((item) => {
			const order = ftsOrder.get(item.record.id);
			if (order === undefined) return item;
			const ftsBoost = ((denominator - order) / denominator) * 0.08;
			return {
				...item,
				score: item.score + ftsBoost,
				reason: `${item.reason}, fts_rank=${order + 1}`,
			};
		})
		.sort(
			(a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id),
		);
}

export const _test_exports = {
	splitSql,
	buildFtsQuery,
	extractFtsTerms,
	FTS_SCHEMA_MIGRATION_NAME,
	FTS_SCHEMA_MIGRATION_VERSION,
};
