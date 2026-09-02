/**
 * Runtime-portable SQLite driver loader for opencode-swarm.
 *
 * Why this exists (issue #1873): the published plugin bundle (`dist/index.js`) is
 * built `--target node` and OpenCode Desktop loads it inside a **Node.js** Electron
 * `utilityProcess` sidecar. The previous DB layer resolved the driver with a lazy
 * `createRequire(import.meta.url)('bun:sqlite')` and **no fallback**. `bun:sqlite` is
 * a Bun-only built-in, so under Node every SQLite-backed tool threw
 * `Error: Cannot find module 'bun:sqlite'` (`swarm_memory_recall`, the QA-gate tools,
 * `get_approved_plan`, …).
 *
 * The lazy require kept `bun:sqlite` out of the bundle's top-level ESM imports (which
 * is what invariant #2 / issue #675 requires — a static `import … from 'bun:…'` breaks
 * Node's ESM resolver with `ERR_UNSUPPORTED_ESM_URL_SCHEME`), but it still assumed a
 * Bun runtime at call time.
 *
 * This module is the single, sanctioned place that resolves a `bun:sqlite`-shaped
 * `Database` constructor:
 *   1. Under Bun: return the native `bun:sqlite` `Database` (behaviour unchanged).
 *   2. Under Node: wrap `node:sqlite`'s `DatabaseSync` (flag-free in Node 22.13+; added
 *      behind `--experimental-sqlite` in 22.5; shipped by Electron 42+) in a small
 *      adapter that presents the exact `Database` subset the
 *      codebase uses — `run(sql, params?)`, `query(sql).{get,all,iterate}`,
 *      `prepare(sql).{get,all,iterate,finalize}`,
 *      `transaction(fn)`, `inTransaction`, `loadExtension(path)`, `close()`. A bare
 *      constructor swap is NOT enough: `DatabaseSync` has none of
 *      `run/query/transaction/inTransaction`.
 *   3. If neither driver is available: throw one clear, combined diagnostic.
 *
 * Portability contract (invariant #2): all three former call sites
 * (`project-db.ts`, `global-db.ts`, `memory/sqlite-provider.ts`) now import
 * `loadDatabaseCtor` from here. No new lazy `require('bun:…')` may be added elsewhere —
 * `tests/unit/build/bundle-portability.test.ts` enforces this statically, and
 * `scripts/repro-1873.mjs` exercises the real Node driver end-to-end in CI.
 */

import type { Database } from 'bun:sqlite';
import { createRequire } from 'node:module';

// ── Minimal structural types for node:sqlite ────────────────────────────────
// `node:sqlite` is intentionally NOT imported for its types: the repo's tsconfig
// pins `"types": ["bun-types"]`, and Bun does not implement `node:sqlite`, so its
// declarations do not resolve. We describe only the surface the adapter uses.
interface NodeStatementSync {
	get(...params: unknown[]): unknown;
	all(...params: unknown[]): unknown[];
	iterate(...params: unknown[]): IterableIterator<unknown>;
	run(...params: unknown[]): {
		changes: number | bigint;
		lastInsertRowid: number | bigint;
	};
}

interface NodeDatabaseSync {
	exec(sql: string): void;
	prepare(sql: string): NodeStatementSync;
	// `isTransaction` reflects an open transaction started by ANY means, including a
	// manual `exec('BEGIN IMMEDIATE')` (verified against Node v22.22 — see
	// .claude/issue-traces/1873/02-reproduction.md P3). It is the source of truth for
	// `inTransaction` and for the SAVEPOINT-vs-BEGIN decision below.
	readonly isTransaction: boolean;
	enableLoadExtension(enable: boolean): void;
	loadExtension(path: string): void;
	close(): void;
}

type NodeDatabaseSyncCtor = new (
	filename: string,
	options?: { allowExtension?: boolean },
) => NodeDatabaseSync;

/**
 * Build a `bun:sqlite`-`Database`-compatible constructor backed by `node:sqlite`'s
 * `DatabaseSync`. Exported for direct unit testing under Bun (which lacks
 * `node:sqlite`) via an injected fake `DatabaseSync`.
 */
export function createNodeDatabaseCtor(
	DatabaseSyncCtor: NodeDatabaseSyncCtor,
): typeof Database {
	class NodeSqliteDatabase {
		private readonly raw: NodeDatabaseSync;
		// Prepared-statement cache keyed by SQL text — mirrors bun:sqlite's `.query()`
		// caching. Single-cursor caveat: a cached compiled statement backs get/all AND
		// iterate, so the SAME SQL must not be iterated re-entrantly/concurrently. The
		// codebase has exactly one `.iterate()` site (sqlite-provider `iterateMemoryRows`),
		// always fully drained with no nested same-SQL iteration; bun:sqlite has the
		// identical constraint. Do not introduce concurrent iteration of one SQL string.
		private readonly stmts = new Map<string, NodeStatementSync>();
		private savepointCounter = 0;

		constructor(filename: string) {
			// `allowExtension: true` is REQUIRED for `loadExtension` (sqlite-vec): probe
			// shows `enableLoadExtension(true)` throws ERR_INVALID_STATE without it. SQL
			// reaching these DBs is internal/trusted, so the widened `load_extension()`
			// surface is not reachable by untrusted input.
			this.raw = new DatabaseSyncCtor(filename, { allowExtension: true });
		}

		private statement(sql: string): NodeStatementSync {
			let stmt = this.stmts.get(sql);
			if (!stmt) {
				stmt = this.raw.prepare(sql);
				this.stmts.set(sql, stmt);
			}
			return stmt;
		}

		run(sql: string, ...rest: unknown[]): unknown {
			// bun:sqlite `db.run(sql)` executes SQL with no bindings; `db.run(sql, [p…])`
			// binds an array (callers always pass ONE array), and `db.run(sql, a, b)` binds
			// spread args. Callers ignore the return value. The no-param path uses exec():
			// both node:sqlite's exec() and bun:sqlite's run() execute ALL semicolon-
			// separated statements, so the two drivers behave identically here. Every caller
			// passes a single statement anyway (the memory provider pre-splits migrations
			// via splitSql; project-db/global-db each pass a single-statement migration).
			if (rest.length === 0) {
				this.raw.exec(sql);
				return undefined;
			}
			const params =
				rest.length === 1 && Array.isArray(rest[0])
					? (rest[0] as unknown[])
					: rest;
			return this.statement(sql).run(...params);
		}

		query(sql: string): {
			get(...params: unknown[]): unknown;
			all(...params: unknown[]): unknown[];
			iterate(...params: unknown[]): IterableIterator<unknown>;
		} {
			const stmt = this.statement(sql);
			return {
				get: (...params: unknown[]) => stmt.get(...params),
				all: (...params: unknown[]) => stmt.all(...params),
				iterate: (...params: unknown[]) => stmt.iterate(...params),
			};
		}

		prepare(sql: string): {
			get(...params: unknown[]): unknown;
			all(...params: unknown[]): unknown[];
			iterate(...params: unknown[]): IterableIterator<unknown>;
			finalize(): void;
		} {
			// Unlike query(), prepare() is intentionally uncached. Callers use it for
			// short-lived statements whose native resources must be released explicitly
			// under Bun. node:sqlite owns statements at the DatabaseSync level and releases
			// them on close(), so finalize is a portable no-op on this adapter.
			const stmt = this.raw.prepare(sql);
			return {
				get: (...params: unknown[]) => stmt.get(...params),
				all: (...params: unknown[]) => stmt.all(...params),
				iterate: (...params: unknown[]) => stmt.iterate(...params),
				finalize: () => {},
			};
		}

		get inTransaction(): boolean {
			return this.raw.isTransaction;
		}

		transaction<Fn extends (...args: unknown[]) => unknown>(
			fn: Fn,
		): (...args: Parameters<Fn>) => ReturnType<Fn> {
			return (...args: Parameters<Fn>): ReturnType<Fn> => {
				// The callback MUST be synchronous: like bun:sqlite's db.transaction(), the
				// COMMIT fires at the end of THIS synchronous frame, so an async callback's
				// awaited writes would run AFTER COMMIT. Async transactional work uses
				// SQLiteMemoryProvider.withTransaction (manual BEGIN IMMEDIATE) instead.
				// Nested inside an existing transaction (e.g. a `db.transaction()` invoked
				// within `withTransaction`'s manual BEGIN IMMEDIATE): SQLite has no nested
				// BEGIN, so use a SAVEPOINT. This mirrors bun:sqlite's nesting semantics.
				if (this.raw.isTransaction) {
					const sp = `swarm_sp_${this.savepointCounter++}`;
					this.raw.exec(`SAVEPOINT ${sp}`);
					try {
						const result = fn(...args) as ReturnType<Fn>;
						this.raw.exec(`RELEASE ${sp}`);
						return result;
					} catch (err) {
						try {
							this.raw.exec(`ROLLBACK TO ${sp}`);
							this.raw.exec(`RELEASE ${sp}`);
						} catch {
							// Ignore rollback failures; surface the original error below.
						}
						throw err;
					}
				}
				this.raw.exec('BEGIN');
				try {
					const result = fn(...args) as ReturnType<Fn>;
					this.raw.exec('COMMIT');
					return result;
				} catch (err) {
					try {
						this.raw.exec('ROLLBACK');
					} catch {
						// Ignore rollback failures (e.g. already aborted); surface original.
					}
					throw err;
				}
			};
		}

		loadExtension(path: string): void {
			// Enable extension loading only for the duration of the load, then restore it
			// off (defense-in-depth: the SQL `load_extension()` function stays enabled no
			// longer than necessary). The extension's registered vtabs/functions remain
			// usable afterward; only further `load_extension()` calls are disabled.
			this.raw.enableLoadExtension(true);
			try {
				this.raw.loadExtension(path);
			} finally {
				this.raw.enableLoadExtension(false);
			}
		}

		close(): void {
			this.stmts.clear();
			this.raw.close();
		}
	}

	// The runtime shape matches the `bun:sqlite` `Database` subset the codebase uses;
	// the structural cast keeps the public type identical to the Bun path.
	return NodeSqliteDatabase as unknown as typeof Database;
}

let _DatabaseCtor: typeof Database | null = null;

/**
 * Internal seam for tests: `requireModule` is dependency-injected so a Bun test can
 * force the Node fallback path with a fake `node:sqlite`, and `reset()` clears the
 * module-level cache between cases. Not part of the public API.
 */
export const _internals = {
	requireModule(id: string): unknown {
		return createRequire(import.meta.url)(id);
	},
	reset(): void {
		_DatabaseCtor = null;
	},
};

/**
 * Resolve a `bun:sqlite`-`Database`-compatible constructor for the current runtime.
 * Cached after first resolution.
 *
 * Order: native `bun:sqlite` (Bun) → `node:sqlite` adapter (Node) → clear error.
 */
export function loadDatabaseCtor(): typeof Database {
	if (_DatabaseCtor) return _DatabaseCtor;

	let bunError: unknown;
	try {
		const mod = _internals.requireModule('bun:sqlite') as {
			Database: typeof Database;
		};
		_DatabaseCtor = mod.Database;
		return _DatabaseCtor;
	} catch (err) {
		bunError = err;
	}

	try {
		const mod = _internals.requireModule('node:sqlite') as {
			DatabaseSync: NodeDatabaseSyncCtor;
		};
		// #2480 runtime floor (declared in package.json#engines): node:sqlite is
		// only available flag-free from Node 22.13. On an older Node the bare
		// module-not-found error is opaque — surface the version floor instead.
		const nodeMajor = Number.parseInt(
			process.versions.node?.split('.')[0] ?? '0',
			10,
		);
		const nodeMinor = Number.parseInt(
			process.versions.node?.split('.')[1] ?? '0',
			10,
		);
		if (
			Number.isFinite(nodeMajor) &&
			Number.isFinite(nodeMinor) &&
			(nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 13))
		) {
			throw new Error(
				`opencode-swarm: node:sqlite requires Node.js >= 22.13 (engines floor, issue #2480); this runtime is Node ${process.versions.node}. Upgrade Node or run under Bun >= 1.3.13.`,
			);
		}
		_DatabaseCtor = createNodeDatabaseCtor(mod.DatabaseSync);
		return _DatabaseCtor;
	} catch (nodeError) {
		const bunMsg =
			bunError instanceof Error ? bunError.message : String(bunError);
		const nodeMsg =
			nodeError instanceof Error ? nodeError.message : String(nodeError);
		throw new Error(
			'opencode-swarm: no SQLite driver available. This build needs Bun ' +
				'(bun:sqlite) or Node.js 22.13+ (node:sqlite). ' +
				`bun:sqlite: ${bunMsg}; node:sqlite: ${nodeMsg}`,
		);
	}
}
