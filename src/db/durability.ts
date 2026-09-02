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
	// Operational / diagnostic — NORMAL.
	insight_candidate: 'normal',
	phase_report: 'normal',
	project_constraints: 'normal',
	migration_failures: 'normal',
	schema_migrations: 'normal',
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
 * NESTING CAVEAT (final-critic note): nesting a normal-class helper inside an
 * open full-class transaction would restore NORMAL before the OUTER commit.
 * No production path nests these helpers today (group-commit ops never call
 * the qa-gate/receipt writers); if nesting is ever introduced, restore the
 * pre-call value instead.
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
