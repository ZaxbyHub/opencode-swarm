/**
 * Tests for src/db/sqlite-loader.ts (issue #1873).
 *
 * Two concerns:
 *  1. Runtime selection: `loadDatabaseCtor()` returns native `bun:sqlite` under Bun,
 *     falls back to the `node:sqlite` adapter, and throws a clear combined error when
 *     neither is available. Selection is exercised via the `_internals.requireModule`
 *     DI seam (Bun lacks `node:sqlite`, so the real Node driver is exercised by the
 *     Node harness `scripts/repro-1873.mjs`, not here).
 *  2. Adapter translation: `createNodeDatabaseCtor(fakeDatabaseSync)` maps the
 *     `bun:sqlite` `Database` surface onto `node:sqlite`'s `DatabaseSync` API. A fake
 *     `DatabaseSync` records the underlying calls so the mapping is asserted directly.
 */

import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	_internals,
	createNodeDatabaseCtor,
	loadDatabaseCtor,
} from './sqlite-loader.js';

// ── Fake node:sqlite DatabaseSync ───────────────────────────────────────────
interface FakeCalls {
	exec: string[];
	prepared: string[];
	stmtRun: Array<{ sql: string; params: unknown[] }>;
	stmtGet: Array<{ sql: string; params: unknown[] }>;
	stmtAll: Array<{ sql: string; params: unknown[] }>;
	stmtIterate: Array<{ sql: string; params: unknown[] }>;
	enableLoadExtension: boolean[];
	loadExtension: string[];
	closed: number;
}

function makeFake() {
	const calls: FakeCalls = {
		exec: [],
		prepared: [],
		stmtRun: [],
		stmtGet: [],
		stmtAll: [],
		stmtIterate: [],
		enableLoadExtension: [],
		loadExtension: [],
		closed: 0,
	};

	class FakeStatement {
		constructor(private readonly sql: string) {}
		/**
		 * #2480: model the REAL node:sqlite strictness the adapter must not
		 * paper over — a bound parameter with NO matching placeholder throws
		 * SQLITE_RANGE ("column index out of range"), while bun:sqlite tolerates
		 * the lax form. (The inverse — zero values for existing placeholders —
		 * is tolerated by both drivers and deliberately not modeled.)
		 */
		private checkStrictParamCount(params: unknown[]): void {
			const placeholders = (this.sql.match(/\?/g) ?? []).length;
			if (params.length > placeholders) {
				const err = new RangeError('column index out of range') as Error & {
					code?: string;
				};
				err.code = 'SQLITE_RANGE';
				throw err;
			}
		}
		get(...params: unknown[]): unknown {
			this.checkStrictParamCount(params);
			calls.stmtGet.push({ sql: this.sql, params });
			// #2539: model the real driver's answer to the adapter's changes
			// probe (`SELECT changes() AS c, last_insert_rowid() AS r` — the
			// ALIASED shape; the adapter reads `c`/`r`, not `changes`).
			if (this.sql.startsWith('SELECT changes()')) {
				return { c: 1, r: 1 };
			}
			return { sql: this.sql, op: 'get' };
		}
		all(...params: unknown[]): unknown[] {
			this.checkStrictParamCount(params);
			calls.stmtAll.push({ sql: this.sql, params });
			return [{ sql: this.sql, op: 'all' }];
		}
		*iterate(...params: unknown[]): IterableIterator<unknown> {
			this.checkStrictParamCount(params);
			calls.stmtIterate.push({ sql: this.sql, params });
			yield { sql: this.sql, op: 'iterate' };
		}
		run(...params: unknown[]): {
			changes: number | bigint;
			lastInsertRowid: number | bigint;
		} {
			this.checkStrictParamCount(params);
			calls.stmtRun.push({ sql: this.sql, params });
			return { changes: 1, lastInsertRowid: 1 };
		}
	}

	class FakeDatabaseSync {
		isTransaction = false;
		readonly options?: { allowExtension?: boolean };
		private readonly statements = new Map<string, FakeStatement>();
		constructor(
			readonly filename: string,
			options?: { allowExtension?: boolean },
		) {
			this.options = options;
		}
		exec(sql: string): void {
			calls.exec.push(sql);
			// Mirror real SQLite transaction-state transitions so `isTransaction`
			// and the SAVEPOINT-vs-BEGIN branch behave like the real driver.
			if (/^\s*BEGIN\b/i.test(sql)) this.isTransaction = true;
			else if (/^\s*(COMMIT|END)\b/i.test(sql)) this.isTransaction = false;
			else if (/^\s*ROLLBACK\b/i.test(sql) && !/\bTO\b/i.test(sql))
				this.isTransaction = false;
		}
		prepare(sql: string): FakeStatement {
			calls.prepared.push(sql);
			let stmt = this.statements.get(sql);
			if (!stmt) {
				stmt = new FakeStatement(sql);
				this.statements.set(sql, stmt);
			}
			return stmt;
		}
		enableLoadExtension(enable: boolean): void {
			calls.enableLoadExtension.push(enable);
		}
		loadExtension(path: string): void {
			calls.loadExtension.push(path);
		}
		close(): void {
			calls.closed++;
		}
	}

	return { FakeDatabaseSync, calls };
}

// The adapter is cast to bun's Database type at the boundary; the tests exercise the
// runtime behaviour, so a local structural alias keeps the call sites readable.
type AdapterDb = Database & {
	inTransaction: boolean;
	loadExtension(path: string): void;
	run(sql: string, ...params: unknown[]): unknown;
};

const origRequireModule = _internals.requireModule;

beforeEach(() => {
	_internals.reset();
});

afterEach(() => {
	_internals.requireModule = origRequireModule;
	_internals.reset();
});

describe('loadDatabaseCtor — runtime selection', () => {
	test('returns a working ctor under Bun (native bun:sqlite path)', () => {
		// No requireModule override: under `bun test`, bun:sqlite resolves natively.
		const Ctor = loadDatabaseCtor();
		const db = new Ctor(':memory:');
		try {
			db.run('CREATE TABLE t (id TEXT, n INTEGER)');
			const apply = db.transaction(() => {
				db.run('INSERT INTO t (id, n) VALUES (?, ?)', ['a', 1]);
				return 'committed';
			});
			expect(apply()).toBe('committed');
			const row = db
				.query<{ n: number }, []>('SELECT n FROM t WHERE id = ?')
				.get('a' as never);
			expect(row?.n).toBe(1);
		} finally {
			db.close();
		}
	});

	test('caches the resolved ctor across calls', () => {
		expect(loadDatabaseCtor()).toBe(loadDatabaseCtor());
	});

	test('falls back to node:sqlite adapter when bun:sqlite is unavailable', () => {
		const { FakeDatabaseSync, calls } = makeFake();
		_internals.requireModule = (id: string) => {
			if (id === 'bun:sqlite') throw new Error('Cannot find module bun:sqlite');
			if (id === 'node:sqlite') return { DatabaseSync: FakeDatabaseSync };
			throw new Error(`unexpected require: ${id}`);
		};
		const Ctor = loadDatabaseCtor();
		const db = new Ctor('/tmp/does-not-matter.db') as unknown as AdapterDb;
		// End-to-end proof the loader selected the node:sqlite ADAPTER (not a raw ctor):
		// a no-param run() must route through the adapter's exec() delegation to the fake.
		db.run('PRAGMA journal_mode = WAL;');
		expect(calls.exec).toContain('PRAGMA journal_mode = WAL;');
	});

	test('throws a combined diagnostic when neither driver is available', () => {
		_internals.requireModule = (id: string) => {
			throw new Error(`no module ${id}`);
		};
		expect(() => loadDatabaseCtor()).toThrow(
			/no SQLite driver available[\s\S]*bun:sqlite[\s\S]*node:sqlite/,
		);
	});
});

describe('createNodeDatabaseCtor — adapter translation', () => {
	test('run(sql) with no params routes to exec()', () => {
		const { FakeDatabaseSync, calls } = makeFake();
		const db = new (createNodeDatabaseCtor(FakeDatabaseSync))(
			':x:',
		) as unknown as AdapterDb;
		db.run('PRAGMA foreign_keys = ON;');
		db.run('PRAGMA foreign_keys = OFF;');
		expect(calls.exec).toEqual([
			'PRAGMA foreign_keys = ON;',
			'PRAGMA foreign_keys = OFF;',
		]);
		// #2539: the only prepared statement is the cached changes probe —
		// user SQL never reaches prepare() on the no-param path, and the probe
		// is prepared exactly once across both calls.
		expect(calls.prepared).toEqual([
			'SELECT changes() AS c, last_insert_rowid() AS r',
		]);
	});

	test('run(sql) with no params returns a Changes-shaped object (#2539)', () => {
		const { FakeDatabaseSync, calls } = makeFake();
		const db = new (createNodeDatabaseCtor(FakeDatabaseSync))(
			':x:',
		) as unknown as AdapterDb;
		// bun:sqlite run() ALWAYS returns { changes, lastInsertRowid } — the
		// pre-fix adapter returned undefined here, crashing `.changes` readers
		// (the memory-family ATTACH merge) under the Node sidecar.
		const result = db.run('PRAGMA foreign_keys = ON;') as {
			changes: number;
			lastInsertRowid: number | bigint;
		};
		expect(result).toEqual({ changes: 1, lastInsertRowid: 1 });
		expect(typeof result.changes).toBe('number');
		db.run('PRAGMA foreign_keys = OFF;');
		// The probe is served from the instance statement cache: a second
		// no-param run() prepares nothing new.
		expect(calls.prepared).toHaveLength(1);
	});

	test('run(sql, [params]) prepares once and binds the array', () => {
		const { FakeDatabaseSync, calls } = makeFake();
		const db = new (createNodeDatabaseCtor(FakeDatabaseSync))(
			':x:',
		) as unknown as AdapterDb;
		db.run('INSERT INTO t (id, n) VALUES (?, ?)', ['a', 1]);
		expect(calls.prepared).toEqual(['INSERT INTO t (id, n) VALUES (?, ?)']);
		expect(calls.stmtRun).toEqual([
			{ sql: 'INSERT INTO t (id, n) VALUES (?, ?)', params: ['a', 1] },
		]);
	});

	test('run(sql, a, b) with spread params binds them positionally', () => {
		const { FakeDatabaseSync, calls } = makeFake();
		const db = new (createNodeDatabaseCtor(FakeDatabaseSync))(
			':x:',
		) as unknown as AdapterDb;
		db.run('INSERT INTO t (id, n) VALUES (?, ?)', 'b', 2);
		expect(calls.stmtRun).toEqual([
			{ sql: 'INSERT INTO t (id, n) VALUES (?, ?)', params: ['b', 2] },
		]);
	});

	test('#2480 strictness model: a bound param with no placeholder throws SQLITE_RANGE through the adapter', () => {
		const { FakeDatabaseSync } = makeFake();
		const db = new (createNodeDatabaseCtor(FakeDatabaseSync))(
			':x:',
		) as unknown as AdapterDb;
		// The #1873 delta: node:sqlite rejects this; bun:sqlite tolerates it.
		// Portable code never issues it — the fake now models the strict side
		// so adapter-level parity is PR-tested under Bun (the real node driver
		// leg runs in the merge-queue smoke job).
		expect(() => db.run('SELECT 1', ['extra'])).toThrow(/out of range/);
		expect(() => db.query('SELECT 2').get('extra')).toThrow(/out of range/);
		// Exact-count calls still succeed on the strict fake.
		expect(db.run('SELECT ? , 1', ['ok'])).toBeDefined();
	});

	test('query(sql).get/all/iterate delegate and reuse one prepared statement', () => {
		const { FakeDatabaseSync, calls } = makeFake();
		const db = new (createNodeDatabaseCtor(FakeDatabaseSync))(
			':x:',
		) as unknown as AdapterDb;
		const sql = 'SELECT * FROM t WHERE id = ?';
		expect(db.query(sql).get('a')).toEqual({ sql, op: 'get' });
		expect(db.query(sql).all('b')).toEqual([{ sql, op: 'all' }]);
		expect([...db.query(sql).iterate('c')]).toEqual([{ sql, op: 'iterate' }]);
		// One compiled statement backs all three access patterns (bun:sqlite parity).
		expect(calls.prepared.filter((s) => s === sql)).toHaveLength(1);
		expect(calls.stmtGet).toEqual([{ sql, params: ['a'] }]);
		expect(calls.stmtAll).toEqual([{ sql, params: ['b'] }]);
		expect(calls.stmtIterate).toEqual([{ sql, params: ['c'] }]);
	});

	test('prepare(sql) creates an uncached short-lived statement', () => {
		const { FakeDatabaseSync, calls } = makeFake();
		const db = new (createNodeDatabaseCtor(FakeDatabaseSync))(
			':x:',
		) as unknown as AdapterDb;
		const sql = 'SELECT * FROM t WHERE id = ?';
		const first = db.prepare(sql);
		expect(first.all('a')).toEqual([{ sql, op: 'all' }]);
		first.finalize();
		const second = db.prepare(sql);
		expect(second.get('b')).toEqual({ sql, op: 'get' });
		second.finalize();
		expect(calls.prepared.filter((s) => s === sql)).toHaveLength(2);
	});

	test('transaction(fn) wraps BEGIN/COMMIT and returns the callback value', () => {
		const { FakeDatabaseSync, calls } = makeFake();
		const db = new (createNodeDatabaseCtor(FakeDatabaseSync))(
			':x:',
		) as unknown as AdapterDb;
		const apply = db.transaction(() => {
			db.run('INSERT INTO t (id) VALUES (?)', ['x']);
			return 42;
		});
		expect(apply()).toBe(42);
		expect(calls.exec).toEqual(['BEGIN', 'COMMIT']);
		expect(calls.stmtRun).toHaveLength(1);
	});

	test('transaction(fn) rolls back and rethrows on error', () => {
		const { FakeDatabaseSync, calls } = makeFake();
		const db = new (createNodeDatabaseCtor(FakeDatabaseSync))(
			':x:',
		) as unknown as AdapterDb;
		const boom = db.transaction(() => {
			throw new Error('boom');
		});
		expect(() => boom()).toThrow('boom');
		expect(calls.exec).toEqual(['BEGIN', 'ROLLBACK']);
	});

	test('nested transaction while in a transaction uses a SAVEPOINT', () => {
		const { FakeDatabaseSync, calls } = makeFake();
		const db = new (createNodeDatabaseCtor(FakeDatabaseSync))(
			':x:',
		) as unknown as AdapterDb;
		// Simulate an already-open transaction (e.g. withTransaction's BEGIN IMMEDIATE).
		db.run('BEGIN IMMEDIATE');
		expect(db.inTransaction).toBe(true);
		const nested = db.transaction(() => 'ok');
		expect(nested()).toBe('ok');
		const spExec = calls.exec.filter((s) =>
			/SAVEPOINT|RELEASE|ROLLBACK/.test(s),
		);
		expect(spExec.some((s) => s.startsWith('SAVEPOINT '))).toBe(true);
		expect(spExec.some((s) => s.startsWith('RELEASE '))).toBe(true);
		expect(calls.exec).not.toContain('BEGIN'); // never a plain BEGIN when nested
	});

	test('nested transaction rolls back to savepoint on error', () => {
		const { FakeDatabaseSync, calls } = makeFake();
		const db = new (createNodeDatabaseCtor(FakeDatabaseSync))(
			':x:',
		) as unknown as AdapterDb;
		db.run('BEGIN IMMEDIATE');
		const nested = db.transaction(() => {
			throw new Error('inner');
		});
		expect(() => nested()).toThrow('inner');
		expect(calls.exec.some((s) => s.startsWith('ROLLBACK TO '))).toBe(true);
		expect(calls.exec.some((s) => s.startsWith('RELEASE '))).toBe(true);
		// The ENCLOSING transaction must remain open after a savepoint rollback:
		// ROLLBACK TO <sp> unwinds the savepoint but does not end the outer transaction.
		expect(db.inTransaction).toBe(true);
	});

	test('inTransaction reflects the underlying isTransaction', () => {
		const { FakeDatabaseSync } = makeFake();
		const db = new (createNodeDatabaseCtor(FakeDatabaseSync))(
			':x:',
		) as unknown as AdapterDb;
		expect(db.inTransaction).toBe(false);
		db.run('BEGIN');
		expect(db.inTransaction).toBe(true);
		db.run('COMMIT');
		expect(db.inTransaction).toBe(false);
	});

	test('loadExtension enables extension loading for the load then restores it off', () => {
		const { FakeDatabaseSync, calls } = makeFake();
		const db = new (createNodeDatabaseCtor(FakeDatabaseSync))(
			':x:',
		) as unknown as AdapterDb;
		db.loadExtension('/path/to/vec0.so');
		// Enabled before the load, restored off after (defense-in-depth).
		expect(calls.enableLoadExtension).toEqual([true, false]);
		expect(calls.loadExtension).toEqual(['/path/to/vec0.so']);
	});

	test('constructor requests allowExtension so loadExtension can work', () => {
		const { FakeDatabaseSync } = makeFake();
		const Ctor = createNodeDatabaseCtor(FakeDatabaseSync);
		// Reach the wrapped fake via a probe: allowExtension must be requested.
		let captured: { allowExtension?: boolean } | undefined;
		class Probe extends FakeDatabaseSync {
			constructor(filename: string, options?: { allowExtension?: boolean }) {
				super(filename, options);
				captured = options;
			}
		}
		const CtorProbe = createNodeDatabaseCtor(Probe);
		void new Ctor(':x:');
		void new CtorProbe(':y:');
		expect(captured).toEqual({ allowExtension: true });
	});

	test('close() closes the underlying database', () => {
		const { FakeDatabaseSync, calls } = makeFake();
		const db = new (createNodeDatabaseCtor(FakeDatabaseSync))(
			':x:',
		) as unknown as AdapterDb;
		db.close();
		expect(calls.closed).toBe(1);
	});
});
