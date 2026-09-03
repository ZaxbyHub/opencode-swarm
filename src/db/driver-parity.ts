/**
 * Bun ↔ Node driver-parity contract for `.swarm/swarm.db` (issue #2480
 * obligation 2).
 *
 * A single suite, run against WHATEVER driver the shared sqlite loader
 * resolved:
 * - under `bun test`: the real `bun:sqlite` driver (and the node adapter
 *   against the strict fake in `sqlite-loader.test.ts`);
 * - under the merge-queue smoke job (`scripts/repro-1873.mjs`, 3-OS, real
 *   Node 22): the real `node:sqlite` driver through the adapter.
 *
 * The contract pins the behavioral deltas documented for #1873/#2480:
 * - EXACT parameter counts: every bound-parameter call must pass exactly as
 *   many values as the statement has placeholders. `node:sqlite` rejects a
 *   mismatched count (`SQLITE_RANGE`); `bun:sqlite` tolerates some lax forms.
 *   Portable code never relies on the lax form.
 * - NO-BINDINGS run() RETURNS A Changes-SHAPED OBJECT (#2539): bun:sqlite's
 *   run() always returns `{ changes, lastInsertRowid }`; the node adapter
 *   rebuilds it from connection-level counters after exec(). `.changes` is
 *   pinned for single-statement DML only (the form production code reads).
 *   The SHAPE is pinned for every form (cases 4/4b/4c). Three value deltas
 *   are deliberately NOT pinned because the drivers genuinely diverge and no
 *   production reader exists: multi-statement strings (bun SUMS `.changes`
 *   across statements, changes() reports the last one), non-DML statements
 *   (bun reports 0, changes() keeps the previous DML's count), and
 *   trigger-amplified DML (bun's run() INCLUDES trigger-fired rows while
 *   SQL changes() — what the adapter probe reads — EXCLUDES them; live-probed:
 *   1 direct + 1 trigger row → bun {changes: 2}, adapter 1).
 * - Multi-statement strings only through the no-parameter `run(sql)` path
 *   (which routes to `exec` on both drivers).
 * - Transaction + SAVEPOINT nesting round trip.
 * - WAL / busy_timeout / synchronous pragma reads.
 */

import type { Database } from 'bun:sqlite';

export interface DriverParityProbe {
	/** True when the resolved driver is the node:sqlite adapter. */
	isNodeAdapter: boolean;
}

function expectTruthy(condition: boolean, message: string): void {
	if (!condition) {
		throw new Error(`driver-parity contract violated: ${message}`);
	}
}

/**
 * Assert the driver-parity contract on a FRESH database (the caller owns its
 * lifecycle and closes it). Throws on the first violation.
 */
export function runDriverParityContract(
	db: Database,
	probe?: DriverParityProbe,
): void {
	// 1. Exact parameter counts — the #1873 SQLITE_RANGE class.
	db.run(
		'CREATE TABLE IF NOT EXISTS parity_probe (key TEXT PRIMARY KEY, value TEXT)',
	);
	db.run('INSERT INTO parity_probe (key, value) VALUES (?, ?)', ['a', 'one']);
	const row = db
		.query<{ value: string }, [string]>(
			'SELECT value FROM parity_probe WHERE key = ?',
		)
		.get('a');
	expectTruthy(row?.value === 'one', 'exact-parameter-count SELECT failed');

	// node:sqlite strictness is observable when the adapter is active: a
	// bound parameter against a statement with NO placeholder must throw
	// (SQLITE_RANGE / "column index out of range" — the exact #1873 delta).
	// (The inverse — zero values for an existing placeholder — is tolerated by
	// BOTH drivers, so it is deliberately not asserted.)
	if (probe?.isNodeAdapter) {
		let threw = false;
		try {
			db.run('SELECT 1', ['extra-param-with-no-placeholder']);
		} catch {
			threw = true;
		}
		expectTruthy(
			threw,
			'node adapter accepted a bound param with no placeholder',
		);
	}

	// 2. Transactions round trip; a failure inside rolls back.
	db.run('DELETE FROM parity_probe');
	const commit = db.transaction(() => {
		db.run('INSERT INTO parity_probe (key, value) VALUES (?, ?)', [
			't1',
			'committed',
		]);
	});
	commit();
	const rollback = db.transaction(() => {
		db.run('INSERT INTO parity_probe (key, value) VALUES (?, ?)', [
			't2',
			'rolled-back',
		]);
		throw new Error('intentional');
	});
	let rolledBack = false;
	try {
		rollback();
	} catch {
		rolledBack = true;
	}
	expectTruthy(rolledBack, 'transaction error did not propagate');
	const count =
		db.query<{ n: number }, []>('SELECT COUNT(*) as n FROM parity_probe').get()
			?.n ?? -1;
	expectTruthy(
		count === 1,
		`transaction rollback leaked rows (count=${count})`,
	);

	// 3. SAVEPOINT nesting inside a transaction.
	db.transaction(() => {
		db.run('INSERT INTO parity_probe (key, value) VALUES (?, ?)', [
			't3',
			'outer',
		]);
		const nested = db.transaction(() => {
			db.run('INSERT INTO parity_probe (key, value) VALUES (?, ?)', [
				't4',
				'inner',
			]);
		});
		nested();
	})();
	const inner = db
		.query<{ value: string }, [string]>(
			'SELECT value FROM parity_probe WHERE key = ?',
		)
		.get('t4');
	expectTruthy(
		inner?.value === 'inner',
		'SAVEPOINT-nested write missing after commit',
	);

	// 4. Multi-statement strings via the no-parameter run() path (exec on both
	//    drivers) — the form the v14+ single-statement migrations also use.
	//    The return VALUE is deliberately NOT asserted: bun aggregates
	//    `.changes` across statements while the node adapter's changes() probe
	//    reports the last statement only (an intentionally unpinned delta).
	//    The return SHAPE is pinned below (driver-agnostic) so a future
	//    adapter regression back to `undefined` cannot hide behind this case.
	const multiRun = db.run(
		"DELETE FROM parity_probe; INSERT INTO parity_probe (key, value) VALUES ('multi', 'exec');",
	);
	expectTruthy(
		multiRun != null &&
			typeof multiRun === 'object' &&
			typeof multiRun.changes === 'number' &&
			(typeof multiRun.lastInsertRowid === 'number' ||
				typeof multiRun.lastInsertRowid === 'bigint'),
		'multi-statement no-bindings run() must return a Changes-shaped object (issue #2539)',
	);
	const multi = db
		.query<{ value: string }, [string]>(
			'SELECT value FROM parity_probe WHERE key = ?',
		)
		.get('multi');
	expectTruthy(multi?.value === 'exec', 'multi-statement exec path failed');

	// 4b. No-bindings run() returns a Changes-shaped object (#2539). Under bun
	//     this is native; under the node adapter the no-param branch executes
	//     via exec() (void) and rebuilds the object from connection-level
	//     counters. Pre-fix the adapter returned undefined here, so
	//     `.changes` readers (the memory-family ATTACH merge) threw
	//     `Cannot read properties of undefined (reading 'changes')`.
	//     Pinned for single-statement DML only — the form production reads.
	const inserted = db.run(
		"INSERT INTO parity_probe (key, value) VALUES ('changes-a', '1'), ('changes-b', '2')",
	);
	expectTruthy(
		inserted != null && typeof inserted === 'object',
		'no-bindings run() must return a Changes-shaped object (issue #2539)',
	);
	expectTruthy(
		typeof inserted?.changes === 'number' && inserted.changes === 2,
		`no-bindings run() .changes must count modified rows, got ${String(
			inserted?.changes,
		)} (issue #2539)`,
	);
	expectTruthy(
		typeof inserted?.lastInsertRowid === 'number' ||
			typeof inserted?.lastInsertRowid === 'bigint',
		'no-bindings run() .lastInsertRowid must be number | bigint (issue #2539)',
	);
	// INSERT OR IGNORE that inserts nothing reports 0 — the exact
	// memory-family ATTACH-merge shape (INSERT OR IGNORE … SELECT * FROM staged).
	const ignored = db.run(
		"INSERT OR IGNORE INTO parity_probe (key, value) VALUES ('changes-a', 'duplicate')",
	);
	expectTruthy(
		ignored?.changes === 0,
		`INSERT OR IGNORE with 0 inserts must report .changes === 0, got ${String(
			ignored?.changes,
		)} (issue #2539)`,
	);
	// DML matching no rows reports 0.
	const updatedNone = db.run(
		"UPDATE parity_probe SET value = 'x' WHERE key = 'no-such-key'",
	);
	expectTruthy(
		updatedNone?.changes === 0,
		`no-bindings UPDATE matching no rows must report .changes === 0, got ${String(
			updatedNone?.changes,
		)} (issue #2539)`,
	);
	// The with-bindings form is unchanged by #2539 (statement.run's native
	// return on both drivers).
	const bound = db.run('INSERT INTO parity_probe (key, value) VALUES (?, ?)', [
		'changes-bound',
		'3',
	]);
	expectTruthy(
		bound?.changes === 1,
		`with-bindings run() .changes must stay 1, got ${String(bound?.changes)}`,
	);

	// 4c. SHAPE-only pins for the two documented value-unpinned deltas. The
	//     VALUES diverge by design (multi-statement: bun sums vs probe's last
	//     statement; non-DML: bun 0 vs probe's previous DML count) and are NOT
	//     asserted — but the returned object must be Changes-shaped on BOTH
	//     drivers, so a future adapter regression to `undefined` fails here
	//     even on the unpinned paths.
	const nonDml = db.run('SELECT 1');
	expectTruthy(
		nonDml != null &&
			typeof nonDml === 'object' &&
			typeof nonDml.changes === 'number' &&
			(typeof nonDml.lastInsertRowid === 'number' ||
				typeof nonDml.lastInsertRowid === 'bigint'),
		'non-DML no-bindings run() must return a Changes-shaped object (issue #2539)',
	);

	// 5. Pragmas the foundation relies on.
	const journal = db
		.query<{ journal_mode: string }, []>('PRAGMA journal_mode')
		.get()?.journal_mode;
	expectTruthy(
		journal === 'wal' || journal === 'memory' || journal === 'delete',
		`unexpected journal_mode ${String(journal)}`,
	);
	const busy = db
		.query<{ timeout: number }, []>('PRAGMA busy_timeout')
		.get()?.timeout;
	expectTruthy(typeof busy === 'number', 'busy_timeout not readable');

	db.run('DROP TABLE IF EXISTS parity_probe');
}
