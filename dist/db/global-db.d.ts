/**
 * Global SQLite database singleton for opencode-swarm.
 *
 * Owns `global-rules.db` in the platform config directory. Stores cross-project
 * rules and agent prompt sections. Per-project QA gate profiles live in the
 * project DB (see `./project-db.ts`), not here.
 */
import type { Database } from 'bun:sqlite';
/**
 * Run all pending migrations on the provided database.
 * Idempotent: existing migrations are not re-applied.
 */
export declare function runGlobalMigrations(db: Database): void;
/**
 * Return the process-wide singleton global database, creating it on first call.
 * Directory is created if it does not exist. WAL mode is enabled immediately.
 */
export declare function getGlobalDb(): Database;
/**
 * Close and clear the global database singleton. Test-only.
 */
export declare function closeGlobalDb(): void;
