/**
 * Per-table durability classes for `.swarm/swarm.db` (issue #2480 obligation 4).
 *
 * SQLite's `synchronous` pragma is connection-scoped and takes effect at the next
 * commit, so "per-table durability classes" are implemented by escalating the
 * pragma around write transactions whose target table demands it:
 *
 * - `full`  — terminal-state streams (authoritative rows whose loss changes an
 *   outcome): `synchronous = FULL` for the wrapping transaction. Authoritative
 *   state must never inherit the rebuildable-index durability setting.
 * - `normal` — telemetry/operational/diagnostic rows: `synchronous = NORMAL`
 *   (WAL + NORMAL is durable across application crashes; only an OS/power
 *   failure can lose the tail — acceptable for rebuildable streams).
 *
 * A batch that contains ANY `full`-class write runs the WHOLE transaction at
 * FULL (escalation rule, group-commit writer consults `batchDurabilityClass`).
 */

import type { Database } from 'bun:sqlite';

/** The durability class of every table in `.swarm/swarm.db`. */
export const DURABILITY_CLASSES: Readonly<Record<string, 'full' | 'normal'>> = {
	// Terminal-state streams — FULL.
	qa_gate_profile: 'full',
	qa_gate_profile_identity: 'full',
	task_checkpoint_receipt: 'full',
	coordination_event: 'full',
	coordination_state: 'full',
	coordination_lease: 'full',
	coordination_import: 'full',
	// Plan-ledger event bytes, terminal projection state, and import markers are
	// authoritative and must commit together at synchronous=FULL (#2484).
	plan_ledger_event: 'full',
	plan_ledger_state: 'full',
	plan_ledger_import: 'full',
	// Operational / diagnostic — NORMAL.
	insight_candidate: 'normal',
	phase_report: 'normal',
	project_constraints: 'normal',
	migration_failures: 'normal',
	schema_migrations: 'normal',
	// D3 observability sink (#2482) — rebuildable query authority; the
	// bounded `.swarm/telemetry.jsonl` stream remains the operational record.
	observability_event: 'normal',
	observability_sink_health: 'normal',
	observability_import: 'normal',
};

/** Escalation rule: any full-class op makes the whole batch full-class. */
export function batchDurabilityClass(
	classes: Iterable<'full' | 'normal'>,
): 'full' | 'normal' {
	for (const cls of classes) {
		if (cls === 'full') return 'full';
	}
	return 'normal';
}

/** Apply the `synchronous` pragma for a durability class. Cheap and idempotent. */
export function applySynchronousForClass(
	db: Database,
	cls: 'full' | 'normal',
): void {
	db.run(
		cls === 'full'
			? 'PRAGMA synchronous = FULL;'
			: 'PRAGMA synchronous = NORMAL;',
	);
}

/**
 * Run `fn` with the connection's `synchronous` pragma set for `cls`, restoring
 * NORMAL afterwards. `fn` is expected to complete its own transaction (or be
 * composed inside one); the pragma takes effect at commit time.
 *
 * The connection default is NORMAL (telemetry class), so restoring NORMAL — not
 * "the previous value" — is the correct post-condition: nothing outside the
 * foundation ever sets a different value on this connection.
 *
 * This low-level pragma helper does not own a transaction and therefore must
 * not be nested. Transactional callers use `withImmediateTransaction`, whose
 * owner tracking prevents a nested helper from lowering the outer commit's
 * durability.
 */
export function withDurabilityClass<T>(
	db: Database,
	cls: 'full' | 'normal',
	fn: () => T,
): T {
	applySynchronousForClass(db, cls);
	try {
		return fn();
	} finally {
		// Restore the telemetry-class default even on the throw path.
		applySynchronousForClass(db, 'normal');
	}
}

type TransactionOwner = {
	readonly durability: 'full' | 'normal';
	depth: number;
};

const transactionOwners = new WeakMap<Database, TransactionOwner>();

export interface ImmediateTransactionHooks {
	beforeBegin?: (db: Database) => void;
	beforeOuterCommit?: (db: Database) => void;
	afterOuterCommit?: (db: Database) => void;
}

/**
 * Run a synchronous immediate transaction without allowing a nested call to
 * lower the connection durability before the real outer commit (#2481).
 */
export function withImmediateTransaction<T>(
	db: Database,
	cls: 'full' | 'normal',
	fn: () => T,
	hooks: ImmediateTransactionHooks = {},
): T {
	const owner = transactionOwners.get(db);
	if (owner) {
		if (cls === 'full' && owner.durability !== 'full') {
			throw new Error(
				'Cannot nest a FULL coordination transaction inside a NORMAL owner',
			);
		}
		owner.depth += 1;
		try {
			return db.transaction(fn)();
		} finally {
			owner.depth -= 1;
		}
	}
	if (db.inTransaction) {
		throw new Error(
			'Refusing to nest inside an unknown non-coordination-owned transaction',
		);
	}

	hooks.beforeBegin?.(db);
	applySynchronousForClass(db, cls);
	transactionOwners.set(db, { durability: cls, depth: 1 });
	db.run('BEGIN IMMEDIATE');
	let committed = false;
	try {
		const result = fn();
		hooks.beforeOuterCommit?.(db);
		db.run('COMMIT');
		committed = true;
		// Post-commit observers cannot make the durable operation un-happen. Let
		// their error propagate, but never misreport the commit as rolled back.
		hooks.afterOuterCommit?.(db);
		return result;
	} catch (err) {
		if (!committed) {
			try {
				db.run('ROLLBACK');
			} catch {
				// Preserve the original transaction failure.
			}
		}
		throw err;
	} finally {
		transactionOwners.delete(db);
		applySynchronousForClass(db, 'normal');
	}
}

export const _transactionInternals = {
	transactionOwners,
};
