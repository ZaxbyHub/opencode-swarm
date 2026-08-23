import type { Database, SQLQueryBindings } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { loadDatabaseCtor } from '../db/sqlite-loader.js';
import { validateSwarmPath } from '../hooks/utils';
import { warn } from '../utils';
import { stableCanonicalStringify } from '../utils/stable-stringify';
import {
	DEFAULT_MEMORY_CONFIG,
	DURABLE_MEMORY_KINDS,
	type MemoryConfig,
} from './config';
import {
	applyPatchToMemory,
	buildCuratorDecisionEvent,
	curatorDecisionReason,
	markProposalReviewed,
	validateCuratorPromotableMemory,
	validateDecisionMatchesProposal,
} from './curator-decision-helpers';
import { EmbeddingCache } from './embeddings/cache';
import { type FusionWeights, fuseRankings } from './embeddings/fusion';
import { LocalEmbeddingProvider } from './embeddings/local-provider';
import {
	CrossEncoderReranker,
	type RerankCandidate,
	shouldRerank,
} from './embeddings/reranker';
import type { EmbeddingProvider } from './embeddings/types';
import {
	EmbeddingUnavailableError,
	EmbeddingVersionMismatchError,
} from './embeddings/types';
import { MemoryValidationError } from './errors';
import {
	backupLegacyJsonl,
	getLegacyOutcomeJsonlSignature,
	type JsonlMigrationReport,
	LEGACY_JSONL_MIGRATION_NAME,
	LEGACY_JSONL_MIGRATION_VERSION,
	LEGACY_JSONL_OUTCOME_META_KEY,
	readLegacyJsonl,
	writeJsonlExport,
	writeMigrationReport,
} from './jsonl-migration';
import { shouldCompactMemory } from './maintenance';
import {
	assertEventIdentityCompatible,
	ensureOutcomeGeneration,
	importMaterializedOutcomeEvents,
	type MemoryOutcomeEvent,
	materializeOutcomeRecord,
	stripMaterializedOutcomes,
	validateOutcomeEvent,
	validateOutcomeEventForMemory,
} from './outcome-events';
import type {
	MemoryCompactOptions,
	MemoryCompactResult,
	MemoryProposalStore,
	MemoryProvider,
	MemoryRecallUsageEvent,
	MemoryRecallUsageFilter,
	MemoryRewardEvent,
	MemoryRewardEventFilter,
	MemoryTransaction,
} from './provider';
import {
	buildMemoryCohortFingerprintInput,
	classifyStoredFingerprintAlgorithmVersion,
	computeMemoryCohortFingerprint,
} from './redaction';
import {
	normalizeMemoryText,
	stableScopeKey,
	validateMemoryProposal,
	validateMemoryRecordRules,
} from './schema';
import type { RecallScoringDiagnostics } from './scoring';
import {
	scoreMemoryRecordsWithDiagnostics,
	sliceRecallItemsWithExploration,
} from './scoring';
import type {
	AppliedMemoryChange,
	MemoryAnchor,
	MemoryListFilter,
	MemoryOutcome,
	MemoryProposal,
	MemoryRecord,
	MemoryScopeRef,
	RecallRequest,
	RecallResultItem,
	ResolvedCuratorMemoryDecision,
} from './types';

// The runtime SQLite driver is resolved by the shared, runtime-portable loader
// (`../db/sqlite-loader.ts`): native `bun:sqlite` under Bun, a `node:sqlite` adapter
// under Node (issue #1873 / invariant #2). Resolved lazily inside `doInitialize` so
// the bundle keeps no top-level `bun:` import (issue #675) and the driver loads only
// when the SQLite memory provider is actually selected.

type EventOperation =
	| 'upsert'
	| 'delete'
	| 'proposal'
	| 'recall'
	| 'migration'
	| 'compact'
	| 'compact_triggered'
	| 'curator_decision'
	| 'invalid_load'
	| 'pii_rejected';

/** #1466: genesis anchor for the memory_events hash chain (mirrors the
 * knowledge-receipt ledger's GENESIS convention). */
export const EVENT_CHAIN_GENESIS = 'GENESIS';
export const MEMORY_EVENTS_CHAIN_HEAD_KEY = 'memory_events_chain_head';

export interface MemoryEventRow {
	id: string;
	operation: string;
	target_id: string;
	reason: string | null;
	timestamp: string;
	event_json: string | null;
	prev_hash: string | null;
}

/**
 * #1466: SHA-256 over the canonical serialization of a FULL event row
 * (including its own prev_hash — the chain link is "hash of the entire
 * previous row", so tampering any field of row n breaks row n+1's link).
 * Mirrors `receiptRecordHash` in knowledge-receipt-ledger-storage.ts.
 */
export function memoryEventRowHash(row: MemoryEventRow): string {
	return createHash('sha256')
		.update(
			stableCanonicalStringify({
				id: row.id,
				operation: row.operation,
				target_id: row.target_id,
				reason: row.reason,
				timestamp: row.timestamp,
				event_json: row.event_json,
				prev_hash: row.prev_hash,
			}),
		)
		.digest('hex');
}

export interface MemoryAuditVerificationReport {
	supported: boolean;
	totalRows: number;
	/** Rows inside the verified hash chain. */
	chainedRows: number;
	/** Rows predating migration v13 (NULL prev_hash prefix) — reported, not verified. */
	legacyRows: number;
	verified: boolean;
	/** First divergence, when the chain is broken. */
	divergence?: {
		rowId: string;
		detail: string;
	};
	/** Chain-head check against _meta — catches last-row tampering. */
	headMatch: boolean | null;
	headExpected?: string;
	headStored?: string | null;
}

/**
 * #1466: lazily verify the memory_events hash chain over ordered rows. Pure —
 * takes the already-read rows plus the stored head, returns a report. Used by
 * `/swarm memory audit-verify` and tests. The chain link is "hash of the full
 * previous row (including its prev_hash)", so tampering any field of row n
 * breaks row n+1; the _meta head catches tampering of the LAST row.
 */
export function verifyMemoryEventChainRows(
	rows: MemoryEventRow[],
	storedHead: string | null,
): MemoryAuditVerificationReport {
	let prevHash: string | null = null;
	let chainedRows = 0;
	let legacyRows = 0;
	for (const row of rows) {
		if (prevHash === null && row.prev_hash === null) {
			// Pre-v13 row: legitimately unchained prefix (chain starts later).
			legacyRows++;
			continue;
		}
		if (prevHash === null) {
			if (row.prev_hash !== EVENT_CHAIN_GENESIS) {
				return {
					supported: true,
					totalRows: rows.length,
					chainedRows,
					legacyRows,
					verified: false,
					divergence: {
						rowId: row.id,
						detail: `chain anchor mismatch: first chained row has prev_hash ${row.prev_hash}, expected ${EVENT_CHAIN_GENESIS}`,
					},
					headMatch: null,
				};
			}
			prevHash = memoryEventRowHash(row);
			chainedRows++;
			continue;
		}
		if (row.prev_hash !== prevHash) {
			return {
				supported: true,
				totalRows: rows.length,
				chainedRows,
				legacyRows,
				verified: false,
				divergence: {
					rowId: row.id,
					detail: `prev_hash mismatch: expected ${prevHash}, found ${row.prev_hash ?? 'NULL'}`,
				},
				headMatch: null,
			};
		}
		prevHash = memoryEventRowHash(row);
		chainedRows++;
	}
	// Head check. NOTE the conservative boundary: a table with ONLY legacy
	// (pre-v13, NULL prev_hash) rows has no computed chain head — if _meta
	// nevertheless carries a head, that means rows were chained at some point
	// and then REPLACED by unchained ones (or the head was tampered), so the
	// comparison fails CLOSED (verified: false). Pinned by
	// tests/unit/memory/audit-chain.test.ts.
	const headExpected = prevHash;
	const headMatch =
		headExpected === null
			? storedHead === null || storedHead === undefined
			: storedHead === headExpected;
	return {
		supported: true,
		totalRows: rows.length,
		chainedRows,
		legacyRows,
		verified: headMatch === true,
		headMatch,
		headExpected: headExpected ?? undefined,
		headStored: storedHead ?? null,
	};
}

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
	{
		version: 6,
		name: 'create_embedding_config_table',
		sql: `
			CREATE TABLE IF NOT EXISTS embedding_config (
				key TEXT PRIMARY KEY,
				value TEXT
			);
		`,
	},
	{
		version: 7,
		name: 'add_recall_learning_columns',
		// Migration version 7 (not v5 as issue #1467 spec stated):
		//   v2 is reserved by LEGACY_JSONL_MIGRATION_VERSION (src/memory/jsonl-migration.ts:9).
		//   v5 was occupied by the recall_usage timestamp index migration.
		//   v6 was occupied by the embedding_config migration.
		//   v7 is the first available slot for this change.
		sql: `
			ALTER TABLE memory_recall_usage ADD COLUMN q_value REAL DEFAULT 0.5;
			ALTER TABLE memory_recall_usage ADD COLUMN last_reward REAL;
			ALTER TABLE memory_recall_usage ADD COLUMN task_outcome TEXT;
			ALTER TABLE memory_recall_usage ADD COLUMN council_verdict_json TEXT;
		`,
	},
	{
		version: 8,
		name: 'add_recall_reward_idempotency_key',
		// Stores a stable "swarmId:taskOrPhase:roundNumber" key (see
		// deriveRewardKey below) on the recall-usage row a reward was last
		// applied against, so a duplicate council-verdict submission for the
		// SAME round does not re-apply the EMA update indefinitely.
		sql: `
			ALTER TABLE memory_recall_usage ADD COLUMN reward_key TEXT;
		`,
	},
	{
		version: 9,
		name: 'add_reward_events_and_recall_run_id',
		sql: `
			CREATE TABLE IF NOT EXISTS memory_reward_events (
				id TEXT PRIMARY KEY,
				memory_id TEXT NOT NULL,
				run_id TEXT,
				unit_id TEXT,
				verdict TEXT NOT NULL,
				reward REAL NOT NULL,
				q_before REAL,
				q_after REAL,
				verdict_synthesis_json TEXT,
				timestamp TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_memory_reward_events_memory
				ON memory_reward_events(memory_id);
			ALTER TABLE memory_recall_usage ADD COLUMN run_id TEXT;
			CREATE INDEX IF NOT EXISTS idx_memory_recall_usage_run_id
				ON memory_recall_usage(run_id);
		`,
	},
	{
		version: 10,
		name: 'add_recall_usage_unit_id',
		// B.1 — ADDITIVE task/phase identity on recall-usage rows. Mirrors the v7
		// run_id column exactly. Idempotency comes from the runMigrations version
		// guard + the per-migration transaction, NOT from `IF NOT EXISTS` on ALTER
		// (SQLite does not support that clause on ADD COLUMN). Brand-new column —
		// no historical usage_json backfill (unlike run_id): existing rows keep
		// unit_id NULL, which is the intended graceful-degrade default.
		sql: `
			ALTER TABLE memory_recall_usage ADD COLUMN unit_id TEXT;
			CREATE INDEX IF NOT EXISTS idx_memory_recall_usage_unit_id
				ON memory_recall_usage(unit_id);
		`,
	},
	{
		version: 11,
		name: 'create_memory_outcomes',
		sql: `
			CREATE TABLE IF NOT EXISTS memory_outcomes (
				id TEXT PRIMARY KEY,
				memory_id TEXT NOT NULL,
				generation TEXT NOT NULL,
				at TEXT NOT NULL,
				event_json TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_memory_outcomes_memory_generation
				ON memory_outcomes(memory_id, generation, at, id);
		`,
	},
	// #1466 Phase 6 (issue text said "migration version 6", but v6 is occupied
	// by create_embedding_config_table — v12 is the next free slot). Provenance
	// columns denormalize record fields for queryable attribution; safe
	// defaults keep legacy rows valid (source_task_id='', agent_role='unknown',
	// valid_from backfilled from record createdAt by backfillProvenanceColumns).
	{
		version: 12,
		name: 'add_memory_provenance_columns',
		sql: `
			ALTER TABLE memory_items ADD COLUMN source_task_id TEXT NOT NULL DEFAULT '';
			ALTER TABLE memory_items ADD COLUMN agent_role TEXT NOT NULL DEFAULT 'unknown';
			ALTER TABLE memory_items ADD COLUMN embedding_model_version TEXT NOT NULL DEFAULT '';
			ALTER TABLE memory_items ADD COLUMN valid_from TEXT;
			ALTER TABLE memory_items ADD COLUMN supersedes_reason TEXT;
		`,
	},
	// #1466 Phase 6: tamper-evidence for the memory_events audit log. Each row
	// chains to the SHA-256 of the full previous row (including its prev_hash);
	// the head hash is mirrored into _meta so last-row tampering is also
	// detectable. Backfilled deterministically by backfillEventHashChain.
	{
		version: 13,
		name: 'add_memory_events_prev_hash',
		sql: `
			ALTER TABLE memory_events ADD COLUMN prev_hash TEXT;
		`,
	},
];

/** #1466: name of the migration that introduces memory_events.prev_hash. */
const EVENT_CHAIN_SCHEMA_MIGRATION_NAME = 'add_memory_events_prev_hash';

/**
 * The single chain-scan SELECT shared by backfillEventHashChain and
 * verifyAuditChain. Extracted to a constant so the two call sites are
 * byte-identical BY CONSTRUCTION — they share one bun query-cache slot
 * (bounded query-cache budget, see backfillProvenanceColumns; PR #2310
 * feedback FB-L1: the prior inline copies differed in embedded indentation
 * and silently occupied two slots).
 */
const EVENT_CHAIN_SCAN_SQL = `SELECT rowid, id, operation, target_id, reason, timestamp, event_json, prev_hash
FROM memory_events ORDER BY rowid ASC`;

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

interface RewardEventRow {
	id: string;
	memory_id: string;
	run_id: string | null;
	unit_id: string | null;
	verdict: string;
	reward: number;
	q_before: number | null;
	q_after: number | null;
	verdict_synthesis_json: string | null;
	timestamp: string;
}

interface OutcomeEventRow {
	id: string;
	event_json: string;
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
	importedOutcomes: number;
	invalidRows: JsonlMigrationReport['invalidRows'];
	totalRows: number;
}

export class SQLiteMemoryProvider
	implements MemoryProvider, MemoryProposalStore
{
	readonly name = 'sqlite';
	private readonly rootDirectory: string;
	/**
	 * #1850: when set, the provider serves a cohort-shared store rather than
	 * the worktree-local `.swarm/memory`. Cohort roots live under the platform
	 * data dir (`<dataDir>/links/<linkId>/memory`) and bypass
	 * `validateSwarmPath` by construction (the resolver sanitizes the linkId).
	 * `null` for local-root providers (today's behavior, still validated).
	 */
	private readonly cohortRoot: string | null;
	private readonly config: MemoryConfig;
	private initialized = false;
	private initPromise: Promise<void> | null = null;
	private db: Database | null = null;
	private ftsAvailable = false;
	private vecAvailable = false;
	private embeddingProvider: EmbeddingProvider | null = null;
	private embeddingCache: EmbeddingCache | null = null;
	private reranker: CrossEncoderReranker | null = null;
	private memories = new Map<string, MemoryRecord>();
	private proposals = new Map<string, MemoryProposal>();
	private lastAutomaticJsonlMigration: SQLiteJsonlImportResult | null = null;
	private recallCountSinceLastCompaction = 0;
	private isCompacting = false;

	constructor(
		rootDirectory: string,
		config: Partial<MemoryConfig> = {},
		/**
		 * #1850: optional cohort root. When provided, the provider opens the DB
		 * at `<cohortRoot>/memory.db` and bypasses `validateSwarmPath` (the
		 * cohort root is resolver-constructed from a sanitized linkId, not a
		 * user-supplied path). When omitted, the provider uses the worktree
		 * `.swarm` path with full `validateSwarmPath` enforcement (today's
		 * behavior).
		 */
		vettedCohortRoot?: string | null,
	) {
		this.rootDirectory = rootDirectory;
		this.cohortRoot = vettedCohortRoot ?? null;
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

	/**
	 * #1850 (critic GAP-5): explicit cohort-root path branch.
	 * - cohort root → `<cohortRoot>/memory.db` (NO validateSwarmPath — the
	 *   cohort root is a platform-data-dir path constructed by the resolver
	 *   from a sanitized linkId, never from user input).
	 * - local root → existing behavior: strip `.swarm/` prefix, pass through
	 *   `validateSwarmPath` to enforce `.swarm` containment.
	 */
	private databasePath(): string {
		if (this.cohortRoot) {
			return path.join(this.cohortRoot, 'memory.db');
		}
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
		// #1850 (reviewer important fix): enforce the cohort config fingerprint
		// BEFORE opening the DB, so a cohort member with a mismatched provider,
		// embedding model, or redaction policy fails closed (acceptance #10).
		// The fingerprint was written at link time by `handleMemoryLinkCommand`.
		if (this.cohortRoot) {
			this.assertCohortConfigFingerprint();
		}
		mkdirSync(path.dirname(dbPath), { recursive: true });
		const Db = loadDatabaseCtor();
		this.db = new Db(dbPath);
		// M14: everything after the native handle is opened can throw
		// (migrations, backfills, JSONL migration, loads). On ANY failure we
		// must close the just-opened handle and null it, otherwise initialize()'s
		// catch nulls initPromise and a retry re-opens a second native handle —
		// leaking the first one. A narrow wrap around only runMigrations() would
		// miss the later throw sites, so the entire post-open body is guarded.
		try {
			// PR #2310 feedback PRR-017: busy_timeout FIRST. Every statement
			// between the raw open and this PRAGMA runs with NO busy handling,
			// so a second connection touching the same WAL database (e.g. the
			// audit-verify command's diagnostic provider alongside a pooled
			// provider) could hit a raw SQLITE_BUSY during journal-mode setup.
			const busyTimeoutMs = Math.min(
				60000,
				Math.max(0, Math.trunc(this.config.sqlite.busyTimeoutMs)),
			);
			this.db.run(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
			this.db.run('PRAGMA journal_mode = WAL;');
			this.db.run('PRAGMA synchronous = NORMAL;');
			this.db.run('PRAGMA foreign_keys = ON;');
			this.runMigrations();
			this.backfillScopeKeys();
			this.backfillRecallRunIds();
			// #1466 Phase 6: provenance columns (v12) + event hash chain (v13)
			// backfills. Must run before any new event insert so the chain tail
			// is anchored (see backfillEventHashChain).
			this.backfillProvenanceColumns();
			this.backfillEventHashChain();
			this.ftsAvailable = this.initializeFtsIndex();
			this.initializeVecExtension();
			if (this.config.embeddings.enabled && !this.embeddingProvider) {
				try {
					this.embeddingProvider = new LocalEmbeddingProvider({
						model: this.config.embeddings.model,
						dimension: this.config.embeddings.dimension,
						version: this.config.embeddings.version,
					});
				} catch (err) {
					this.embeddingProvider = null;
					warn(
						'Failed to construct embedding provider — dense retrieval disabled',
						{
							reason: err instanceof Error ? err.message : String(err),
						},
					);
				}
				try {
					this.embeddingCache = new EmbeddingCache(
						this.config.embeddings.cacheSize,
					);
				} catch (err) {
					this.embeddingCache = null;
					warn(
						'Failed to construct embedding cache — recall works without cache',
						{
							reason: err instanceof Error ? err.message : String(err),
						},
					);
				}
			}
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
		} catch (err) {
			try {
				this.db?.close();
			} catch {
				// Ignore close failures on the half-initialized handle; the
				// original init error below is what matters.
			}
			this.db = null;
			this.ftsAvailable = false;
			// Reset initialized so a retry re-opens a fresh handle. A throw AFTER
			// `this.initialized = true` (e.g. the `invalid_load` telemetry inserts
			// above) would otherwise leave initialized===true with db===null, and
			// initialize()'s `if (this.initialized) return;` short-circuit would
			// wedge the provider permanently (every requireDb() throws). initPromise
			// is reset by initialize()'s own .catch.
			this.initialized = false;
			throw err;
		}
	}

	async upsert(record: MemoryRecord): Promise<MemoryRecord> {
		await this.initialize();
		const db = this.requireDb();
		let next: MemoryRecord;
		const ownsTransaction = !db.inTransaction;
		if (ownsTransaction) db.run('BEGIN IMMEDIATE');
		try {
			const existing = this.readMemoryById(record.id);
			if (existing?.metadata.deleted === true) {
				throw new MemoryValidationError(
					'memory is tombstoned and cannot be upserted',
				);
			}
			next = validateMemoryRecordRules(
				{
					...record,
					createdAt: existing?.createdAt ?? record.createdAt,
					metadata: {
						...record.metadata,
						outcomeGeneration:
							existing?.metadata.outcomeGeneration ??
							record.metadata.outcomeGeneration,
					},
				},
				{ rejectDurableSecrets: this.config.redaction.rejectDurableSecrets },
			);
			if (
				(next.outcomes?.length ?? 0) > 0 ||
				typeof next.metadata.outcomeGeneration === 'string'
			) {
				next = ensureOutcomeGeneration(next);
			}
			const existingEvents = this.readOutcomeEvents(next.id);
			const base = stripMaterializedOutcomes(next);
			this.writeMemory(base);
			if (typeof next.metadata.outcomeGeneration === 'string') {
				const importedEvents = importMaterializedOutcomeEvents(
					next,
					existingEvents,
				);
				const combinedIds = new Set(
					existingEvents
						.filter(
							(event) => event.generation === next.metadata.outcomeGeneration,
						)
						.map((event) => event.id),
				);
				for (const event of importedEvents) combinedIds.add(event.id);
				if (combinedIds.size > 1000) {
					throw new MemoryValidationError('memory outcome limit exceeded');
				}
				for (const event of importedEvents) {
					this.insertOutcomeEvent(event);
				}
			}
			next = materializeOutcomeRecord(base, this.readOutcomeEvents(next.id));
			this.insertEvent('upsert', next.id);
			if (ownsTransaction) db.run('COMMIT');
		} catch (error) {
			if (ownsTransaction) {
				try {
					db.run('ROLLBACK');
				} catch {
					// Preserve the upsert error when rollback also fails.
				}
			}
			throw error;
		}
		this.memories.set(next.id, next);
		await this.writeMemoryVec(next);
		this.bumpCohortGeneration();
		return next;
	}

	async get(id: string): Promise<MemoryRecord | null> {
		await this.initialize();
		const record = this.readMemoryById(id);
		if (record) this.memories.set(id, record);
		return record;
	}

	async appendOutcome(
		memoryId: string,
		event: { id: string; outcome: MemoryOutcome },
		anchors: MemoryAnchor[] = [],
	): Promise<MemoryRecord> {
		await this.initialize();
		let materialized: MemoryRecord | null = null;
		const db = this.requireDb();
		db.run('BEGIN IMMEDIATE');
		try {
			const row = this.requireDb()
				.query<MemoryItemRow, [string]>(
					'SELECT id, record_json FROM memory_items WHERE id = ? LIMIT 1',
				)
				.get(memoryId);
			if (!row) throw new MemoryValidationError('target memory was not found');
			let base = ensureOutcomeGeneration(
				validateMemoryRecordRules(JSON.parse(row.record_json), {
					rejectDurableSecrets: this.config.redaction.rejectDurableSecrets,
				}),
			);
			if (base.metadata.deleted === true) {
				throw new MemoryValidationError('target memory is deleted');
			}
			base = stripMaterializedOutcomes(base);
			this.writeMemory(base);
			const nextEvent = validateOutcomeEvent({
				...event,
				memoryId,
				generation: base.metadata.outcomeGeneration,
				anchors,
			});
			const events = this.readOutcomeEvents(memoryId);
			assertEventIdentityCompatible(
				events.find((candidate) => candidate.id === nextEvent.id),
				nextEvent,
			);
			if (
				events.filter(
					(candidate) => candidate.generation === nextEvent.generation,
				).length >= 1000 &&
				!events.some((candidate) => candidate.id === nextEvent.id)
			) {
				throw new MemoryValidationError('memory outcome limit exceeded');
			}
			this.insertOutcomeEvent(nextEvent);
			materialized = materializeOutcomeRecord(
				base,
				this.readOutcomeEvents(memoryId),
			);
			db.run('COMMIT');
		} catch (error) {
			try {
				db.run('ROLLBACK');
			} catch {
				// Preserve the append error when rollback also fails.
			}
			throw error;
		}
		if (!materialized) throw new Error('outcome append did not complete');
		this.memories.set(memoryId, materialized);
		this.bumpCohortGeneration();
		return materialized;
	}

	async listOutcomeEvents(): Promise<MemoryOutcomeEvent[]> {
		await this.initialize();
		return this.readOutcomeEvents();
	}

	async withTransaction<T>(
		fn: (tx: MemoryTransaction) => Promise<T> | T,
	): Promise<T> {
		const db = this.requireDb();
		// bun:sqlite's db.transaction() commits at the end of the SYNCHRONOUS
		// frame, so an async callback's awaited writes would run AFTER COMMIT —
		// silently outside any transaction. Use a manual BEGIN/COMMIT/ROLLBACK
		// and await the callback so, in this single-threaded process, every
		// awaited write runs sequentially between BEGIN and COMMIT (real
		// atomicity). See M2.
		if (db.inTransaction) {
			// Already inside a transaction (nested call): SQLite has no nested
			// BEGIN, so just run the callback within the outer transaction.
			return await fn({});
		}
		db.run('BEGIN IMMEDIATE');
		try {
			const result = await fn({});
			db.run('COMMIT');
			return result;
		} catch (err) {
			try {
				db.run('ROLLBACK');
			} catch {
				// Ignore rollback failures (e.g. transaction already aborted);
				// surface the original error below.
			}
			throw err;
		}
	}

	async delete(id: string, reason?: string): Promise<void> {
		await this.initialize();
		const existing = this.readMemoryById(id);
		if (!existing) return;
		if (this.config.hardDelete) {
			const db = this.requireDb();
			db.run('BEGIN IMMEDIATE');
			try {
				db.run('DELETE FROM memory_outcomes WHERE memory_id = ?', [id]);
				db.run('DELETE FROM memory_items WHERE id = ?', [id]);
				this.deleteMemoryFts(id);
				this.deleteMemoryVec(id);
				this.insertEvent('delete', id, reason);
				db.run('COMMIT');
			} catch (error) {
				try {
					db.run('ROLLBACK');
				} catch {
					// Preserve the deletion error when rollback also fails.
				}
				throw error;
			}
			this.memories.delete(id);
			this.bumpCohortGeneration();
			return;
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

		// ── Disabled-path guard: byte-identical to the legacy lexical-only flow ──
		// When embeddings are off (config flag, vec extension, or provider missing),
		// execute the existing path verbatim so golden fixtures pass unchanged.
		if (
			!this.config.embeddings.enabled ||
			!this.vecAvailable ||
			!this.embeddingProvider
		) {
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
				this.config.qLearning,
			);
			const reranked = candidates.ftsOrder
				? rerankWithFts(result.items, candidates.ftsOrder)
				: result.items;
			// Fix 1 (C.1 reviewer fix): cap normal hits at maxItems, then append
			// the single explored item (if any) beyond the cap so exploration can
			// never evict a legitimate ranked hit.
			const disabledPathSliced = sliceRecallItemsWithExploration(
				reranked,
				request.maxItems,
			);
			return {
				items: disabledPathSliced,
				diagnostics: {
					...result.diagnostics,
					// Fix 3: derive exploredCount from what actually survived
					// slicing so the count always matches an item present in the
					// returned bundle.
					exploredCount: disabledPathSliced.some((item) => item.explored)
						? 1
						: 0,
					returnedCount: disabledPathSliced.length,
				},
			};
		}

		// ── Enabled path: lexical + dense RRF fusion ──
		const recallElapsedStart = Date.now();

		// Stage 1 – lexical (FTS5-ranked candidates, unchanged from legacy path).
		const scopedRecords = await this.list({
			scopes: request.scopes,
			kinds: request.kinds,
			includeExpired: request.includeExpired,
			limit: RECALL_CANDIDATE_LIMIT,
		});
		const lexicalCandidates = this.selectRecallCandidates(
			request,
			scopedRecords,
		);
		const lexicalResult = scoreMemoryRecordsWithDiagnostics(
			lexicalCandidates.records,
			request,
			this.config.qLearning,
		);
		const lexicalReranked = lexicalCandidates.ftsOrder
			? rerankWithFts(lexicalResult.items, lexicalCandidates.ftsOrder)
			: lexicalResult.items;
		// best-first id list for fusion (already sorted by score desc)
		const lexicalIds = lexicalReranked.map((item) => item.record.id);

		// Stage 2 – dense (sqlite-vec kNN). Non-fatal fallback to lexical-only on
		// EmbeddingVersionMismatchError or any provider failure.
		let denseIds: string[] = [];
		try {
			const modelVersion = this.embeddingProvider.modelVersion;
			const normalizedQuery = normalizeMemoryText(request.query).toLowerCase();
			let queryEmbedding =
				this.embeddingCache?.get(modelVersion, normalizedQuery)?.vector ?? null;
			if (queryEmbedding === null) {
				queryEmbedding = await this.embeddingProvider.embed(normalizedQuery);
				this.embeddingCache?.set(modelVersion, normalizedQuery, {
					vector: queryEmbedding,
					modelVersion,
					queryHash: normalizedQuery,
				});
			}
			const denseRecords = await this.selectDenseCandidates(
				request,
				queryEmbedding,
			);
			denseIds = denseRecords.map((record) => record.id);
		} catch (err) {
			if (
				err instanceof EmbeddingVersionMismatchError ||
				err instanceof EmbeddingUnavailableError
			) {
				warn('Dense retrieval failed — falling back to lexical-only', {
					reason: err instanceof Error ? err.message : String(err),
				});
			} else {
				warn('Dense retrieval failed — falling back to lexical-only', {
					reason: err instanceof Error ? err.message : String(err),
				});
			}
			// True lexical-only fallback — identical shape to the disabled path.
			// Fix 1 (C.1 reviewer fix): additive maxItems slice (see above).
			const denseFailedSliced = sliceRecallItemsWithExploration(
				lexicalReranked,
				request.maxItems,
			);
			return {
				items: denseFailedSliced,
				diagnostics: {
					...lexicalResult.diagnostics,
					// Fix 3: derive exploredCount from what actually survived
					// slicing.
					exploredCount: denseFailedSliced.some((item) => item.explored)
						? 1
						: 0,
					returnedCount: denseFailedSliced.length,
				},
			};
		}

		// Stage 3 – metadata ranking (scope/kind match from lexical candidates).
		const metadataIds = buildMetadataRankedIds(lexicalReranked, request);

		// Stage 4 – fuse via RRF.
		const weights: FusionWeights = this.config.retrieval.weights;
		const rrfK = this.config.retrieval.rrfK;
		const fused = fuseRankings(
			lexicalIds,
			denseIds,
			metadataIds,
			weights,
			rrfK,
		);

		// Stage 5 – map back to RecallResultItem with normalised fusedScore.
		// Build a lookup from the lexical-scored items (carry forward their signals).
		const lexicalItemMap = new Map(
			lexicalReranked.map((item) => [item.record.id, item]),
		);
		const minScore = request.minScore ?? this.config.recall.minScore;
		const fusedItems: RecallResultItem[] = [];
		for (const candidate of fused) {
			// C.1 additivity caveat (known limitation G-1/G-3): a C.1 `explored`
			// item entered `fuseRankings` above as an ordinary lexical candidate,
			// so (a) it is subject to THIS `minScore` re-gate like any hit — under
			// default embeddings it can normalise below the gate and be dropped
			// (G-1), and (b) its presence can nudge a boundary-scored normal hit
			// below the gate (G-3). The additive `sliceRecallItemsWithExploration`
			// guarantee holds at the final slice, not through this RRF re-gate.
			if (candidate.fusedScore < minScore) continue;
			const lexicalItem = lexicalItemMap.get(candidate.id);
			if (lexicalItem) {
				fusedItems.push({
					record: lexicalItem.record,
					score: candidate.fusedScore,
					reason: `${lexicalItem.reason}, rrf_fused=${candidate.fusedScore.toFixed(4)}`,
					signals: lexicalItem.signals,
					// Fix 2 (C.1 reviewer fix): carry the C.1 explored flag from
					// the source lexical item — this reconstruction otherwise
					// drops it, silently un-flagging an explored item that
					// survives fusion.
					...(lexicalItem.explored ? { explored: true } : {}),
				});
			} else {
				// Dense-only hit: look up the record directly.
				const record = this.memories.get(candidate.id);
				if (record) {
					fusedItems.push({
						record,
						score: candidate.fusedScore,
						reason: `rrf_fused=${candidate.fusedScore.toFixed(4)}`,
						signals: {
							textOverlap: 0,
							tagOverlap: 0,
							fileOverlap: 0,
							symbolOverlap: 0,
							kindMatch: false,
							scopeMatch: false,
						},
					});
				}
			}
		}

		// ── Stage 6 – cross-encoder rerank (enabled path only, latency-gated) ──
		const previousRecallElapsedMs = Date.now() - recallElapsedStart;
		let rerankedItems = fusedItems;
		if (
			this.config.retrieval.rerank.enabled &&
			shouldRerank(
				previousRecallElapsedMs,
				this.config.retrieval.latencyBudgetMs,
			)
		) {
			try {
				if (!this.reranker) {
					this.reranker = new CrossEncoderReranker({
						model: this.config.retrieval.rerank.model,
					});
				}
				const topN = Math.min(20, fusedItems.length);
				const rerankCandidates: RerankCandidate[] = fusedItems
					.slice(0, topN)
					.map((item) => ({
						id: item.record.id,
						text: item.record.text,
						score: item.score,
					}));
				const rerankResult = await this.reranker.rerank(
					rerankCandidates,
					request.query,
					topN,
				);
				// Reorder ONLY the top-N prefix by the reranker's returned order.
				// The untouched tail (candidates beyond topN) is appended after the
				// reranked prefix in their original fused order, so unreranked
				// candidates can never precede reranked ones.
				const topNPrefix = fusedItems.slice(0, topN);
				const tail = fusedItems.slice(topN);
				const rerankOrder = new Map(rerankResult.map((c, idx) => [c.id, idx]));
				const reorderedTopN = [...topNPrefix].sort(
					(a, b) =>
						(rerankOrder.get(a.record.id) ?? 0) -
						(rerankOrder.get(b.record.id) ?? 0),
				);
				rerankedItems = [...reorderedTopN, ...tail];
			} catch (err) {
				warn('Rerank failed — returning fused order', {
					reason: err instanceof Error ? err.message : String(err),
				});
				rerankedItems = fusedItems;
			}
		}

		// Fix 1 (C.1 reviewer fix): cap normal hits at maxItems, then append the
		// single explored item (if any — and if it survived the fusion minScore
		// gate above, see Stage 5) beyond the cap.
		const fusionSliced = sliceRecallItemsWithExploration(
			rerankedItems,
			request.maxItems,
		);
		return {
			items: fusionSliced,
			diagnostics: {
				...lexicalResult.diagnostics,
				// Fix 3: derive exploredCount from what actually survived fusion
				// AND slicing, not the pre-fusion lexical diagnostics — the
				// fusion minScore re-gate (Stage 5) can independently drop the
				// explored item on its own normalised-score scale, so
				// `lexicalResult.diagnostics.exploredCount` alone is not a
				// reliable signal of what is actually present here.
				exploredCount: fusionSliced.some((item) => item.explored) ? 1 : 0,
				returnedCount: fusionSliced.length,
				fusionActive: true,
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
				usage_json,
				run_id,
				unit_id
			) VALUES (?, ?, ?, ?, ?, ?)`,
			[
				randomUUID(),
				event.bundleId,
				event.timestamp,
				JSON.stringify(event),
				event.runId ?? null,
				event.unitId ?? null,
			],
		);
		this.recallCountSinceLastCompaction++;
		const threshold = this.config.maintenance?.autoCompactEveryNRecalls ?? 50;
		if (
			threshold > 0 &&
			this.recallCountSinceLastCompaction >= threshold &&
			!this.isCompacting
		) {
			// Counter is intentionally reset BEFORE compaction runs. If compaction fails,
			// the next trigger fires after N more recalls. This avoids tight retry loops.
			this.recallCountSinceLastCompaction = 0;
			this.isCompacting = true;
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
						// biome-ignore lint/suspicious/noConsole: Debug-only auto-compaction failure log — only emits when OPENCODE_SWARM_DEBUG=1 is set
						console.debug(`[memory] auto-compaction failed: ${err}`);
					}
				})
				.finally(() => {
					this.isCompacting = false;
				});
		}
	}

	async listRecallUsage(
		filter: MemoryRecallUsageFilter = {},
	): Promise<MemoryRecallUsageEvent[]> {
		await this.initialize();

		const conditions: string[] = [];
		const params: SQLQueryBindings[] = [];
		if (typeof filter.runId === 'string' && filter.runId.length > 0) {
			conditions.push('run_id = ?');
			params.push(filter.runId);
		}
		if (typeof filter.unitId === 'string' && filter.unitId.length > 0) {
			conditions.push('unit_id = ?');
			params.push(filter.unitId);
		}
		if (typeof filter.since === 'string' && filter.since.length > 0) {
			conditions.push('timestamp >= ?');
			params.push(filter.since);
		}
		const whereClause =
			conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';

		let sql = `SELECT usage_json FROM memory_recall_usage${whereClause} ORDER BY timestamp DESC`;
		if (typeof filter.limit === 'number') {
			sql += ' LIMIT ?';
			params.push(Math.max(1, Math.trunc(filter.limit)));
		}

		const rows = this.requireDb()
			.query<RecallUsageRow, SQLQueryBindings[]>(sql)
			.all(...params);
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

	async appendRewardEvent(event: Omit<MemoryRewardEvent, 'id'>): Promise<void> {
		await this.initialize();
		this.requireDb().run(
			`INSERT INTO memory_reward_events (
				id,
				memory_id,
				run_id,
				unit_id,
				verdict,
				reward,
				q_before,
				q_after,
				verdict_synthesis_json,
				timestamp
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				randomUUID(),
				event.memoryId,
				event.runId ?? null,
				event.unitId ?? null,
				event.verdict,
				event.reward,
				event.qBefore ?? null,
				event.qAfter ?? null,
				event.verdictSynthesisJson ?? null,
				event.timestamp,
			],
		);
	}

	async listRewardEvents(
		filter: MemoryRewardEventFilter = {},
	): Promise<MemoryRewardEvent[]> {
		await this.initialize();

		const conditions: string[] = [];
		const params: SQLQueryBindings[] = [];
		if (typeof filter.memoryId === 'string' && filter.memoryId.length > 0) {
			conditions.push('memory_id = ?');
			params.push(filter.memoryId);
		}
		const whereClause =
			conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';

		let sql = `SELECT
			id,
			memory_id,
			run_id,
			unit_id,
			verdict,
			reward,
			q_before,
			q_after,
			verdict_synthesis_json,
			timestamp
		FROM memory_reward_events${whereClause} ORDER BY timestamp DESC`;
		if (typeof filter.limit === 'number') {
			sql += ' LIMIT ?';
			params.push(Math.max(1, Math.trunc(filter.limit)));
		}

		const rows = this.requireDb()
			.query<RewardEventRow, SQLQueryBindings[]>(sql)
			.all(...params);
		return rows.map((row) => ({
			id: row.id,
			memoryId: row.memory_id,
			runId: row.run_id ?? undefined,
			unitId: row.unit_id ?? undefined,
			verdict: row.verdict,
			reward: row.reward,
			qBefore: row.q_before ?? undefined,
			qAfter: row.q_after ?? undefined,
			verdictSynthesisJson: row.verdict_synthesis_json ?? undefined,
			timestamp: row.timestamp,
		}));
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

		let sql = `SELECT id, record_json FROM memory_items ${whereClause} ORDER BY updated_at DESC, id ASC`;

		if (typeof filter.limit === 'number') {
			sql += ' LIMIT ?';
			params.push(Math.trunc(filter.limit));
		}

		const rows = db
			.query<MemoryItemRow, SQLQueryBindings[]>(sql)
			.all(...params);
		const outcomeEvents = this.readOutcomeEventsForMemoryIds(
			rows.map((row) => row.id),
		);

		let records: MemoryRecord[] = [];
		for (const row of rows) {
			const parsed = this.parseMemoryRow(row, outcomeEvents);
			if (parsed) {
				records.push(parsed);
				this.memories.set(parsed.id, parsed);
			}
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
		for (const memory of result.memories) {
			if (memory.metadata.deleted !== true) {
				await this.writeMemoryVec(memory);
			}
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
		// Migration-phase state belongs to the closed connection's init run.
		this.eventChainReadyCache = false;
		this.databaseStartedFresh = false;
		this.migrationsComplete = false;
		this.freshInitMigrationEvents = [];
	}

	/**
	 * #1850 (critic CONCERN-3): checkpoint the WAL into the main DB, then
	 * close the handle. Used by the memory family migration engine before it
	 * copies the DB file, so the copy reflects all committed writes and is not
	 * mid-checkpoint. After this call, the provider is closed and must be
	 * re-opened (the migration engine re-creates it via the pool).
	 *
	 * Returns the absolute paths to copy: `memory.db` plus any non-empty
	 * `-wal`/`-shm` sidecars (after a TRUNCATE checkpoint the WAL is typically
	 * empty; if it is not, copying it alongside the DB is still correct because
	 * SQLite recovers from WAL on next open).
	 */
	checkpointCloseSnapshot(): {
		dbPath: string;
		walPath: string | null;
		shmPath: string | null;
	} {
		const dbPath = this.databasePath();
		let walPath: string | null = null;
		let shmPath: string | null = null;
		try {
			if (this.db) {
				try {
					this.db.run('PRAGMA wal_checkpoint(TRUNCATE);');
				} catch {
					/* non-fatal — close will still produce a consistent DB */
				}
				this.db.close();
				this.db = null;
				this.ftsAvailable = false;
				this.initialized = false;
				this.initPromise = null;
			}
			// Stat the sidecars; include only non-empty ones.
			try {
				const wal = `${dbPath}-wal`;
				const st = statSync(wal);
				if (st.size > 0) walPath = wal;
			} catch {
				/* no WAL sidecar */
			}
			try {
				const shm = `${dbPath}-shm`;
				const st = statSync(shm);
				if (st.size > 0) shmPath = shm;
			} catch {
				/* no SHM sidecar */
			}
		} catch {
			/* best-effort */
		}
		return { dbPath, walPath, shmPath };
	}

	/**
	 * Re-embed all durable memory records with the current embedding provider
	 * model, update the stored global model_version, and clear the embedding
	 * cache. This is the recovery path for EmbeddingVersionMismatchError.
	 *
	 * No-op (with a warning) when vec or the embedding provider is unavailable.
	 * Individual record failures are caught per-record so one bad embedding
	 * does not abort the whole rebuild.
	 */
	async rebuildEmbeddingIndex(): Promise<void> {
		await this.initialize();
		if (!this.vecAvailable || !this.embeddingProvider) {
			warn(
				'rebuildEmbeddingIndex skipped — sqlite-vec or embedding provider not available',
			);
			return;
		}

		const currentVersion = this.embeddingProvider.modelVersion;
		const durableRecords = Array.from(this.memories.values()).filter(
			(record) =>
				DURABLE_MEMORY_KINDS.has(record.kind) &&
				record.metadata.deleted !== true &&
				record.supersededBy === undefined &&
				record.stability !== 'ephemeral',
		);

		let successCount = 0;
		let failureCount = 0;
		const db = this.requireDb();

		// Per-record embedding with try/catch so one failure doesn't abort the rebuild.
		for (const record of durableRecords) {
			try {
				const normalizedText = normalizeMemoryText(record.text).toLowerCase();
				if (normalizedText.length === 0) continue;
				const vector = await this.embeddingProvider.embed(normalizedText);
				db.run(
					'INSERT OR REPLACE INTO memory_items_vec (id, embedding) VALUES (?, ?)',
					[record.id, vector],
				);
				successCount++;
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				warn('rebuildEmbeddingIndex: failed to embed record', {
					id: record.id,
					reason,
				});
				failureCount++;
			}
		}

		// Only advance the version if ALL records re-embedded successfully.
		// Partial rebuilds leave old-version vectors; the mismatch guard will
		// signal the incomplete rebuild on next query.
		if (failureCount === 0) {
			db.run(
				'INSERT OR REPLACE INTO embedding_config (key, value) VALUES (?, ?)',
				['model_version', currentVersion],
			);
		}

		// Clear the embedding cache so stale vectors from the previous index
		// are not served on subsequent recall queries.
		this.embeddingCache?.clear();

		if (failureCount > 0) {
			warn('rebuildEmbeddingIndex completed with failures', {
				successCount,
				failureCount,
				total: durableRecords.length,
			});
		}
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
		outcomesPath: string;
		memories: number;
		proposals: number;
		outcomes: number;
	}> {
		await this.initialize();
		const memories = await this.list({
			includeExpired: true,
			includeInactive: true,
		});
		const proposals = await this.listProposals();
		const outcomeEvents = this.readOutcomeEvents();
		const output = await writeJsonlExport(
			this.rootDirectory,
			this.config,
			memories,
			proposals,
			outcomeEvents,
		);
		return {
			...output,
			memories: memories.length,
			proposals: proposals.length,
			outcomes: outcomeEvents.length,
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
				db.run('DELETE FROM memory_outcomes WHERE memory_id = ?', [id]);
				db.run('DELETE FROM memory_items WHERE id = ?', [id]);
				this.deleteMemoryFts(id);
				this.deleteMemoryVec(id);
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

	private getStoredModelVersion(): string | null {
		const row = this.requireDb()
			.query<{ value: string }, [string]>(
				// Parameterized (was a hard-coded key literal): node:sqlite rejects a
				// bound param when the SQL has no placeholder ("column index out of
				// range"), unlike bun:sqlite which tolerates it (issue #1873).
				`SELECT value FROM embedding_config WHERE key = ? LIMIT 1`,
			)
			.get('model_version');
		return row?.value ?? null;
	}

	private async selectDenseCandidates(
		request: RecallRequest,
		queryEmbedding: Float32Array,
	): Promise<MemoryRecord[]> {
		if (
			!this.config.embeddings.enabled ||
			!this.vecAvailable ||
			!this.embeddingProvider
		) {
			return [];
		}

		const storedVersion = this.getStoredModelVersion();
		const queryVersion = this.embeddingProvider.modelVersion;
		if (storedVersion !== null && storedVersion !== queryVersion) {
			throw new EmbeddingVersionMismatchError(queryVersion, storedVersion);
		}

		// Oversample the KNN to mitigate post-filter scope/kind recall loss —
		// we fetch max(100, 20×maxItems) neighbors then filter by
		// scope/kind/superseded/deleted/expired (mirroring lexical scoping).
		// For tight scope filters this oversampling reduces (but may not
		// eliminate) recall loss; pre-filtering via vec0 WHERE is a future improvement.
		const k = Math.max(100, request.maxItems * 20);
		const rows = this.requireDb()
			.query<{ id: string; distance: number }, SQLQueryBindings[]>(
				`SELECT id, distance FROM memory_items_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
			)
			.all(queryEmbedding, k);

		const scopeKeys = request.scopes?.map((s) => stableScopeKey(s)) ?? [];
		const kinds = request.kinds ?? [];
		const includeInactive = false;
		const includeExpired = request.includeExpired ?? false;

		const allowedIds = new Set<string>();
		for (const record of this.memories.values()) {
			if (
				scopeKeys.length > 0 &&
				!scopeKeys.includes(stableScopeKey(record.scope))
			)
				continue;
			if (kinds.length > 0 && !kinds.includes(record.kind)) continue;
			if (!includeInactive && record.supersededBy) continue;
			if (!includeInactive && record.metadata.deleted === true) continue;
			if (!includeExpired && record.expiresAt) {
				const expires = Date.parse(record.expiresAt);
				if (Number.isFinite(expires) && expires <= Date.now()) continue;
			}
			allowedIds.add(record.id);
		}

		const results: MemoryRecord[] = [];
		for (const row of rows) {
			if (!allowedIds.has(row.id)) continue;
			const record = this.memories.get(row.id);
			if (record) results.push(record);
		}
		return results;
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
		// #1466: a database whose migrations start from version 0 is freshly
		// created — its ONLY event rows are the migration events inserted
		// below, which the hash-chain backfill can chain from the in-memory
		// log without an extra table scan (see backfillEventHashChain).
		this.databaseStartedFresh = currentVersion === 0;
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
		// #1466: every migration-phase event (including v13's own, whose
		// marker row is inserted before its event fires) inserts UNCHAINED
		// and is chained deterministically by backfillEventHashChain —
		// otherwise v13's event would anchor at GENESIS above unchained rows.
		this.migrationsComplete = true;
	}

	private backfillScopeKeys(): void {
		const db = this.requireDb();

		// One-time guard: skip if backfill was already completed in a prior init.
		const metaRow = db
			.query<{ value: string }, [string]>(
				// Parameterized — see getStoredModelVersion (issue #1873): a bound
				// param against a placeholder-less query throws under node:sqlite.
				'SELECT value FROM _meta WHERE key = ?',
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

	private backfillRecallRunIds(): void {
		const db = this.requireDb();

		// One-time guard: skip if backfill was already completed in a prior init.
		const metaRow = db
			.query<{ value: string }, [string]>(
				// Parameterized — see getStoredModelVersion (issue #1873): a bound
				// param against a placeholder-less query throws under node:sqlite.
				'SELECT value FROM _meta WHERE key = ?',
			)
			.get('recall_run_id_backfilled');
		if (metaRow?.value === '1') return;

		const rows = db
			.query<{ id: string; usage_json: string }, []>(
				'SELECT id, usage_json FROM memory_recall_usage WHERE run_id IS NULL',
			)
			.all();
		let backfillCount = 0;
		for (const row of rows) {
			try {
				const parsed = JSON.parse(row.usage_json) as { runId?: string };
				if (typeof parsed.runId === 'string' && parsed.runId.length > 0) {
					db.run('UPDATE memory_recall_usage SET run_id = ? WHERE id = ?', [
						parsed.runId,
						row.id,
					]);
					backfillCount++;
				}
			} catch {
				// Skip unparseable rows — they'll remain with run_id = NULL
			}
		}
		if (backfillCount > 0) {
			this.insertEvent(
				'migration',
				'backfill_recall_run_ids',
				`${backfillCount} memory_recall_usage row(s) run_id backfilled from usage_json`,
			);
		}

		// Stamp completion so this full-table scan runs only once.
		db.run(
			"INSERT OR REPLACE INTO _meta (key, value) VALUES ('recall_run_id_backfilled', '1')",
		);
	}

	/**
	 * #1466 (migration v12 follow-up): backfill `valid_from` for pre-v12 rows
	 * from the record's createdAt (fallback: updated_at). source_task_id /
	 * agent_role / embedding_model_version keep their ALTER TABLE defaults per
	 * the issue's backfill note — migration must not fail on missing data.
	 *
	 * Implemented as a single JSON1 statement (no per-row loop) and executed
	 * via run(): bun's per-Database QUERY cache is strictly bounded (~20
	 * statements, bun 1.3.x) and EVICTED entries are never finalized on close
	 * — on Windows that keeps memory.db locked after close() until GC. run()
	 * does not use that cache; keep new db.query() SQL strings to a minimum.
	 */
	private backfillProvenanceColumns(): void {
		const db = this.requireDb();
		const metaRow = db
			.query<{ value: string }, [string]>(
				'SELECT value FROM _meta WHERE key = ?',
			)
			.get('provenance_columns_backfilled');
		if (metaRow?.value === '1') return;
		let backfillCount = 0;
		try {
			const result = db.run(`
				UPDATE memory_items
				SET valid_from = COALESCE(
					json_extract(record_json, '$.createdAt'),
					json_extract(record_json, '$.updatedAt')
				)
				WHERE valid_from IS NULL
			`);
			backfillCount = Number(result?.changes ?? 0);
		} catch {
			// JSON1 unavailable (non-standard build) — fall back to a bounded
			// TS loop via run() (still no query-cache pressure).
			const rows = db
				.query<{ id: string; record_json: string }, []>(
					'SELECT id, record_json FROM memory_items WHERE valid_from IS NULL',
				)
				.all();
			for (const row of rows) {
				try {
					const record = JSON.parse(row.record_json) as {
						createdAt?: string;
						updatedAt?: string;
					};
					const validFrom = record.createdAt ?? record.updatedAt ?? null;
					if (validFrom) {
						db.run('UPDATE memory_items SET valid_from = ? WHERE id = ?', [
							validFrom,
							row.id,
						]);
						backfillCount++;
					}
				} catch {
					// Skip unparseable rows — they keep valid_from NULL
				}
			}
		}
		if (backfillCount > 0) {
			this.insertEvent(
				'migration',
				'backfill_provenance_columns',
				`${backfillCount} memory item(s) valid_from backfilled from record createdAt`,
			);
		}
		db.run(
			"INSERT OR REPLACE INTO _meta (key, value) VALUES ('provenance_columns_backfilled', '1')",
		);
	}

	/**
	 * #1466 (migration v13 follow-up): deterministically chain all existing
	 * event rows (first row anchored to GENESIS, row n prev_hash = hash of the
	 * full row n-1). Recomputes from row content only — existing prev_hash
	 * values are ignored — so a crash mid-backfill heals identically on the
	 * next init. The _meta head mirrors the last row's hash so last-row
	 * tampering is detectable.
	 */
	private backfillEventHashChain(): void {
		const db = this.requireDb();
		const metaRow = db
			.query<{ value: string }, [string]>(
				'SELECT value FROM _meta WHERE key = ?',
			)
			.get('event_hash_chain_backfilled');
		if (metaRow?.value === '1') return;
		let rows: (MemoryEventRow & { rowid: number })[];
		if (this.databaseStartedFresh) {
			// Fresh database: the only event rows are the migration events
			// logged in memory (rowids 1..n by construction). Chaining from
			// the log avoids loading the events SELECT into the bounded
			// query cache on every fresh provider lifecycle (tests create one
			// per case; see backfillProvenanceColumns for the cache cap).
			rows = this.freshInitMigrationEvents.map((row, i) => ({
				...row,
				rowid: i + 1,
			}));
		} else {
			rows = db
				.query<MemoryEventRow & { rowid: number }, []>(EVENT_CHAIN_SCAN_SQL)
				.all();
		}
		let prevHash: string | null = null;
		for (const row of rows) {
			const next = prevHash ?? EVENT_CHAIN_GENESIS;
			db.run('UPDATE memory_events SET prev_hash = ? WHERE rowid = ?', [
				next,
				row.rowid,
			]);
			// The stored row now carries its new prev_hash; hash THAT form.
			prevHash = memoryEventRowHash({ ...row, prev_hash: next });
		}
		if (prevHash !== null) {
			db.run(`INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)`, [
				MEMORY_EVENTS_CHAIN_HEAD_KEY,
				prevHash,
			]);
		}
		if (rows.length > 0) {
			this.insertEvent(
				'migration',
				'backfill_event_hash_chain',
				`${rows.length} memory_events row(s) chained deterministically`,
			);
		}
		db.run(
			"INSERT OR REPLACE INTO _meta (key, value) VALUES ('event_hash_chain_backfilled', '1')",
		);
	}

	/**
	 * #1466: `/swarm memory audit-verify` backend. Lazily recomputes the
	 * memory_events hash chain and the _meta head. Read-only.
	 */
	async verifyAuditChain(): Promise<MemoryAuditVerificationReport> {
		await this.initialize();
		const db = this.requireDb();
		// Shared scan constant — one query-cache slot with the backfill
		// (see EVENT_CHAIN_SCAN_SQL).
		const rows = db
			.query<MemoryEventRow & { rowid: number }, []>(EVENT_CHAIN_SCAN_SQL)
			.all();
		const headRow = db
			.query<{ value: string }, [string]>(
				'SELECT value FROM _meta WHERE key = ?',
			)
			.get(MEMORY_EVENTS_CHAIN_HEAD_KEY);
		return verifyMemoryEventChainRows(rows, headRow?.value ?? null);
	}

	/**
	 * #1466: true once the memory_events.prev_hash column exists (migration
	 * v13 applied). Memoized positive — the column never disappears — so the
	 * schema probe runs only until the first success.
	 */
	private eventChainReadyCache = false;
	private eventChainColumnReady(): boolean {
		if (this.eventChainReadyCache) return true;
		// Ordinary schema_migrations read (via hasMigration) — deliberately NOT
		// a pragma_table_info probe: its prepared statement survives
		// db.close() until GC on Windows (bun 1.3.14) and keeps the database
		// file locked, breaking temp-dir cleanup in tests and any caller that
		// closes and immediately moves/deletes the store.
		this.eventChainReadyCache = this.hasMigration(
			EVENT_CHAIN_SCHEMA_MIGRATION_NAME,
		);
		return this.eventChainReadyCache;
	}

	/** #1466: gateway-emitted audit events (PII rejection). */
	async recordEvent(
		operation: 'pii_rejected',
		targetId: string,
		reason?: string,
	): Promise<void> {
		await this.initialize();
		// insertEvent is synchronous today; the await keeps the throw-path
		// contract obvious if it ever becomes async (gateway callers wrap
		// this in try/catch around the await).
		await this.insertEvent(operation, targetId, reason);
	}

	/**
	 * #1466: embedding model version for provenance stamping. Empty when
	 * embeddings are not active for this database.
	 */
	private embeddingModelVersionStamp(): string {
		if (!this.config.embeddings.enabled) return '';
		if (this.embeddingProvider) return this.embeddingProvider.modelVersion;
		try {
			return this.getStoredModelVersion() ?? '';
		} catch {
			return '';
		}
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

	private initializeVecExtension(): void {
		const db = this.requireDb();
		try {
			const dimension = Math.max(
				1,
				Math.trunc(this.config.embeddings.dimension ?? 384),
			);
			const req = createRequire(import.meta.url);
			const pkgDir = path.dirname(
				req.resolve('@sqlite/sqlite-vec/package.json'),
			);
			const ext =
				process.platform === 'win32'
					? '.dll'
					: process.platform === 'darwin'
						? '.dylib'
						: '.so';
			const vec0Path = path.join(pkgDir, `vec0${ext}`);
			db.loadExtension(vec0Path);
			db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_items_vec USING vec0(
				id TEXT PRIMARY KEY, embedding FLOAT[${dimension}]
			)`);
			const modelVersion =
				this.config.embeddings.version ??
				`${this.config.embeddings.model}:${dimension}`;
			// Seed model_version only on first run; rebuildEmbeddingIndex() is the
			// sole path that advances it after re-embedding.
			db.run(
				'INSERT OR IGNORE INTO embedding_config (key, value) VALUES (?, ?)',
				['model_version', modelVersion],
			);
			this.vecAvailable = true;
		} catch (err) {
			this.vecAvailable = false;
			warn(
				'sqlite-vec extension not available — dense retrieval disabled',
				err,
			);
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
		const outcomeEvents = this.readOutcomeEvents();
		const rebuild = db.transaction(() => {
			db.run(`DELETE FROM ${FTS_TABLE_NAME}`);
			for (const row of this.iterateMemoryRows()) {
				const record = this.parseMemoryRow(row, outcomeEvents);
				if (record) {
					this.writeMemoryFts(record);
				}
			}
		});
		rebuild();
	}

	private countValidMemoryRows(): number {
		let count = 0;
		const outcomeEvents = this.readOutcomeEvents();
		for (const row of this.iterateMemoryRows()) {
			if (this.parseMemoryRow(row, outcomeEvents)) count++;
		}
		return count;
	}

	private *iterateMemoryRows(): IterableIterator<MemoryItemRow> {
		yield* this.requireDb()
			.query<MemoryItemRow, []>('SELECT id, record_json FROM memory_items')
			.iterate();
	}

	private parseMemoryRow(
		row: MemoryItemRow,
		outcomeEvents?: readonly MemoryOutcomeEvent[],
	): MemoryRecord | null {
		try {
			const base = validateMemoryRecordRules(JSON.parse(row.record_json), {
				rejectDurableSecrets: this.config.redaction.rejectDurableSecrets,
			});
			return validateMemoryRecordRules(
				materializeOutcomeRecord(
					base,
					outcomeEvents ?? this.readOutcomeEvents(base.id),
				),
				{
					rejectDurableSecrets: this.config.redaction.rejectDurableSecrets,
				},
			);
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
		const outcomeEvents = this.readOutcomeEvents();
		let invalidCount = 0;
		for (const row of rows) {
			const record = this.parseMemoryRow(row, outcomeEvents);
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
		const stored = stripMaterializedOutcomes(record);
		this.requireDb().run(
			`INSERT INTO memory_items (
				id,
				scope_key,
				kind,
				updated_at,
				expires_at,
				superseded_by,
				deleted,
				record_json,
				source_task_id,
				agent_role,
				embedding_model_version,
				valid_from,
				supersedes_reason
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				scope_key = excluded.scope_key,
				kind = excluded.kind,
				updated_at = excluded.updated_at,
				expires_at = excluded.expires_at,
				superseded_by = excluded.superseded_by,
				deleted = excluded.deleted,
				record_json = excluded.record_json,
				source_task_id = excluded.source_task_id,
				agent_role = excluded.agent_role,
				embedding_model_version = excluded.embedding_model_version,
				-- #1466: valid_from records when this memory became
				-- authoritative; a re-write of the same id must not reset it.
				valid_from = memory_items.valid_from,
				supersedes_reason = COALESCE(excluded.supersedes_reason, memory_items.supersedes_reason)`,
			[
				stored.id,
				stableScopeKey(stored.scope),
				stored.kind,
				stored.updatedAt,
				stored.expiresAt ?? null,
				stored.supersededBy ?? null,
				stored.metadata.deleted === true ? 1 : 0,
				// PR #2310 feedback PRR-006: record_json deliberately OMITS the
				// #1466 provenance fields — they live in the dedicated columns.
				// The pre-PR MemoryRecordSchema is .strict(); persisting unknown
				// keys would make every post-upgrade record invisible to an
				// older binary (rollback / stale-cache installs) on load.
				// Columns stay populated from the in-memory record below.
				JSON.stringify(toLegacyCompatibleRecordJson(stored)),
				// #1466 provenance denormalization.
				stored.sourceTaskId ?? '',
				stored.producerAgentRole ?? 'unknown',
				this.embeddingModelVersionStamp(),
				stored.validFrom ?? null,
				stored.supersedesReason ?? null,
			],
		);
		this.writeMemoryFts(stored);
		// #1850 (critic CONCERN-1): bump the cohort generation marker so sibling
		// worktrees observe this write on their next revalidation. Bumped at the
		// provider layer so ALL write paths (propose, curator, finalize-reward,
		// direct upsert) invalidate peers. Local writes are no-ops. Best-effort:
		// a bump failure must never block the write.
		this.bumpCohortGeneration();
	}

	private readMemoryById(id: string): MemoryRecord | null {
		const row = this.requireDb()
			.query<MemoryItemRow, [string]>(
				'SELECT id, record_json FROM memory_items WHERE id = ? LIMIT 1',
			)
			.get(id);
		return row ? this.parseMemoryRow(row) : null;
	}

	private readOutcomeEvents(memoryId?: string): MemoryOutcomeEvent[] {
		const rows = memoryId
			? this.requireDb()
					.query<OutcomeEventRow, [string]>(
						'SELECT id, event_json FROM memory_outcomes WHERE memory_id = ? ORDER BY at ASC, id ASC',
					)
					.all(memoryId)
			: this.requireDb()
					.query<OutcomeEventRow, []>(
						'SELECT id, event_json FROM memory_outcomes ORDER BY at ASC, id ASC',
					)
					.all();
		const events: MemoryOutcomeEvent[] = [];
		for (const row of rows) {
			try {
				const event = validateOutcomeEvent(JSON.parse(row.event_json));
				if (event.id !== row.id) continue;
				events.push(event);
			} catch {
				// Invalid outcome rows are ignored like invalid legacy memory rows.
			}
		}
		return events;
	}

	private readOutcomeEventsForMemoryIds(
		memoryIds: readonly string[],
	): MemoryOutcomeEvent[] {
		if (memoryIds.length === 0) return [];
		const events: MemoryOutcomeEvent[] = [];
		for (let offset = 0; offset < memoryIds.length; offset += 500) {
			const chunk = memoryIds.slice(offset, offset + 500);
			const placeholders = chunk.map(() => '?').join(', ');
			const rows = this.requireDb()
				.query<OutcomeEventRow, SQLQueryBindings[]>(
					`SELECT id, event_json FROM memory_outcomes WHERE memory_id IN (${placeholders}) ORDER BY at ASC, id ASC`,
				)
				.all(...chunk);
			for (const row of rows) {
				try {
					const event = validateOutcomeEvent(JSON.parse(row.event_json));
					if (event.id !== row.id) continue;
					events.push(event);
				} catch {
					// Invalid outcome rows are ignored like invalid legacy memory rows.
				}
			}
		}
		return events;
	}

	private insertOutcomeEvent(event: MemoryOutcomeEvent): void {
		const memoryRow = this.requireDb()
			.query<MemoryItemRow, [string]>(
				'SELECT id, record_json FROM memory_items WHERE id = ? LIMIT 1',
			)
			.get(event.memoryId);
		if (!memoryRow) {
			throw new MemoryValidationError('target memory was not found');
		}
		const memory = validateMemoryRecordRules(
			JSON.parse(memoryRow.record_json),
			{
				rejectDurableSecrets: this.config.redaction.rejectDurableSecrets,
			},
		);
		const validatedEvent = validateOutcomeEventForMemory(
			event,
			memory,
			this.config.redaction.rejectDurableSecrets,
		);
		const existing = this.requireDb()
			.query<OutcomeEventRow, [string]>(
				'SELECT id, event_json FROM memory_outcomes WHERE id = ? LIMIT 1',
			)
			.get(validatedEvent.id);
		if (existing) {
			assertEventIdentityCompatible(
				validateOutcomeEvent(JSON.parse(existing.event_json)),
				validatedEvent,
			);
			return;
		}
		this.requireDb().run(
			'INSERT INTO memory_outcomes (id, memory_id, generation, at, event_json) VALUES (?, ?, ?, ?, ?)',
			[
				validatedEvent.id,
				validatedEvent.memoryId,
				validatedEvent.generation,
				validatedEvent.outcome.at,
				JSON.stringify(validatedEvent),
			],
		);
	}

	/**
	 * #1850: write a monotonic generation marker so siblings re-open their
	 * in-memory mirror. Fire-and-forget; failures are non-fatal (peers simply
	 * revalidate on the next pointer-stat change or TTL expiry).
	 */
	private bumpCohortGeneration(): void {
		if (!this.cohortRoot) return;
		try {
			const markerPath = path.join(this.cohortRoot, 'memory.gen');
			writeFileSync(markerPath, String(Date.now()), 'utf-8');
		} catch {
			/* best-effort — peer revalidation has TTL + pointer-stat backstops */
		}
	}

	/**
	 * #1850 (reviewer important fix): read `memory-cohort-config.json` and fail
	 * closed if the stored provider/embedding/redaction fingerprint disagrees
	 * with this worktree's config (acceptance #10). Absent file = first link
	 * (permissive — the linker writes it immediately after migration). A
	 * malformed file is also permissive (fail-open never strands memory, but
	 * a mismatch is a hard error). #2062 F-012: a file whose `algorithm_version`
	 * is not the current one — or is present but uninterpretable — is permissive
	 * too, because cross-algorithm digests are not comparable. Both warn with a
	 * re-link instruction rather than reporting a config mismatch that does not
	 * exist.
	 */
	private assertCohortConfigFingerprint(): void {
		if (!this.cohortRoot) return;
		const configPath = path.join(this.cohortRoot, 'memory-cohort-config.json');
		if (!existsSync(configPath)) {
			// #1850 (M-010): absent config AFTER a cohort root is opened is
			// suspicious — the linker writes it before flipping the pointer.
			// Fail-open (do not strand memory) but surface a visible warning so
			// the operator knows config-coherence is not enforced for this open.
			warn(
				'[memory-cohort] cohort config fingerprint file is absent; config-coherence check skipped. Run `/swarm memory link` to re-establish the fingerprint.',
				{ cohortRoot: this.cohortRoot },
			);
			return;
		}
		try {
			const stored = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<
				string,
				unknown
			>;
			// #2062 F-012 (R3 fix): compare ALGORITHM versions before comparing
			// digests. An ABSENT `algorithm_version` means the file predates the
			// field, i.e. algorithm version 1 — NOT "whatever this build's current
			// version happens to be". Defaulting to the current version would make
			// this gate unfireable for legacy files the moment the version is
			// bumped, and would then byte-compare a v1 digest against a v2 expected
			// value and throw below.
			const versionCheck = classifyStoredFingerprintAlgorithmVersion(
				stored.algorithm_version,
			);
			if (versionCheck.status === 'unknown') {
				// Present but uninterpretable: the digest cannot be attributed to any
				// algorithm. Skip the compare rather than guessing "current" — a wrong
				// guess produces the misleading hard error below.
				warn(
					'[memory-cohort] cohort config has a present but non-numeric `algorithm_version`, so its fingerprint cannot be attributed to a known algorithm and the config-coherence check was skipped. Run `/swarm memory link` to rewrite the cohort fingerprint.',
					{
						cohortRoot: this.cohortRoot,
						storedVersion: stored.algorithm_version,
					},
				);
				return;
			}
			if (versionCheck.status === 'mismatch') {
				// Digests produced by different algorithms are not comparable, so a
				// byte compare here would report a config difference that does not
				// exist. Fail open (never strand memory over an algorithm bump alone)
				// but say exactly what happened and how to fix it.
				warn(
					`[memory-cohort] cohort config was fingerprinted with algorithm version ${versionCheck.storedVersion}, but this worktree computes version ${versionCheck.currentVersion}. Digests from different algorithm versions are not comparable, so the config-coherence check was skipped. Run \`/swarm memory link\` to refresh the cohort fingerprint.`,
					{
						cohortRoot: this.cohortRoot,
						storedVersion: versionCheck.storedVersion,
						expectedVersion: versionCheck.currentVersion,
					},
				);
				return;
			}
			const storedFingerprint = stored.fingerprint;
			if (typeof storedFingerprint !== 'string') {
				warn(
					'[memory-cohort] cohort config fingerprint file is malformed; config-coherence check skipped.',
					{ cohortRoot: this.cohortRoot },
				);
				return;
			}
			// #1850 (final-critic dedup): use the shared fingerprint helper so the
			// SQLite provider, status service, and linker all agree on the algorithm.
			const expectedFingerprint = computeMemoryCohortFingerprint(
				buildMemoryCohortFingerprintInput(this.config),
			);
			if (storedFingerprint !== expectedFingerprint) {
				throw new Error(
					`memory cohort config fingerprint mismatch: cohort expects ${storedFingerprint}, this worktree computes ${expectedFingerprint}. ` +
						'Provider/embedding/redaction config differs across cohort members. ' +
						'Run `/swarm memory unlink` to recover local state, or align configs across linked worktrees.',
				);
			}
		} catch (err) {
			if (
				err instanceof Error &&
				err.message.includes('fingerprint mismatch')
			) {
				throw err; // re-throw the mismatch — this is the fail-closed path
			}
			// malformed config file — fail-open with a warning (do not strand memory)
			warn(
				'[memory-cohort] failed to read cohort config fingerprint; config-coherence check skipped.',
				{
					cohortRoot: this.cohortRoot,
					reason: err instanceof Error ? err.message : String(err),
				},
			);
		}
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

	private async writeMemoryVec(record: MemoryRecord): Promise<void> {
		if (!this.config.embeddings.enabled) return;
		if (!this.vecAvailable) return;
		if (!this.embeddingProvider) return;
		if (!DURABLE_MEMORY_KINDS.has(record.kind)) return;
		if (record.stability === 'ephemeral') return;

		const normalizedText = normalizeMemoryText(record.text).toLowerCase();
		if (normalizedText.length === 0) return;

		try {
			const vector = await this.embeddingProvider.embed(normalizedText);
			this.requireDb().run(
				'INSERT OR REPLACE INTO memory_items_vec (id, embedding) VALUES (?, ?)',
				[record.id, vector],
			);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			if (err instanceof EmbeddingUnavailableError) {
				warn('Embedding provider unavailable during write — skipping vector', {
					reason,
				});
			} else {
				warn('Embedding computation failed — skipping vector', { reason });
			}
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

	private deleteMemoryVec(id: string): void {
		if (!this.vecAvailable) return;
		try {
			this.requireDb().run('DELETE FROM memory_items_vec WHERE id = ?', [id]);
		} catch {
			// vec table might not exist if vecAvailable was set true during init
			// but the extension is no longer loadable; degrade gracefully.
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
				// #1466: audit clarity for supersede chains — the reason is
				// denormalized onto BOTH records (and the memory_items columns).
				supersedesReason: decision.reason || undefined,
			});
			validateCuratorPromotableMemory(replacement);
			const superseded = this.validateDecisionMemory({
				...oldMemory,
				updatedAt: appliedAt,
				supersededBy: replacement.id,
				supersedesReason: decision.reason || undefined,
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
		const baseImportComplete = this.hasMigration(LEGACY_JSONL_MIGRATION_NAME);
		const storedOutcomeSignature = this.requireDb()
			.query<{ value: string }, [string]>(
				'SELECT value FROM _meta WHERE key = ? LIMIT 1',
			)
			.get(LEGACY_JSONL_OUTCOME_META_KEY)?.value;
		const currentOutcomeSignature = await getLegacyOutcomeJsonlSignature(
			this.rootDirectory,
			this.config,
		);
		const outcomeImportComplete =
			storedOutcomeSignature === currentOutcomeSignature;
		if (baseImportComplete && outcomeImportComplete) return;
		const backups = await backupLegacyJsonl(this.rootDirectory, this.config);
		const result = baseImportComplete
			? await this.importLegacyOutcomeRows()
			: await this.importLegacyJsonlRows();
		this.lastAutomaticJsonlMigration = result;
		if (!baseImportComplete) {
			this.markMigration(
				LEGACY_JSONL_MIGRATION_VERSION,
				LEGACY_JSONL_MIGRATION_NAME,
			);
		}
		this.requireDb().run(
			'INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)',
			[LEGACY_JSONL_OUTCOME_META_KEY, currentOutcomeSignature],
		);
		const report: JsonlMigrationReport = {
			migration: LEGACY_JSONL_MIGRATION_NAME,
			completedAt: new Date().toISOString(),
			skipped: false,
			importedMemories: result.importedMemories,
			importedProposals: result.importedProposals,
			importedOutcomes: result.importedOutcomes,
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
				importedOutcomes: result.importedOutcomes,
				invalidRows: result.invalidRows.length,
			}),
		);
	}

	private async importLegacyJsonlRows(): Promise<SQLiteJsonlImportResult> {
		const payload = await readLegacyJsonl(this.rootDirectory, this.config);
		const invalidRows = [...payload.invalidRows];
		const materializedRows: Array<{
			line: number;
			events: MemoryOutcomeEvent[];
		}> = [];
		for (const sourceRow of payload.memoryRows) {
			const rawRecord = sourceRow.record;
			const record =
				(rawRecord.outcomes?.length ?? 0) > 0
					? ensureOutcomeGeneration(rawRecord)
					: rawRecord;
			this.writeMemory(stripMaterializedOutcomes(record));
			if (typeof record.metadata.outcomeGeneration === 'string') {
				try {
					materializedRows.push({
						line: sourceRow.line,
						events: importMaterializedOutcomeEvents(
							record,
							payload.outcomeEvents,
						),
					});
				} catch (error) {
					invalidRows.push({
						file: 'memories.jsonl',
						line: sourceRow.line,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		}
		for (const proposal of payload.proposals) {
			this.writeProposal(proposal);
		}
		// Canonical rows are authoritative. Import them before projections from
		// legacy materialized snapshots so a same-id conflict is attributed to the
		// source memory row instead of rejecting the canonical event.
		let importedOutcomes = this.importLegacyOutcomeEventRows(
			payload.outcomeEventRows,
			invalidRows,
		);
		for (const row of materializedRows) {
			importedOutcomes += this.importLegacyMaterializedOutcomeRow(
				row,
				invalidRows,
			);
		}
		return {
			importedMemories: payload.memories.length,
			importedProposals: payload.proposals.length,
			importedOutcomes,
			invalidRows,
			totalRows: payload.totalRows,
		};
	}

	private importLegacyMaterializedOutcomeRow(
		row: { line: number; events: readonly MemoryOutcomeEvent[] },
		invalidRows: JsonlMigrationReport['invalidRows'],
	): number {
		if (row.events.length === 0) return 0;
		const db = this.requireDb();
		db.run('SAVEPOINT legacy_materialized_outcome_row');
		try {
			let imported = 0;
			for (const event of row.events) {
				const alreadyImported = this.hasOutcomeEvent(event.id);
				this.insertOutcomeEvent(event);
				if (!alreadyImported) imported++;
			}
			db.run('RELEASE SAVEPOINT legacy_materialized_outcome_row');
			return imported;
		} catch (error) {
			db.run('ROLLBACK TO SAVEPOINT legacy_materialized_outcome_row');
			db.run('RELEASE SAVEPOINT legacy_materialized_outcome_row');
			invalidRows.push({
				file: 'memories.jsonl',
				line: row.line,
				error: error instanceof Error ? error.message : String(error),
			});
			return 0;
		}
	}

	private async importLegacyOutcomeRows(): Promise<SQLiteJsonlImportResult> {
		const payload = await readLegacyJsonl(this.rootDirectory, this.config);
		const invalidRows = payload.invalidRows.filter(
			(row) => row.file === 'outcome-events.jsonl',
		);
		const importedOutcomes = this.importLegacyOutcomeEventRows(
			payload.outcomeEventRows,
			invalidRows,
		);
		return {
			importedMemories: 0,
			importedProposals: 0,
			importedOutcomes,
			invalidRows,
			totalRows:
				payload.outcomeEventRows.length +
				payload.invalidRows.filter((row) => row.file === 'outcome-events.jsonl')
					.length,
		};
	}

	private importLegacyOutcomeEventRows(
		rows: readonly { line: number; event: MemoryOutcomeEvent }[],
		invalidRows: JsonlMigrationReport['invalidRows'],
	): number {
		let imported = 0;
		for (const row of rows) {
			try {
				const alreadyImported = this.hasOutcomeEvent(row.event.id);
				this.insertOutcomeEvent(row.event);
				if (!alreadyImported) imported++;
			} catch (error) {
				invalidRows.push({
					file: 'outcome-events.jsonl',
					line: row.line,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return imported;
	}

	private hasOutcomeEvent(id: string): boolean {
		return Boolean(
			this.requireDb()
				.query<{ id: string }, [string]>(
					'SELECT id FROM memory_outcomes WHERE id = ? LIMIT 1',
				)
				.get(id),
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
		eventJson?: string,
		id = randomUUID(),
	): void {
		const db = this.requireDb();
		const timestamp = new Date().toISOString();
		const eventJsonValue =
			eventJson ?? (reason ? JSON.stringify({ reason }) : null);
		// Readiness is derived from schema_migrations via hasMigration AND
		// migration completion: during v13's own transaction the marker exists,
		// but that event (like every migration-phase event) must insert
		// unchained so backfillEventHashChain chains the whole phase
		// deterministically. Deliberately NOT a pragma_table_info probe — see
		// backfillProvenanceColumns for the bounded query-cache constraint on
		// db.query() strings.
		if (!this.migrationsComplete || !this.eventChainColumnReady()) {
			db.run(
				`INSERT INTO memory_events (
					id,
					operation,
					target_id,
					reason,
					timestamp,
					event_json
				) VALUES (?, ?, ?, ?, ?, ?)`,
				[id, operation, targetId, reason ?? null, timestamp, eventJsonValue],
			);
			// #1466: on a freshly created database these migration-phase rows
			// are the FIRST rows of an empty table, so their rowids are
			// deterministic (insertion order, 1-based). Record them so the
			// backfill can chain without a table scan (query-cache budget —
			// see backfillProvenanceColumns). On upgrades the backfill scans.
			if (this.databaseStartedFresh) {
				this.freshInitMigrationEvents.push({
					id,
					operation,
					target_id: targetId,
					reason: reason ?? null,
					timestamp,
					event_json: eventJsonValue,
					prev_hash: null,
				});
			}
			return;
		}
		// #1466: the read-tail + insert + head update must be atomic per event.
		// bun:sqlite on a single connection is synchronous (no in-process
		// interleaving); BEGIN IMMEDIATE additionally holds the write lock
		// across the sequence so a second PROCESS cannot chain off the same
		// tail between our read and INSERT. Follows the upsert() nesting
		// pattern: when called inside an outer transaction (e.g. migrations),
		// that transaction already provides the atomicity.
		//
		// PR-feedback FB-2 (PR #2310): the tail is read from `_meta` INSIDE
		// the transaction on EVERY insert — an earlier version cached it
		// in-process, which let two live providers on one database (cohort
		// siblings) each chain off a stale tail and permanently fork the
		// chain. Reading `_meta` reuses the existing `SELECT value FROM _meta
		// WHERE key = ?` statement (no new db.query() string — bounded
		// query-cache budget, see backfillProvenanceColumns) and costs one
		// indexed point-read inside a write transaction we already hold.
		const ownsTransaction = !db.inTransaction;
		if (ownsTransaction) db.run('BEGIN IMMEDIATE');
		try {
			const headRow = db
				.query<{ value: string }, [string]>(
					'SELECT value FROM _meta WHERE key = ?',
				)
				.get(MEMORY_EVENTS_CHAIN_HEAD_KEY);
			// Absent head (no chained rows yet) anchors the insert at GENESIS.
			const prevHash = headRow?.value ?? EVENT_CHAIN_GENESIS;
			db.run(
				`INSERT INTO memory_events (
					id,
					operation,
					target_id,
					reason,
					timestamp,
					event_json,
					prev_hash
				) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[
					id,
					operation,
					targetId,
					reason ?? null,
					timestamp,
					eventJsonValue,
					prevHash,
				],
			);
			const headHash = memoryEventRowHash({
				id,
				operation,
				target_id: targetId,
				reason: reason ?? null,
				timestamp,
				event_json: eventJsonValue,
				prev_hash: prevHash,
			});
			db.run(`INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)`, [
				MEMORY_EVENTS_CHAIN_HEAD_KEY,
				headHash,
			]);
			if (ownsTransaction) db.run('COMMIT');
		} catch (error) {
			if (ownsTransaction) {
				try {
					db.run('ROLLBACK');
				} catch {
					// Preserve the insert error when rollback also fails.
				}
			}
			throw error;
		}
	}

	/** #1466: see runMigrations / backfillEventHashChain (fresh-DB fast path). */
	private databaseStartedFresh = false;
	private migrationsComplete = false;
	private freshInitMigrationEvents: MemoryEventRow[] = [];

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
/**
 * PR #2310 feedback PRR-006: serialize a record for the sqlite
 * `record_json` column WITHOUT the #1466 provenance fields. Those fields are
 * persisted exclusively in the dedicated v12 columns; keeping them out of
 * record_json preserves load compatibility with older binaries whose strict
 * record schema does not know the keys (a rolled-back install would
 * otherwise silently drop every post-upgrade record on load). The
 * local-jsonl provider intentionally keeps the full record shape (it has no
 * columns); loading such files with an older binary remains a documented
 * limitation of the legacy/debug provider.
 */
function toLegacyCompatibleRecordJson(record: MemoryRecord): MemoryRecord {
	const {
		sourceTaskId: _sourceTaskId,
		embeddingModelVersion: _embeddingModelVersion,
		validFrom: _validFrom,
		supersedesReason: _supersedesReason,
		...legacy
	} = record;
	return legacy as MemoryRecord;
}

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

function buildMetadataRankedIds(
	lexicalItems: RecallResultItem[],
	request: RecallRequest,
): string[] {
	const scopeKeys = request.scopes?.map((s) => stableScopeKey(s)) ?? [];
	const kinds = new Set(request.kinds ?? []);
	const hasScopeFilter = scopeKeys.length > 0;
	const hasKindFilter = kinds.size > 0;

	const both: string[] = [];
	const scopeOnly: string[] = [];
	const kindOnly: string[] = [];
	const neither: string[] = [];

	for (const item of lexicalItems) {
		const scopeMatch =
			!hasScopeFilter || scopeKeys.includes(stableScopeKey(item.record.scope));
		const kindMatch = !hasKindFilter || kinds.has(item.record.kind);
		if (scopeMatch && kindMatch) both.push(item.record.id);
		else if (scopeMatch) scopeOnly.push(item.record.id);
		else if (kindMatch) kindOnly.push(item.record.id);
		else neither.push(item.record.id);
	}

	return [...both, ...scopeOnly, ...kindOnly, ...neither];
}

export const _test_exports = {
	splitSql,
	buildFtsQuery,
	extractFtsTerms,
	FTS_SCHEMA_MIGRATION_NAME,
	FTS_SCHEMA_MIGRATION_VERSION,
};
