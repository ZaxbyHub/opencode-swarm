import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { validateSwarmPath } from '../hooks/utils';
import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from './config';
import { MemoryValidationError } from './errors';
import type {
	MemoryProposalStore,
	MemoryProvider,
	MemoryRecallUsageEvent,
} from './provider';
import { validateMemoryProposal, validateMemoryRecordRules } from './schema';
import type { RecallScoringDiagnostics } from './scoring';
import { scopeAllowed, scoreMemoryRecordsWithDiagnostics } from './scoring';
import type {
	MemoryListFilter,
	MemoryProposal,
	MemoryRecord,
	RecallRequest,
	RecallResultItem,
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
	| 'invalid_load';

interface Migration {
	version: number;
	name: string;
	sql: string;
}

const MIGRATIONS: Migration[] = [
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
];

interface MemoryItemRow {
	id: string;
	record_json: string;
}

interface ProposalRow {
	id: string;
	proposal_json: string;
}

export class SQLiteMemoryProvider
	implements MemoryProvider, MemoryProposalStore
{
	readonly name = 'sqlite';
	private readonly rootDirectory: string;
	private readonly config: MemoryConfig;
	private initialized = false;
	private db: Database | null = null;
	private memories = new Map<string, MemoryRecord>();
	private proposals = new Map<string, MemoryProposal>();

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
		};
	}

	private databasePath(): string {
		const relativePath = this.config.sqlite.path.replace(/^\.swarm[/\\]?/, '');
		return validateSwarmPath(this.rootDirectory, relativePath);
	}

	async initialize(): Promise<void> {
		if (this.initialized) return;
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
		const records = await this.list({
			scopes: request.scopes,
			kinds: request.kinds,
			includeExpired: request.includeExpired,
		});
		const result = scoreMemoryRecordsWithDiagnostics(records, request);
		return {
			items: result.items.slice(0, request.maxItems),
			diagnostics: {
				...result.diagnostics,
				returnedCount: Math.min(
					result.diagnostics.returnedCount,
					request.maxItems,
				),
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
		await this.event('recall', event.bundleId, JSON.stringify(event));
	}

	async list(filter: MemoryListFilter = {}): Promise<MemoryRecord[]> {
		await this.initialize();
		let records = Array.from(this.memories.values());
		if (filter.scopes && filter.scopes.length > 0) {
			records = records.filter((record) =>
				scopeAllowed(record.scope, filter.scopes ?? []),
			);
		}
		if (filter.kinds && filter.kinds.length > 0) {
			records = records.filter((record) => filter.kinds?.includes(record.kind));
		}
		if (!filter.includeExpired) {
			const now = Date.now();
			records = records.filter((record) => {
				if (!record.expiresAt) return true;
				const expires = Date.parse(record.expiresAt);
				return !Number.isFinite(expires) || expires > now;
			});
		}
		records = records.filter(
			(record) => !record.supersededBy && record.metadata.deleted !== true,
		);
		records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		return records.slice(0, filter.limit ?? records.length);
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
		this.requireDb().run(
			`INSERT OR REPLACE INTO memory_proposals (
				id,
				status,
				created_at,
				proposal_json
			) VALUES (?, ?, ?, ?)`,
			[next.id, next.status, next.createdAt, JSON.stringify(next)],
		);
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

	close(): void {
		if (!this.db) return;
		this.db.close();
		this.db = null;
		this.initialized = false;
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

	private loadMemories(): { records: MemoryRecord[]; invalidCount: number } {
		const rows = this.requireDb()
			.query<MemoryItemRow, []>(
				'SELECT id, record_json FROM memory_items ORDER BY updated_at ASC',
			)
			.all();
		const records: MemoryRecord[] = [];
		let invalidCount = 0;
		for (const row of rows) {
			try {
				records.push(
					validateMemoryRecordRules(JSON.parse(row.record_json), {
						rejectDurableSecrets: this.config.redaction.rejectDurableSecrets,
					}),
				);
			} catch {
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
				JSON.stringify(record.scope),
				record.kind,
				record.updatedAt,
				record.expiresAt ?? null,
				record.supersededBy ?? null,
				record.metadata.deleted === true ? 1 : 0,
				JSON.stringify(record),
			],
		);
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
				randomUUID(),
				operation,
				targetId,
				reason ?? null,
				new Date().toISOString(),
				reason ? JSON.stringify({ reason }) : null,
			],
		);
	}

	private requireDb(): Database {
		if (!this.db) throw new Error('SQLite memory provider is not initialized');
		return this.db;
	}
}

function splitSql(sql: string): string[] {
	return sql
		.split(';')
		.map((statement) => statement.trim())
		.filter(Boolean);
}
