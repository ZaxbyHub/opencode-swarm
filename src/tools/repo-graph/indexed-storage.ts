/**
 * Derived SQLite index for the repo dependency graph (issue #1534).
 *
 * `.swarm/repo-graph.json` stays the single authoritative document in BOTH
 * storage modes. When `repo_graph.storage === 'indexed'`, `saveGraph` also
 * maintains `.swarm/repo-memory.sqlite`, a *derived accelerator* whose only job
 * is to answer "give me the neighbourhood of these files" without parsing the
 * whole JSON document. It returns an ordinary `RepoGraph` value that is fed to
 * the existing, unmodified `getGraphNode` / `getLocalizationContext` /
 * `getBlastRadius`, so no query logic is duplicated here.
 *
 * Every read verifies, before returning anything:
 *   (a) the persisted `graph_meta.workspace_root` realpath-matches the ACTIVE
 *       workspace (same trust boundary as `bindGraphToWorkspace`,
 *       `storage.ts:100-127`), and
 *   (b) `graph_meta.source_size` / `source_mtime_ms` equal a live stat of
 *       `repo-graph.json`.
 * Any mismatch, absence, or error returns null and the caller uses its
 * existing JSON path. The index is never a second source of truth.
 *
 * Runtime portability (AGENTS.md invariant 2): the SQLite driver is resolved
 * ONLY through `src/db/sqlite-loader.ts`. The `import type` below is erased at
 * build time, so this module contributes no `bun:` runtime resolution.
 * `node:sqlite` is stricter than `bun:sqlite` about bound parameters, so every
 * statement's placeholder count equals its argument count exactly and
 * no-placeholder statements are issued as `db.run(sql)` with no array.
 */

import type { Database, SQLQueryBindings } from 'bun:sqlite';
import { existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import * as path from 'node:path';
import { loadPluginConfig } from '../../config/loader';
import { RepoGraphConfigSchema } from '../../config/schema';
import { loadDatabaseCtor } from '../../db/sqlite-loader';
import { validateSwarmPath } from '../../hooks/utils';
import * as logger from '../../utils/logger';
import { validateSymlinkBoundary } from '../../utils/path-security';
import { safeRealpathSync } from './safe-realpath';
import { deriveRepoRootId } from './symbol-edge';
import type { GraphEdge, GraphNode, RepoGraph } from './types';
import { normalizeGraphPath, REPO_GRAPH_FILENAME } from './types';
import { validateWorkspace } from './validation';

// ============ Constants ============

/** Filename of the derived index inside `.swarm/`. */
export const REPO_MEMORY_FILENAME = 'repo-memory.sqlite';

/**
 * The store file plus its WAL sidecars. `/swarm close` deliberately neither
 * archives nor cleans `-wal`/`-shm` (they are transient), but a *delete* of the
 * store must remove them or a later open would resurrect committed WAL frames
 * belonging to the discarded database.
 */
const STORE_SUFFIXES = ['', '-wal', '-shm'] as const;

/**
 * Bind-parameter chunk size for `IN (...)` queries. Matches the established
 * convention in `src/memory/sqlite-provider.ts:2738` and stays far below
 * SQLite's `SQLITE_MAX_VARIABLE_NUMBER` (999 on pre-3.32 builds).
 */
const SQL_PARAM_CHUNK = 500;

/**
 * Wall-clock budget for one full index sync, checked between row batches.
 *
 * `saveGraph` is reachable from the wrapper-owned post-resolution queue
 * (`repo-graph-builder.ts`), and `index.ts` wraps `repoGraphInitPromise` in
 * `withTimeout(..., 5_000)`. `withTimeout` cannot interrupt a synchronous
 * SQLite transaction, so the sync must bound itself. The bounded lock wait
 * (~310 ms worst case) plus this budget stays well under that 5 s.
 */
const SYNC_BUDGET_MS = 2_000;

/** Rows between wall-clock budget checks inside the sync transaction. */
const SYNC_BATCH_ROWS = 500;

interface Migration {
	version: number;
	name: string;
	sql: string;
}

/**
 * One DDL statement per entry: `db.run(sql)` maps to `exec()` on the
 * `node:sqlite` adapter, and while both drivers execute every semicolon-
 * separated statement, the migration ledger records one version per statement
 * so a partially-applied multi-statement migration can never be mistaken for a
 * complete one. Mirrors `src/db/project-db.ts:163-188`.
 */
const MIGRATIONS: Migration[] = [
	{
		version: 1,
		name: 'create_graph_meta',
		sql: `CREATE TABLE graph_meta (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		)`,
	},
	{
		version: 2,
		name: 'create_files',
		sql: `CREATE TABLE files (
			path TEXT PRIMARY KEY,
			module_name TEXT NOT NULL,
			node_json TEXT NOT NULL
		)`,
	},
	{
		version: 3,
		name: 'create_files_module_name_index',
		sql: 'CREATE INDEX idx_files_module_name ON files(module_name)',
	},
	{
		version: 4,
		name: 'create_edges',
		sql: `CREATE TABLE edges (
			seq INTEGER PRIMARY KEY,
			source TEXT NOT NULL,
			target TEXT NOT NULL,
			edge_json TEXT NOT NULL
		)`,
	},
	{
		version: 5,
		name: 'create_edges_source_index',
		sql: 'CREATE INDEX idx_edges_source ON edges(source)',
	},
	{
		version: 6,
		name: 'create_edges_target_index',
		sql: 'CREATE INDEX idx_edges_target ON edges(target)',
	},
];

const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

/** Open handles keyed by resolved store path. */
const _handles = new Map<string, Database>();

// ============ Small helpers ============

/**
 * The single bind normalizer. `node:sqlite` rejects `undefined` and booleans
 * outright where `bun:sqlite` coerces, so every parameter array passes through
 * here (AGENTS.md invariant 2).
 */
function bind(values: readonly unknown[]): SQLQueryBindings[] {
	return values.map((value) => {
		if (value === undefined) return null;
		if (typeof value === 'boolean') return value ? 1 : 0;
		return value;
	}) as SQLQueryBindings[];
}

function placeholders(count: number): string {
	return new Array(count).fill('?').join(', ');
}

/** Run `execute` over `values` in bind-parameter-sized chunks. */
function chunkedQuery<T>(
	values: readonly string[],
	execute: (chunk: string[]) => T[],
): T[] {
	const out: T[] = [];
	for (let offset = 0; offset < values.length; offset += SQL_PARAM_CHUNK) {
		for (const row of execute(values.slice(offset, offset + SQL_PARAM_CHUNK))) {
			out.push(row);
		}
	}
	return out;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * `normalizeLookupPath` from `query.ts:55-57`, replicated so the stored
 * `module_name` column is byte-identical to the key `buildReverseIndex` uses
 * for its `moduleNameIndex` (`query.ts:97`). Storing the raw `node.moduleName`
 * would make the step-2 fallback miss exactly the nodes it exists to serve.
 */
function normalizeLookupPath(input: string): string {
	return normalizeGraphPath(input).replace(/^(?:\.\/)+/, '');
}

/** `toModuleName` from `query.ts:63-68`, bound to an explicit root. */
function toModuleName(root: string, input: string): string {
	const normalized = normalizeLookupPath(input);
	if (path.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) {
		return normalizeLookupPath(path.relative(root, normalized));
	}
	return normalized;
}

/**
 * Local mirror of `getGraphPath` (`storage.ts:210-218`).
 *
 * Deliberately duplicated rather than imported: `storage.ts` imports THIS
 * module for its save-path integration, so importing back would create a
 * module cycle. The three validation steps are identical and must stay so.
 */
function getGraphSourcePath(workspace: string): string {
	validateWorkspace(workspace);
	const basePath = validateSwarmPath(workspace, REPO_GRAPH_FILENAME);
	validateSymlinkBoundary(basePath, workspace);
	return basePath;
}

// ============ Path, lifecycle, availability ============

/**
 * Validated absolute path to `.swarm/repo-memory.sqlite`.
 * Mirrors `getGraphPath`: validateWorkspace → validateSwarmPath →
 * validateSymlinkBoundary.
 */
export function getRepoMemoryPath(workspace: string): string {
	validateWorkspace(workspace);
	const basePath = validateSwarmPath(workspace, REPO_MEMORY_FILENAME);

	// SECURITY: resolve symlinks to verify the store path stays in the workspace.
	validateSymlinkBoundary(basePath, workspace);

	return basePath;
}

function closeHandleAt(storePath: string): void {
	const db = _handles.get(storePath);
	if (!db) return;
	_handles.delete(storePath);
	try {
		db.close();
	} catch {
		// Close failures during teardown are not actionable.
	}
}

/**
 * Close the cached connection for a workspace. Called by the `/swarm close`
 * clean stage before unlinking the store (Windows holds a WAL-mode file open,
 * so `unlink` would fail with EBUSY — same guard as
 * `closeProjectDb`, `project-db.ts:232-234`) and from test teardown.
 */
export function closeRepoMemory(workspace: string): void {
	let storePath: string;
	try {
		storePath = getRepoMemoryPath(workspace);
	} catch {
		// An unresolvable path cannot correspond to a cached handle.
		return;
	}
	closeHandleAt(storePath);
}

/**
 * Close every cached connection. Test-teardown only: `/swarm close` uses the
 * singular `closeRepoMemory` (src/commands/close.ts); this export has no
 * other production caller.
 */
export function closeAllRepoMemory(): void {
	for (const db of _handles.values()) {
		try {
			db.close();
		} catch {
			// ignore close errors during cleanup
		}
	}
	_handles.clear();
}

/**
 * Delete the derived store and its WAL sidecars.
 *
 * The cached handle is closed FIRST on every delete path — a live WAL-mode
 * connection keeps the file open and Windows `unlink` fails with EBUSY
 * otherwise.
 */
export function deleteRepoMemory(workspace: string): void {
	let storePath: string;
	try {
		storePath = getRepoMemoryPath(workspace);
	} catch (error) {
		logger.log(
			`[repo-graph] cannot resolve repo-memory path for delete: ${describeError(error)}`,
		);
		return;
	}
	closeHandleAt(storePath);
	for (const suffix of STORE_SUFFIXES) {
		try {
			unlinkSync(`${storePath}${suffix}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				logger.log(
					`[repo-graph] failed to remove ${storePath}${suffix}: ${describeError(error)}`,
				);
			}
		}
	}
}

/** Whether a SQLite driver is resolvable in this runtime. */
export function isIndexedStorageAvailable(): boolean {
	try {
		loadDatabaseCtor();
		return true;
	} catch {
		return false;
	}
}

/**
 * Effective storage mode for a workspace.
 *
 * Config is the kill switch: flipping `repo_graph.storage` back to `'json'`
 * stops every reader from consulting the index immediately, even while a valid
 * store with a matching stamp is still on disk. Falls back to `'json'` on any
 * config error and whenever no SQLite driver is available.
 */
export function resolveGraphStorageMode(workspace: string): 'json' | 'indexed' {
	let configured: 'json' | 'indexed';
	try {
		const config = loadPluginConfig(workspace);
		configured = RepoGraphConfigSchema.parse(config.repo_graph ?? {}).storage;
	} catch (error) {
		logger.log(
			`[repo-graph] storage mode unresolved, using json: ${describeError(error)}`,
		);
		return 'json';
	}
	if (configured !== 'indexed') return 'json';
	if (!isIndexedStorageAvailable()) {
		logger.log(
			'[repo-graph] storage=indexed requested but no SQLite driver is available; using json',
		);
		return 'json';
	}
	return 'indexed';
}

// ============ Connection management ============

function applyPragmas(db: Database): void {
	// Order per the most-reviewed precedent (`sqlite-provider.ts:767-774`):
	// busy_timeout FIRST so every later statement has busy handling.
	db.run('PRAGMA busy_timeout = 5000;');
	db.run('PRAGMA journal_mode = WAL;');
	db.run('PRAGMA synchronous = NORMAL;');
	db.run('PRAGMA foreign_keys = ON;');
}

/**
 * Highest applied migration version.
 * Throws when `schema_migrations` is absent — a store at our own path with none
 * of our tables is structurally not our store, and the caller treats that as
 * corruption.
 */
function readSchemaVersion(db: Database): number {
	const row = db
		.query<{ version: number | null }, []>(
			'SELECT MAX(version) as version FROM schema_migrations',
		)
		.get();
	return row?.version ?? 0;
}

function runMigrations(db: Database): void {
	db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
		version INTEGER PRIMARY KEY,
		name TEXT NOT NULL,
		applied_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`);
	const currentVersion = readSchemaVersion(db);
	for (const migration of MIGRATIONS) {
		if (migration.version <= currentVersion) continue;
		const apply = db.transaction(() => {
			db.run(migration.sql);
			db.run(
				'INSERT INTO schema_migrations (version, name) VALUES (?, ?)',
				bind([migration.version, migration.name]),
			);
		});
		apply();
	}
}

/**
 * Open (creating if needed) the store for writing, running migrations.
 *
 * A store stamped with a version this build does not know can never be read
 * back (`openForRead` requires an exact match), so leaving it in place would
 * make the index permanently useless while still paying the full sync cost.
 * It is reset instead — the store is derived, so nothing is lost.
 *
 * Returns null on any failure, after closing the handle and discarding the
 * store. Never throws into `saveGraph`, whose JSON write has already succeeded.
 */
function openForWrite(workspace: string): Database | null {
	let storePath: string;
	try {
		storePath = getRepoMemoryPath(workspace);
	} catch (error) {
		logger.log(
			`[repo-graph] cannot resolve repo-memory path: ${describeError(error)}`,
		);
		return null;
	}
	const cached = _handles.get(storePath);
	if (cached) return cached;

	try {
		mkdirSync(path.dirname(storePath), { recursive: true });
		const Db = loadDatabaseCtor();
		let db = new Db(storePath);
		try {
			applyPragmas(db);
			db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
				version INTEGER PRIMARY KEY,
				name TEXT NOT NULL,
				applied_at TEXT NOT NULL DEFAULT (datetime('now'))
			)`);
			if (readSchemaVersion(db) > LATEST_SCHEMA_VERSION) {
				logger.log(
					'[repo-graph] repo-memory index has a newer schema than this build; resetting',
				);
				db.close();
				deleteRepoMemory(workspace);
				db = new Db(storePath);
				applyPragmas(db);
			}
			runMigrations(db);
		} catch (error) {
			try {
				db.close();
			} catch {
				// The open failure below is the primary error.
			}
			throw error;
		}
		_handles.set(storePath, db);
		return db;
	} catch (error) {
		logger.log(
			`[repo-graph] repo-memory index unusable for write, discarding: ${describeError(error)}`,
		);
		deleteRepoMemory(workspace);
		return null;
	}
}

/**
 * Open an existing store for reading. Returns null when the store is absent,
 * or when it carries a schema revision other than this build's.
 *
 * A *clean* version mismatch is not corruption and does NOT delete: the file is
 * structurally valid and the next `saveGraph` repairs it via `openForWrite`.
 * A *thrown* error is corruption: the handle is closed, the store discarded,
 * and null returned so the caller uses its JSON path.
 */
function openForRead(workspace: string): Database | null {
	let storePath: string;
	try {
		storePath = getRepoMemoryPath(workspace);
	} catch {
		return null;
	}
	const cached = _handles.get(storePath);
	if (cached) return cached;
	if (!existsSync(storePath)) return null;

	let db: Database;
	try {
		const Db = loadDatabaseCtor();
		db = new Db(storePath);
	} catch (error) {
		logger.log(
			`[repo-graph] repo-memory index could not be opened, discarding: ${describeError(error)}`,
		);
		deleteRepoMemory(workspace);
		return null;
	}
	try {
		applyPragmas(db);
		if (readSchemaVersion(db) !== LATEST_SCHEMA_VERSION) {
			db.close();
			return null;
		}
	} catch (error) {
		try {
			db.close();
		} catch {
			// The corruption path below is the primary outcome.
		}
		logger.log(
			`[repo-graph] repo-memory index unreadable, discarding: ${describeError(error)}`,
		);
		deleteRepoMemory(workspace);
		return null;
	}
	_handles.set(storePath, db);
	return db;
}

// ============ Write path ============

const BUDGET_EXCEEDED = 'repo-memory sync exceeded its wall-clock budget';

/**
 * Replace the whole index from `graph` in one transaction.
 *
 * `stamp` MUST be a stat of the TEMP FILE, taken inside the save lock
 * immediately BEFORE this writer's rename publishes it — not a stat of
 * `repo-graph.json` at any point. `rename(2)` leaves the inode's mtime and size
 * untouched, so the temp-file stat identifies THIS writer's own bytes. Any stat
 * of the published path instead describes whatever is at that path by then: a
 * concurrent writer that failed the lock renames unlocked (the JSON write is
 * never lock-gated), so a post-rename stat would let ITS bytes validate an index
 * holding THIS writer's superseded content. See `saveGraph`.
 *
 * Returns false — never throws — on every failure; the JSON write is the
 * durability point and has already succeeded.
 */
export async function syncIndexFromGraph(
	workspace: string,
	graph: RepoGraph,
	stamp: { size: number; mtimeMs: number; ino: string },
): Promise<boolean> {
	const deadline = Date.now() + SYNC_BUDGET_MS;
	const db = openForWrite(workspace);
	if (!db) return false;
	try {
		const nodeEntries = Object.entries(graph.nodes);
		// INVARIANT: `getGraphNode` looks a node up by its map KEY
		// (`absoluteKeyForModule`, query.ts:70-81) while `buildReverseIndex` keys
		// the reverse map on `normalizeGraphPath(node.filePath)` (query.ts:99-101).
		// Both node-insertion sites make these the same string (`upsertNode`,
		// builder.ts:218-219, and builder.ts:277), and this module stores ONE
		// `files.path` column serving both roles. A graph that violates the
		// invariant cannot be served equivalently, so refuse to index it rather
		// than ship a subgraph that answers differently from the full graph.
		for (const [key, node] of nodeEntries) {
			if (key !== normalizeGraphPath(node.filePath)) {
				throw new Error(
					`node key "${key}" does not match normalized filePath "${node.filePath}"`,
				);
			}
		}

		const apply = db.transaction(() => {
			db.run('DELETE FROM edges');
			db.run('DELETE FROM files');
			db.run('DELETE FROM graph_meta');

			let processed = 0;
			const checkBudget = (): void => {
				processed++;
				if (processed % SYNC_BATCH_ROWS === 0 && Date.now() > deadline) {
					throw new Error(BUDGET_EXCEEDED);
				}
			};

			const insertFile =
				'INSERT INTO files (path, module_name, node_json) VALUES (?, ?, ?)';
			for (const [key, node] of nodeEntries) {
				db.run(
					insertFile,
					bind([
						key,
						normalizeLookupPath(node.moduleName),
						JSON.stringify(node),
					]),
				);
				checkBudget();
			}

			// `seq` is omitted so SQLite assigns rowids in insertion order,
			// preserving `graph.edges` order. `source`/`target` are stored
			// normalized because `buildReverseIndex` joins on
			// `normalizeGraphPath(edge.source)` while the raw edge (kept verbatim
			// in `edge_json`) carries platform-native separators.
			const insertEdge =
				'INSERT INTO edges (source, target, edge_json) VALUES (?, ?, ?)';
			for (const edge of graph.edges) {
				db.run(
					insertEdge,
					bind([
						normalizeGraphPath(edge.source),
						normalizeGraphPath(edge.target),
						JSON.stringify(edge),
					]),
				);
				checkBudget();
			}

			const insertMeta = 'INSERT INTO graph_meta (key, value) VALUES (?, ?)';
			// `graph.workspaceRoot` is persisted VERBATIM, not realpathed:
			// `saveGraph` never rewrites it (unlike `bindGraphToWorkspace` on load),
			// so this is the same string `repo-graph.json` carries. Readers verify
			// it realpath-matches the active workspace and then return the ACTIVE
			// realpath instead of this value (closure rule step 5).
			db.run(insertMeta, bind(['workspace_root', graph.workspaceRoot]));
			db.run(insertMeta, bind(['source_size', String(stamp.size)]));
			db.run(insertMeta, bind(['source_mtime_ms', String(stamp.mtimeMs)]));
			// '0' means the filesystem did not give us a usable file id; the
			// reader then skips the ino comparison rather than failing closed.
			// Coerced, never bound raw: a missing or non-string value would bind as
			// NULL against `value TEXT NOT NULL`, aborting the transaction and
			// DELETING the store — turning a cosmetic stamp problem into total
			// loss of the index. '0' is the documented degrade-to-size+mtime value.
			const inoValue =
				typeof stamp.ino === 'string' && stamp.ino.length > 0 ? stamp.ino : '0';
			db.run(insertMeta, bind(['source_ino', inoValue]));
			db.run(insertMeta, bind(['graph_schema_version', graph.schema_version]));
		});
		apply();
		return true;
	} catch (error) {
		logger.log(
			`[repo-graph] repo-memory sync failed, discarding index: ${describeError(error)}`,
		);
		deleteRepoMemory(workspace);
		return false;
	}
}

// ============ Read path ============

interface IndexContext {
	db: Database;
	/** Realpath-bound ACTIVE workspace — closure rule step 5. */
	root: string;
	schemaVersion: string;
	sourceMtimeMs: number;
}

/**
 * Open the index and verify it may be used: workspace binding first, then the
 * `{size, mtimeMs}` stamp against a live stat of `repo-graph.json`.
 */
function openFreshIndex(workspace: string): IndexContext | null {
	const db = openForRead(workspace);
	if (!db) return null;

	let meta: Map<string, string>;
	try {
		const rows = db
			.query<{ key: string; value: string }, []>(
				'SELECT key, value FROM graph_meta',
			)
			.all();
		meta = new Map(rows.map((row) => [row.key, row.value]));
	} catch (error) {
		logger.log(
			`[repo-graph] repo-memory metadata unreadable, discarding: ${describeError(error)}`,
		);
		deleteRepoMemory(workspace);
		return null;
	}

	const persistedRoot = meta.get('workspace_root');
	const persistedSize = meta.get('source_size');
	const persistedMtime = meta.get('source_mtime_ms');
	const schemaVersion = meta.get('graph_schema_version');
	if (!persistedRoot || !persistedSize || !persistedMtime || !schemaVersion) {
		return null;
	}

	// (a) Workspace binding. Same trust boundary as `bindGraphToWorkspace`
	// (storage.ts:100-127): an index built for a different workspace is
	// rejected outright.
	const resolvedActive = path.resolve(workspace);
	const trustedActive = safeRealpathSync(resolvedActive, resolvedActive);
	if (trustedActive === null) return null;
	const resolvedPersisted = path.resolve(persistedRoot);
	const trustedPersisted = safeRealpathSync(
		resolvedPersisted,
		resolvedPersisted,
	);
	if (trustedPersisted === null) return null;
	if (path.normalize(trustedPersisted) !== path.normalize(trustedActive)) {
		return null;
	}

	// (b) Freshness. The stamp is sufficient rather than merely indicative
	// because `saveGraph` captures it from a stat of its TEMP FILE, inside the
	// save lock and BEFORE the rename publishes it — so the stamp identifies
	// that writer's own bytes rather than whatever later occupies the path.
	// (A post-rename stat of the path would NOT be sufficient: a writer that
	// failed the lock renames unlocked, and its bytes would then validate an
	// index holding superseded content.)
	// The stamp ALSO carries the source file's inode / file id, because
	// {size, mtimeMs} alone collides far more often than "rare" suggests
	// (measured on this repo: two rebuilds that differ only in file mtimes
	// produced an IDENTICAL byte length 20/20 times, and back-to-back writes
	// shared an mtimeMs 146/200 times on a ~15 ms-resolution filesystem).
	// The 20/20 is EMPIRICAL, not structural: the ISO `mtime` string is
	// fixed-width (24 chars), but every node also carries a numeric `mtimeMs`
	// (types.ts:254) whose `String()` width varies — measured 16/17/18 chars
	// across real files — so a rebuild CAN change the byte length. Equal length
	// is common, not guaranteed. Either way size+mtime is an unreliable
	// discriminator in both directions, which is why the file id is needed.
	// `rename(2)` carries the inode with the
	// file, so a competing writer's document has a DIFFERENT id even at equal
	// size and timestamp.
	//
	// Guarded, never fail-closed: some filesystems (network shares, and some
	// Windows configurations) report 0 or an unstable id. When either side is
	// '0' the comparison is skipped and behaviour falls back to size+mtime, so
	// a missing id can never make the index permanently unreadable — the
	// silently-inert failure mode this feature has already hit once.
	// `ino` is `number`, not `number | bigint`: `statSync` without
	// `{ bigint: true }` returns numbers, and the WRITER's stat
	// (`storage.ts`) is likewise non-bigint. Keep the two visibly coupled —
	// flipping only one side to bigint would render ids above 2^53 in
	// exponential notation on that side only, and every read would then
	// reject a valid index.
	let stats: { size: number; mtimeMs: number; ino: number };
	try {
		stats = statSync(getGraphSourcePath(workspace));
	} catch {
		// No readable source document: nothing to be fresh against.
		return null;
	}
	if (String(stats.size) !== persistedSize) return null;
	if (String(stats.mtimeMs) !== persistedMtime) return null;
	const persistedIno = meta.get('source_ino');
	const liveIno = String(stats.ino ?? 0);
	if (
		persistedIno !== undefined &&
		persistedIno !== '0' &&
		liveIno !== '0' &&
		persistedIno !== liveIno
	) {
		// Logged because size and mtime ALREADY matched, so this is either a
		// genuine foreign document (rare per read) or a filesystem that does not
		// preserve the file id across `rename(2)` (NFS attribute-cache refill,
		// some FUSE mounts, certain ReFS/SMB configurations). In the latter case
		// every read rejects forever: fail-safe, but the feature would be 100%
		// dead and undiagnosable. One line converts that into a greppable
		// symptom. This is the "inert in production" shape that got plan rev 3
		// withdrawn, so it must not be silent.
		logger.log(
			`[repo-graph] repo-memory stamp file-id mismatch (persisted ${persistedIno}, live ${liveIno}) at matching size+mtime; falling back to JSON`,
		);
		return null;
	}

	return {
		db,
		root: trustedActive,
		schemaVersion,
		sourceMtimeMs: stats.mtimeMs,
	};
}

interface FileRow {
	path: string;
	node_json: string;
}

/**
 * Closure rule steps 1-2 — the two-step `getGraphNode` resolution
 * (`query.ts:74-81`), including the `module_name` fallback.
 *
 * Step 1: normalize, strip `./` prefixes, relativize absolutes against the
 *         active root.
 * Step 2: look up by the absolute node key; ON MISS fall back to `module_name`.
 *
 * The fallback takes the LAST matching row (highest rowid). Rows are inserted
 * in `Object.values(graph.nodes)` order and `buildReverseIndex` builds
 * `moduleNameIndex` with `Map.set` over that same order, so last-wins here
 * matches last-wins there when two nodes share a module name.
 */
function resolveTargetRow(
	db: Database,
	root: string,
	input: string,
): FileRow | null {
	const moduleName = toModuleName(root, input);
	const key = normalizeGraphPath(path.resolve(root, moduleName));
	const direct = db
		.query<FileRow, SQLQueryBindings[]>(
			'SELECT path, node_json FROM files WHERE path = ?',
		)
		.get(...bind([key]));
	if (direct) return direct;
	const byModule = db
		.query<FileRow, SQLQueryBindings[]>(
			'SELECT path, node_json FROM files WHERE module_name = ? ORDER BY rowid DESC LIMIT 1',
		)
		.get(...bind([moduleName]));
	return byModule ?? null;
}

function distinctSourcesOf(db: Database, targets: readonly string[]): string[] {
	return chunkedQuery(targets, (chunk) =>
		db
			.query<{ source: string }, SQLQueryBindings[]>(
				`SELECT DISTINCT source FROM edges WHERE target IN (${placeholders(chunk.length)})`,
			)
			.all(...bind(chunk))
			.map((row) => row.source),
	);
}

function distinctTargetsOf(db: Database, sources: readonly string[]): string[] {
	return chunkedQuery(sources, (chunk) =>
		db
			.query<{ target: string }, SQLQueryBindings[]>(
				`SELECT DISTINCT target FROM edges WHERE source IN (${placeholders(chunk.length)})`,
			)
			.all(...bind(chunk))
			.map((row) => row.target),
	);
}

/**
 * Keep only candidates that are real nodes. Edge endpoints are not necessarily
 * nodes — an `'asset'` target never becomes one (`types.ts:260-268`).
 */
function existingNodePaths(
	db: Database,
	candidates: readonly string[],
): string[] {
	const unique = [...new Set(candidates)];
	return chunkedQuery(unique, (chunk) =>
		db
			.query<{ path: string }, SQLQueryBindings[]>(
				`SELECT path FROM files WHERE path IN (${placeholders(chunk.length)})`,
			)
			.all(...bind(chunk))
			.map((row) => row.path),
	);
}

/**
 * Resolve a single file to its `GraphNode` using the index.
 *
 * Implements closure rule steps 1-2 in full, so an anchor whose `moduleName`
 * diverges from `path.relative(root, filePath)` resolves exactly as it would
 * through `getGraphNode` on the full graph. Returns null whenever the index is
 * absent, stale, foreign, or unusable — the caller keeps its existing path.
 */
export function queryNodeByFile(
	workspace: string,
	file: string,
): GraphNode | null {
	const ctx = openFreshIndex(workspace);
	if (!ctx) return null;
	try {
		const row = resolveTargetRow(ctx.db, ctx.root, file);
		if (!row) return null;
		return JSON.parse(row.node_json) as GraphNode;
	} catch (error) {
		logger.log(
			`[repo-graph] repo-memory node lookup failed, discarding index: ${describeError(error)}`,
		);
		deleteRepoMemory(workspace);
		return null;
	}
}

/**
 * Build a bounded subgraph covering `files` and their neighbourhood, suitable
 * for feeding the unmodified `getLocalizationContext` / `getBlastRadius`.
 *
 * Closure rule (normative, from the approved plan):
 *  1-2. resolve every requested file the way `getGraphNode` would;
 *  3.   `T` = the union of resolved targets across ALL requested files in this
 *       ONE call (`getBlastRadius` seeds `visited` with every target at once,
 *       query.ts:623-625, so per-file subgraphs merged afterwards would produce
 *       a different `totalDependents` and therefore a different `riskLevel`);
 *       `N = T ∪ R_1..R_D ∪ F_1`, where `R` is the reverse closure to depth `D`
 *       and `F_1` is the 1-hop forward set from the targets only
 *       (`getDependencies`, query.ts:398-406);
 *  4.   `E = { edge : source ∈ N AND target ∈ N }` — AND, not incidence. An OR
 *       rule would admit frontier edges whose counterpart node is absent, and
 *       `moduleNameForEdgePath` (query.ts:83-88) silently degrades to a
 *       different string for those, changing `importers` / `dependencies` /
 *       `directDependents`. No asset/kind filtering happens in SQL:
 *       `buildReverseIndex` and `collectExternallyUsedSymbols` re-apply
 *       `isAssetEdge` downstream, so over-inclusion is harmless while
 *       under-inclusion is fatal;
 *  5.   the returned `workspaceRoot` is the realpath-bound ACTIVE workspace,
 *       never the persisted `graph_meta.workspace_root`.
 *
 * `depth` is clamped to at least 1: `getLocalizationContext` calls
 * `getImporters` unconditionally, which needs `R_1` even when it passes
 * `maxDepth = 0` to `getBlastRadius`. Over-inclusion of nodes is safe (a
 * `maxDepth = 0` blast radius early-returns, query.ts:613-621).
 */
export function loadSubgraphForFiles(
	workspace: string,
	files: string[],
	depth: number,
): RepoGraph | null {
	const ctx = openFreshIndex(workspace);
	if (!ctx) return null;
	const { db, root } = ctx;
	try {
		// Steps 1-2, unioned across every requested file.
		const targets = new Set<string>();
		for (const file of files) {
			const row = resolveTargetRow(db, root, file);
			if (row) targets.add(row.path);
		}
		const targetKeys = [...targets];

		// Step 3 — reverse closure. Its visited set is seeded with T ONLY: F_1 is
		// unioned afterwards so a node that is both a dependency of a target and
		// an importer of one still gets expanded.
		const closureDepth = Number.isFinite(depth)
			? Math.max(1, Math.trunc(depth))
			: 1;
		const reverseVisited = new Set(targetKeys);
		let frontier = targetKeys;
		for (let round = 0; round < closureDepth && frontier.length > 0; round++) {
			const sources = existingNodePaths(db, distinctSourcesOf(db, frontier));
			const next: string[] = [];
			for (const source of sources) {
				if (reverseVisited.has(source)) continue;
				reverseVisited.add(source);
				next.push(source);
			}
			frontier = next;
		}

		const nodeKeys = new Set(reverseVisited);
		for (const forward of existingNodePaths(
			db,
			distinctTargetsOf(db, targetKeys),
		)) {
			nodeKeys.add(forward);
		}

		const memberKeys = [...nodeKeys];
		const nodes: Record<string, GraphNode> = {};
		for (const row of chunkedQuery(memberKeys, (chunk) =>
			db
				.query<FileRow, SQLQueryBindings[]>(
					`SELECT path, node_json FROM files WHERE path IN (${placeholders(chunk.length)})`,
				)
				.all(...bind(chunk)),
		)) {
			nodes[row.path] = JSON.parse(row.node_json) as GraphNode;
		}

		// Step 4. Fetched by `source` (idx_edges_source) and filtered on `target`
		// membership in memory, then re-sorted by `seq` so the array order across
		// chunk boundaries matches the original `graph.edges` order.
		const edgeRows = chunkedQuery(memberKeys, (chunk) =>
			db
				.query<
					{ seq: number; target: string; edge_json: string },
					SQLQueryBindings[]
				>(
					`SELECT seq, target, edge_json FROM edges WHERE source IN (${placeholders(chunk.length)})`,
				)
				.all(...bind(chunk)),
		);
		const edges: GraphEdge[] = edgeRows
			.filter((row) => nodeKeys.has(row.target))
			.sort((a, b) => a.seq - b.seq)
			.map((row) => JSON.parse(row.edge_json) as GraphEdge);

		// Step 5 — the ACTIVE realpath-bound root, matching what every
		// `loadGraph` consumer sees after `bindGraphToWorkspace` (storage.ts:124).
		// `repoRootId` is likewise DERIVED (`deriveRepoRootId` is deterministic,
		// storage.ts:177) rather than persisted, so there is no second source of
		// truth. `symbolEdges` / `diagnostics` are deliberately absent: they have
		// no reader on any path this subgraph serves.
		return {
			schema_version: ctx.schemaVersion,
			workspaceRoot: root,
			repoRootId: deriveRepoRootId(root),
			nodes,
			edges,
			// Descriptive only. `generated_at` is deliberately not a `graph_meta`
			// key; the sole `metadata.generatedAt` reader (`repo-map.ts:373`) is a
			// whole-graph consumer that stays on the JSON path. The value below is
			// the live mtime of the source document the stamp just validated, and
			// the counts describe THIS subgraph.
			metadata: {
				generatedAt: new Date(ctx.sourceMtimeMs).toISOString(),
				generator: 'repo-graph',
				nodeCount: Object.keys(nodes).length,
				edgeCount: edges.length,
			},
		};
	} catch (error) {
		logger.log(
			`[repo-graph] repo-memory subgraph load failed, discarding index: ${describeError(error)}`,
		);
		deleteRepoMemory(workspace);
		return null;
	}
}
