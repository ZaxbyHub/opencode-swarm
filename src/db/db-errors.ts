/**
 * Typed errors for the SQLite durable-state foundation (issue #2480).
 *
 * Callers use `category` to make fail-open decisions and to emit ONE coalesced
 * advisory per condition instead of repeating raw SQLite errors. Messages never
 * contain SQL text or user file contents; at most the `.swarm/swarm.db` artifact
 * name appears.
 */

export type ProjectDbErrorCategory =
	| 'mkdir_failed'
	| 'driver_unavailable'
	| 'open_failed'
	| 'migration_failed';

export type DbWriteErrorCategory =
	| 'disk_full'
	| 'read_only'
	| 'corrupt'
	| 'busy'
	| 'unknown';

export class ProjectDbError extends Error {
	readonly category: ProjectDbErrorCategory;

	constructor(category: ProjectDbErrorCategory, message: string) {
		super(message);
		this.name = 'ProjectDbError';
		this.category = category;
	}
}

export class DbWriteError extends Error {
	readonly category: DbWriteErrorCategory;

	constructor(category: DbWriteErrorCategory, message: string) {
		super(message);
		this.name = 'DbWriteError';
		this.category = category;
	}
}

/**
 * Classify a write/open failure into a `DbWriteErrorCategory` from errno and
 * SQLite error text. Used by the group-commit writer to decide retry/degrade
 * behavior (issue #2480 disk-full / read-only / corrupt handling).
 */
export function classifyDbWriteError(err: unknown): DbWriteErrorCategory {
	const errno = (err as NodeJS.ErrnoException | null)?.code;
	if (errno === 'ENOSPC') return 'disk_full';
	if (errno === 'EACCES' || errno === 'EROFS' || errno === 'EPERM')
		return 'read_only';
	const message = err instanceof Error ? err.message : String(err);
	const upper = message.toUpperCase();
	if (
		upper.includes('SQLITE_FULL') ||
		upper.includes('DATABASE OR DISK IS FULL')
	) {
		return 'disk_full';
	}
	if (
		upper.includes('SQLITE_READONLY') ||
		upper.includes('ATTEMPT TO WRITE A READONLY')
	) {
		return 'read_only';
	}
	if (
		upper.includes('SQLITE_CORRUPT') ||
		upper.includes('DATABASE DISK IMAGE IS MALFORMED') ||
		upper.includes('NOT A DATABASE')
	) {
		return 'corrupt';
	}
	if (upper.includes('SQLITE_BUSY') || upper.includes('DATABASE IS LOCKED')) {
		return 'busy';
	}
	return 'unknown';
}
