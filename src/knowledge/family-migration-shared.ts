/**
 * #1850: shared lock config for family-migration engines.
 *
 * Both the knowledge family (`src/knowledge/family-migration.ts`) and the
 * memory family (`src/memory/memory-family-migration.ts`) use the SAME lock
 * discipline. Centralizing it here ensures one source of truth — a change to
 * the stale window or retry policy applies to both subsystems.
 */

/**
 * Lock stale window for the migration critical section. The default
 * knowledge-store `stale: 5000` (5 s) is too short for an 8+ file merge under
 * load; a long merge would have its lock stolen by a concurrent writer
 * mid-flight (issue #1846 critic C9). 30 s comfortably covers worst-case
 * merges of large corpora.
 */
export const MIGRATION_LOCK_STALE_MS = 30_000;

/** Retry config for acquiring the migration lock. */
export const MIGRATION_LOCK_RETRIES = {
	retries: { retries: 10, minTimeout: 100, maxTimeout: 500 },
} as const;
