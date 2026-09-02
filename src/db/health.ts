/**
 * swarm.db health probe (issue #2480 obligation 5).
 *
 * The one sanctioned read-only surface for diagnose-style health checks: runs
 * the size-capped quick_check + pragma/migration-failure probes and returns a
 * structured snapshot. Keeping the SQL here (inside `src/db/**`) means the
 * raw-handle confinement and writer-registry seams stay honest — callers like
 * `diagnose-service` consume a plain object.
 */

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalProjectKey } from './canonical-project.js';
import { getProjectDb, projectDbPath } from './project-db.js';

/** quick_check size cap: an oversized DB reports `too_large` instead of scanning inline. */
export const SWARM_DB_QUICK_CHECK_MAX_BYTES = 64 * 1024 * 1024;

export type SwarmDbHealthSnapshot =
	| { kind: 'absent' }
	| { kind: 'too_large'; sizeBytes: number }
	| {
			kind: 'open';
			quickCheck: string;
			journalMode: string;
			pageCount: number;
			migrationFailures: number;
			/** #2480 review F-07: stale marker file present (a recorded
			 * failure whose cleanup could not run — surfaced for diagnosis). */
			staleMarker: boolean;
	  }
	| { kind: 'error'; category: string; message: string };

/**
 * Probe `.swarm/swarm.db` health. Never opens-for-create (an absent DB is
 * `absent`, which callers render as healthy) and never throws.
 */
export function getSwarmDbHealthSnapshot(
	directory: string,
): SwarmDbHealthSnapshot {
	try {
		const size = statSync(projectDbPath(directory)).size;
		if (size > SWARM_DB_QUICK_CHECK_MAX_BYTES) {
			return { kind: 'too_large', sizeBytes: size };
		}
	} catch {
		return { kind: 'absent' };
	}
	// Read the marker BEFORE getProjectDb: a successful open runs the
	// migration loop, which removes the marker by design — probing after
	// the open would almost always see it already cleaned.
	const staleMarker = existsSync(
		join(canonicalProjectKey(directory), '.swarm', 'db-migration-failure.json'),
	);
	try {
		const db = getProjectDb(directory);
		return {
			kind: 'open',
			quickCheck:
				db.query<{ quick_check: string }, []>('PRAGMA quick_check').get()
					?.quick_check ?? 'unknown',
			journalMode:
				db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()
					?.journal_mode ?? 'unknown',
			pageCount:
				db.query<{ page_count: number }, []>('PRAGMA page_count').get()
					?.page_count ?? -1,
			migrationFailures:
				db
					.query<{ n: number }, []>(
						'SELECT COUNT(*) as n FROM migration_failures',
					)
					.get()?.n ?? 0,
			// Captured pre-open (see above) — canonical-keyed spelling.
			staleMarker,
		};
	} catch (err) {
		const category =
			err && typeof err === 'object' && 'category' in err
				? String((err as { category: unknown }).category)
				: 'unknown';
		return {
			kind: 'error',
			category,
			message: err instanceof Error ? err.message : String(err),
		};
	}
}
