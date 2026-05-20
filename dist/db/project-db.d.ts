/**
 * Per-project SQLite database for opencode-swarm.
 *
 * Owns `.swarm/swarm.db` in each project directory. Stores per-project
 * constraints and QA gate profiles. One cached instance per normalized
 * directory path.
 */
import type { Database } from 'bun:sqlite';
/**
 * Run all pending migrations on the provided database.
 * Idempotent: existing migrations are not re-applied.
 */
export declare function runProjectMigrations(db: Database): void;
/**
 * Return the absolute path to `.swarm/swarm.db` for the given directory.
 * Does not create the file or any parent directory.
 */
export declare function projectDbPath(directory: string): string;
/**
 * Return true iff the project DB file already exists on disk. Does not
 * open the DB, create `.swarm/`, or run migrations. Intended for
 * read-only callers (e.g. `getProfile`) that must avoid mutating the
 * workspace just to check for a missing record.
 */
export declare function projectDbExists(directory: string): boolean;
/**
 * Return the cached project database for the given directory, opening it
 * if needed. Creates `.swarm/` if absent and enables WAL + foreign keys.
 */
export declare function getProjectDb(directory: string): Database;
/**
 * Close and remove the cached project database for the given directory.
 * Test-only.
 */
export declare function closeProjectDb(directory: string): void;
/**
 * Close and remove all cached project databases.
 * Test-only.
 */
export declare function closeAllProjectDbs(): void;
