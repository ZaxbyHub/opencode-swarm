/**
 * Service layer for the `qa_gate_session_override` table in the per-project
 * database (issue #2668).
 *
 * A session's ratchet-tighter QA gate overrides (`/swarm qa-gates override`)
 * are durable runtime policy: they must survive a host restart, unlike the
 * ephemeral execution authority (leases, child handles, in-flight timers) that
 * expires at the rehydrate boundary. The in-memory
 * `AgentSessionState.qaGateSessionOverrides` remains the live cache the
 * enforcement sites read; this table is the restart authority, restored by
 * `rehydrateState` and kept in lockstep (created by the durable-first write in
 * the `/swarm qa-gates override` command, deleted at session end/stale
 * eviction).
 *
 * Semantics mirror the spec-level profile ratchet: only `true` wins. A session
 * with no `true` gates has NO row — an empty merge deletes it.
 */

import { warn } from '../utils/logger.js';
import {
	DURABILITY_CLASSES,
	withImmediateTransaction as withSharedImmediateTransaction,
} from './durability.js';
import { getProjectDb, projectDbExists } from './project-db.js';
import { DEFAULT_QA_GATES, type QaGates } from './qa-gate-profile.js';

interface QaGateSessionOverrideRow {
	session_id: string;
	gates: string;
	updated_at: string;
}

/** Filter a parsed payload down to known boolean gate keys that are `true`. */
function sanitizeTrueGates(parsed: unknown): Partial<QaGates> {
	const result: Partial<QaGates> = {};
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return result;
	}
	const knownKeys = new Set(Object.keys(DEFAULT_QA_GATES));
	for (const key of Object.keys(parsed as Record<string, unknown>)) {
		if (
			knownKeys.has(key) &&
			(parsed as Record<string, unknown>)[key] === true
		) {
			result[key as keyof QaGates] = true;
		}
	}
	return result;
}

/** Parse a stored gates payload fail-closed: malformed bytes read as no override. */
function parseStoredGates(sessionId: string, raw: string): Partial<QaGates> {
	try {
		return sanitizeTrueGates(JSON.parse(raw));
	} catch (err) {
		warn(
			`[qa-gate-session-override] skipping unparseable override row for session "${sessionId}": ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		return {};
	}
}

/**
 * Read the durable ratchet-tighter overrides for a session.
 *
 * Read-only: if `.swarm/swarm.db` does not exist yet, returns `{}`
 * without creating the DB file. A malformed row fails closed to `{}`
 * (with a debug-gated warn naming the session) — corruption must not
 * break rehydration or silently widen the effective gates.
 */
export function getOverrideForSession(
	directory: string,
	sessionId: string,
): Partial<QaGates> {
	if (!projectDbExists(directory) || !sessionId) return {};
	const db = getProjectDb(directory);
	const row = db
		.query<QaGateSessionOverrideRow, [string]>(
			'SELECT session_id, gates, updated_at FROM qa_gate_session_override WHERE session_id = ?',
		)
		.get(sessionId);
	if (!row) return {};
	return parseStoredGates(sessionId, row.gates);
}

/**
 * Merge ratchet-tighter gates into a session's durable override row.
 *
 * Only `true` values win (mirrors `getEffectiveGates` semantics); a `false`
 * input never disables. If the merged map has no `true` gates the row is
 * DELETED (empty-overrides invariant, #2668) — an empty override is the
 * absence of policy, not a policy.
 */
export function setOverrideForSession(
	directory: string,
	sessionId: string,
	gates: Partial<QaGates>,
): Partial<QaGates> {
	if (!sessionId)
		throw new Error('setOverrideForSession requires a session id');
	const db = getProjectDb(directory);
	return withSharedImmediateTransaction(
		db,
		DURABILITY_CLASSES.qa_gate_session_override,
		() => {
			const row = db
				.query<QaGateSessionOverrideRow, [string]>(
					'SELECT session_id, gates, updated_at FROM qa_gate_session_override WHERE session_id = ?',
				)
				.get(sessionId);
			const current = row ? parseStoredGates(sessionId, row.gates) : {};
			// Ratchet-only merge: sanitize the INCOMING patch first so a `false`
			// input can never overwrite a stored `true` before sanitization.
			const merged = sanitizeTrueGates({
				...current,
				...sanitizeTrueGates(gates),
			});
			if (Object.keys(merged).length === 0) {
				db.run('DELETE FROM qa_gate_session_override WHERE session_id = ?', [
					sessionId,
				]);
				return {};
			}
			db.run(
				`INSERT INTO qa_gate_session_override (session_id, gates, updated_at)
				VALUES (?, ?, datetime('now'))
				ON CONFLICT(session_id) DO UPDATE SET gates = excluded.gates, updated_at = excluded.updated_at`,
				[sessionId, JSON.stringify(merged)],
			);
			return merged;
		},
	);
}

/**
 * Delete a session's durable override row. Idempotent: clearing an absent
 * row is a no-op. Returns true when a row was removed.
 */
export function clearOverrideForSession(
	directory: string,
	sessionId: string,
): boolean {
	if (!projectDbExists(directory) || !sessionId) return false;
	const db = getProjectDb(directory);
	return withSharedImmediateTransaction(
		db,
		DURABILITY_CLASSES.qa_gate_session_override,
		() => {
			const result = db.run(
				'DELETE FROM qa_gate_session_override WHERE session_id = ?',
				[sessionId],
			);
			return result.changes > 0;
		},
	);
}

/**
 * Delete every durable override row in the project. Used by
 * `/swarm reset-session`, which clears all in-memory sessions for the
 * project — their durable policy rows go with them (bounded: one row per
 * session). Returns the number of rows removed.
 */
export function clearAllSessionOverrides(directory: string): number {
	if (!projectDbExists(directory)) return 0;
	const db = getProjectDb(directory);
	return withSharedImmediateTransaction(
		db,
		DURABILITY_CLASSES.qa_gate_session_override,
		() => {
			const result = db.run('DELETE FROM qa_gate_session_override');
			return result.changes;
		},
	);
}

/** Conservative SQLite bind budget for orphan-row deletion statements. */
const ORPHAN_DELETE_BATCH_SIZE = 500;

function deleteOrphanOverrideBatch(
	db: ReturnType<typeof getProjectDb>,
	sessionIds: string[],
): number {
	if (sessionIds.length === 0) return 0;
	const placeholders = sessionIds.map(() => '?').join(', ');
	return db.run(
		`DELETE FROM qa_gate_session_override WHERE session_id IN (${placeholders})`,
		sessionIds,
	).changes;
}

/**
 * Dependency-injection seam used by sweepOrphanOverrides and its bounded-batch
 * regression test. The test mutates and restores this seam in afterEach rather
 * than using mock.module, which can leak across Bun test files; see
 * gitignore-warning.ts:_internals for the pattern and rationale.
 */
export const _internals: {
	deleteOrphanOverrideBatch: typeof deleteOrphanOverrideBatch;
} = { deleteOrphanOverrideBatch };

/**
 * Delete override rows whose session is no longer live in this project
 * (#2668 orphan-row reaper). `sweepStaleSessions` can evict a stale session
 * in-memory WITHOUT being able to clear its durable row — the hot-path
 * `ensureAgentSession` sweep runs with no `directory`, so the project DB is
 * unreachable there. This reaper runs at the rehydrate boundary (which knows
 * the directory) and removes every row whose session id is not in
 * `keepSessionIds` — the restored/live sessions of the hydrating project.
 * Bounded: one indexed scan over a session-keyed table. Returns the number
 * of orphaned rows removed.
 */
export function sweepOrphanOverrides(
	directory: string,
	keepSessionIds: ReadonlySet<string>,
): number {
	if (!projectDbExists(directory)) return 0;
	const db = getProjectDb(directory);
	return withSharedImmediateTransaction(
		db,
		DURABILITY_CLASSES.qa_gate_session_override,
		() => {
			const rows = db
				.query<Pick<QaGateSessionOverrideRow, 'session_id'>, []>(
					'SELECT session_id FROM qa_gate_session_override',
				)
				.all();
			const orphans = rows
				.map((row) => row.session_id)
				.filter((sessionId) => !keepSessionIds.has(sessionId));
			let removed = 0;
			for (
				let offset = 0;
				offset < orphans.length;
				offset += ORPHAN_DELETE_BATCH_SIZE
			) {
				removed += _internals.deleteOrphanOverrideBatch(
					db,
					orphans.slice(offset, offset + ORPHAN_DELETE_BATCH_SIZE),
				);
			}
			return removed;
		},
	);
}
