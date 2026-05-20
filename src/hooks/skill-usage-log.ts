/**
 * Skill usage log — tracks skill delegations and compliance outcomes.
 *
 * Writes one JSONL line per skill-usage event to `.swarm/skill-usage.jsonl`.
 * Follows the same append-only JSONL pattern as knowledge-application.jsonl.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { validateSwarmPath } from './utils.js';

// ============================================================================
// Types
// ============================================================================

/** Single entry in the skill-usage audit log. */
export interface SkillUsageEntry {
	/** Auto-generated unique identifier (UUID v4). */
	id: string;
	/** Repo-relative path to the skill file. */
	skillPath: string;
	/** Name of the agent receiving the skill. */
	agentName: string;
	/** Plan task ID the skill was loaded for. */
	taskID: string;
	/** ISO 8601 timestamp of the event. */
	timestamp: string;
	/** Compliance outcome — 'compliant' | 'violation' | 'partial' | 'not_checked' | custom. */
	complianceVerdict: string;
	/** Optional free-text notes from the reviewer. */
	reviewerNotes?: string;
	/** Session identifier. */
	sessionID: string;
}

/** Filter options for reading skill-usage entries. */
export interface SkillUsageFilterOptions {
	/** Filter entries by session ID (exact match). */
	sessionID?: string;
	/** Filter entries by skill path (exact match). */
	skillPath?: string;
	/** Filter entries by agent name (exact match). */
	agentName?: string;
	/** Filter entries by plan task ID (exact match). */
	taskID?: string;
	/** Filter entries to timestamps within this ISO 8601 range (inclusive). */
	dateRange?: { start: string; end: string };
}

/** Return value from prune operations. */
export interface PruneResult {
	/** Number of entries removed. */
	pruned: number;
	/** Number of entries remaining in the log. */
	remaining: number;
	/** Error message when the write/rename step fails; absent on success. */
	error?: string;
}

// ============================================================================
// Path resolver
// ============================================================================

/** Resolve the absolute path to `.swarm/skill-usage.jsonl`, with swarm-path validation. */
function resolveLogPath(directory: string): string {
	return validateSwarmPath(directory, 'skill-usage.jsonl');
}

// ============================================================================
// DI seam
// ============================================================================

/**
 * Test-only dependency-injection seam. Tests override these without
 * `mock.module` (which leaks across files in Bun's shared test-runner).
 * Restore in `afterEach`.
 */
export const _internals = {
	generateId: (): string => crypto.randomUUID(),
	appendFileSync: fs.appendFileSync.bind(fs),
	readFileSync: fs.readFileSync.bind(fs),
	writeFileSync: fs.writeFileSync.bind(fs),
	renameSync: fs.renameSync.bind(fs),
	mkdirSync: fs.mkdirSync.bind(fs),
	existsSync: fs.existsSync.bind(fs),
	statSync: fs.statSync.bind(fs),
	openSync: fs.openSync.bind(fs),
	readSync: fs.readSync.bind(fs),
	closeSync: fs.closeSync.bind(fs),
};

// ============================================================================
// Append
// ============================================================================

/**
 * Validate and append a single skill-usage entry to the JSONL log.
 *
 * The `id` field is auto-generated; callers provide all other fields.
 * Uses synchronous I/O for consistency with the JSONL append pattern.
 */
export function appendSkillUsageEntry(
	directory: string,
	entry: Omit<SkillUsageEntry, 'id'>,
): void {
	const {
		skillPath,
		agentName,
		taskID,
		timestamp,
		complianceVerdict,
		sessionID,
		reviewerNotes,
	} = entry;

	// Validate required string fields
	if (!skillPath || typeof skillPath !== 'string') {
		throw new Error('skillPath is required and must be a non-empty string');
	}
	if (/\.\.[/\\]/.test(skillPath)) {
		throw new Error('skillPath contains path traversal sequence');
	}
	if (!agentName || typeof agentName !== 'string') {
		throw new Error('agentName is required and must be a non-empty string');
	}
	if (!taskID || typeof taskID !== 'string') {
		throw new Error('taskID is required and must be a non-empty string');
	}
	if (!timestamp || typeof timestamp !== 'string') {
		throw new Error('timestamp is required and must be a non-empty string');
	}
	if (!complianceVerdict || typeof complianceVerdict !== 'string') {
		throw new Error(
			'complianceVerdict is required and must be a non-empty string',
		);
	}
	if (!sessionID || typeof sessionID !== 'string') {
		throw new Error('sessionID is required and must be a non-empty string');
	}

	const resolved = validateSwarmPath(directory, 'skill-usage.jsonl');
	const dir = path.dirname(resolved);

	if (!_internals.existsSync(dir)) {
		_internals.mkdirSync(dir, { recursive: true });
	}

	const fullEntry: SkillUsageEntry = {
		id: _internals.generateId(),
		skillPath,
		agentName,
		taskID,
		timestamp,
		complianceVerdict,
		sessionID,
		...(reviewerNotes !== undefined && { reviewerNotes }),
	};

	_internals.appendFileSync(
		resolved,
		`${JSON.stringify(fullEntry)}\n`,
		'utf-8',
	);
}

// ============================================================================
// Read
// ============================================================================

/**
 * Read and parse skill-usage entries from the JSONL log, optionally filtered.
 *
 * Malformed lines are silently skipped (no throw). Returns an empty array
 * if the log file does not exist.
 */
export function readSkillUsageEntries(
	directory: string,
	options?: SkillUsageFilterOptions,
): SkillUsageEntry[] {
	const resolved = resolveLogPath(directory);

	if (!_internals.existsSync(resolved)) {
		return [];
	}

	const raw = _internals.readFileSync(resolved, 'utf-8');
	const entries: SkillUsageEntry[] = [];

	for (const line of raw.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			entries.push(JSON.parse(trimmed) as SkillUsageEntry);
		} catch {
			// skip malformed line — consistent with knowledge-application pattern
		}
	}

	if (!options) return entries;

	return entries.filter((e) => {
		if (options.sessionID !== undefined && e.sessionID !== options.sessionID) {
			return false;
		}
		if (options.skillPath !== undefined && e.skillPath !== options.skillPath) {
			return false;
		}
		if (options.agentName !== undefined && e.agentName !== options.agentName) {
			return false;
		}
		if (options.taskID !== undefined && e.taskID !== options.taskID) {
			return false;
		}
		if (options.dateRange !== undefined) {
			if (e.timestamp < options.dateRange.start) return false;
			if (e.timestamp > options.dateRange.end) return false;
		}
		return true;
	});
}

// ============================================================================
// Bounded tail read
// ============================================================================

/** Default maximum bytes to read from the end of the log file. */
export const TAIL_BYTES_DEFAULT = 64 * 1024; // 64 KB — covers ~500 entries

/**
 * Read the last `maxBytes` of the skill-usage JSONL log and parse matching
 * entries. Much faster than `readSkillUsageEntries` for large logs because
 * it reads only a bounded number of bytes from the end of the file instead
 * of loading the entire file into memory.
 *
 * Uses low-level `openSync` / `readSync` / `closeSync` to seek to the last
 * `maxBytes` of the file. Skips the first (potentially partial) line that
 * results from starting mid-file. Best-effort: returns an empty array on any
 * I/O or parse error.
 */
export function readSkillUsageEntriesTail(
	directory: string,
	filters: { sessionID?: string },
	maxBytes: number = TAIL_BYTES_DEFAULT,
): SkillUsageEntry[] {
	const logPath = resolveLogPath(directory);
	if (!_internals.existsSync(logPath)) return [];
	try {
		const stat = _internals.statSync(logPath);
		const start = Math.max(0, stat.size - maxBytes);
		const fd = _internals.openSync(logPath, 'r');
		try {
			const readLen = stat.size - start;
			if (readLen === 0) return [];
			const buf = Buffer.alloc(readLen);
			_internals.readSync(fd, buf, 0, buf.length, start);
			const content = buf.toString('utf-8');
			// Skip first partial line only when starting mid-file
			let usable: string;
			if (start > 0) {
				const firstNewline = content.indexOf('\n');
				usable = firstNewline >= 0 ? content.slice(firstNewline + 1) : '';
			} else {
				usable = content;
			}
			const entries: SkillUsageEntry[] = [];
			for (const line of usable.split('\n')) {
				if (!line.trim()) continue;
				try {
					const entry: SkillUsageEntry = JSON.parse(line);
					if (
						filters.sessionID !== undefined &&
						entry.sessionID !== filters.sessionID
					) {
						continue;
					}
					entries.push(entry);
				} catch {
					// skip malformed line
				}
			}
			return entries;
		} finally {
			_internals.closeSync(fd);
		}
	} catch {
		return [];
	}
}

// ============================================================================
// Prune
// ============================================================================

/**
 * Prune the skill-usage log, keeping at most `maxEntriesPerSkill` entries
 * per unique skillPath. Oldest entries beyond the limit are removed.
 *
 * Writes atomically (temp file + rename). No-op if the log file doesn't
 * exist or all skills are within their limits.
 *
 * @returns Stats about how many entries were pruned and how many remain.
 */
export function pruneSkillUsageLog(
	directory: string,
	maxEntriesPerSkill: number = 500,
): PruneResult {
	const resolved = resolveLogPath(directory);

	if (!_internals.existsSync(resolved)) {
		return { pruned: 0, remaining: 0 };
	}

	const allEntries = readSkillUsageEntries(directory);
	if (allEntries.length === 0) {
		return { pruned: 0, remaining: 0 };
	}

	// Group by skillPath
	const groups = new Map<string, SkillUsageEntry[]>();
	for (const entry of allEntries) {
		const list = groups.get(entry.skillPath);
		if (list) list.push(entry);
		else groups.set(entry.skillPath, [entry]);
	}

	let pruned = 0;
	const surviving: SkillUsageEntry[] = [];

	groups.forEach((entries) => {
		if (entries.length <= maxEntriesPerSkill) {
			surviving.push(...entries);
			return;
		}
		// Sort newest-first by timestamp (ISO 8601 is lexicographically sortable)
		entries.sort((a, b) =>
			b.timestamp > a.timestamp ? 1 : b.timestamp < a.timestamp ? -1 : 0,
		);
		const kept = entries.slice(0, maxEntriesPerSkill);
		pruned += entries.length - kept.length;
		surviving.push(...kept);
	});

	if (pruned === 0) {
		return { pruned: 0, remaining: allEntries.length };
	}

	// Write atomically: temp file in same directory, then rename
	const dir = path.dirname(resolved);
	const tmpPath = path.join(dir, `skill-usage-${Date.now()}.tmp`);
	const content = surviving
		.map((e) => JSON.stringify(e))
		.join('\n')
		.concat('\n');

	try {
		_internals.writeFileSync(tmpPath, content, 'utf-8');
		_internals.renameSync(tmpPath, resolved);
	} catch (writeErr) {
		const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
		// Best-effort cleanup of temp file on failure
		try {
			if (_internals.existsSync(tmpPath)) {
				_internals.writeFileSync(tmpPath, '', 'utf-8');
			}
		} catch {
			// ignore cleanup failure
		}
		return { pruned: 0, remaining: allEntries.length, error: msg };
	}

	return { pruned, remaining: surviving.length };
}
