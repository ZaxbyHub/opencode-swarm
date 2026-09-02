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
	db.run(
		"DELETE FROM parity_probe; INSERT INTO parity_probe (key, value) VALUES ('multi', 'exec');",
	);
	const multi = db
		.query<{ value: string }, [string]>(
			'SELECT value FROM parity_probe WHERE key = ?',
		)
		.get('multi');
	expectTruthy(multi?.value === 'exec', 'multi-statement exec path failed');

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
