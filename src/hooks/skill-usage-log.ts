/**
 * Skill usage log — tracks skill delegations and compliance outcomes.
 *
 * Writes one JSONL line per skill-usage event to `.swarm/skill-usage.jsonl`.
 * Follows the same append-only JSONL pattern as knowledge-application.jsonl.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bumpKnowledgeConfidenceBatch } from './knowledge-store.js';
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
	/** Skill version at the time of this usage event (omitted for pre-versioning entries). */
	skillVersion?: number;
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
	pruneSkillUsageLog,
	resolveSourceKnowledgeIds,
	applySkillUsageFeedback,
	parseGeneratedFromKnowledge,
	computeComplianceByVersion,
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
		skillVersion,
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
		...(skillVersion !== undefined && { skillVersion }),
	};

	_internals.appendFileSync(
		resolved,
		`${JSON.stringify(fullEntry)}\n`,
		'utf-8',
	);

	try {
		const stat = _internals.statSync(resolved);
		if (stat.size > SKILL_USAGE_LOG_ROTATE_BYTES) {
			_internals.pruneSkillUsageLog(
				directory,
				SKILL_USAGE_LOG_MAX_ENTRIES_PER_SKILL,
			);
		}
	} catch {
		// best-effort compaction check — fail-open
	}
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
export const MAX_TAIL_BYTES = TAIL_BYTES_DEFAULT;
const SKILL_USAGE_LOG_ROTATE_BYTES = 1024 * 1024; // 1 MB
const SKILL_USAGE_LOG_MAX_ENTRIES_PER_SKILL = 500;

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
		const normalizedMaxBytes = Number.isFinite(maxBytes)
			? maxBytes
			: TAIL_BYTES_DEFAULT;
		const boundedMaxBytes = Math.min(
			Math.max(1, normalizedMaxBytes),
			MAX_TAIL_BYTES,
		);
		const stat = _internals.statSync(logPath);
		const start = Math.max(0, stat.size - boundedMaxBytes);
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
// Per-version compliance
// ============================================================================

export interface VersionComplianceStats {
	compliant: number;
	violation: number;
	total: number;
	rate: number;
}

export function computeComplianceByVersion(
	entries: SkillUsageEntry[],
	skillPath: string,
): Map<number | undefined, VersionComplianceStats> {
	const map = new Map<number | undefined, VersionComplianceStats>();
	const normalizedTarget = skillPath.replace(/^file:/, '').replace(/\\/g, '/');

	for (const e of entries) {
		let p = e.skillPath;
		if (p.startsWith('file:')) p = p.slice(5);
		const normalized = p.replace(/\\/g, '/');
		if (
			normalized !== normalizedTarget &&
			!normalizedTarget.endsWith(`/${normalized}`) &&
			!normalized.endsWith(`/${normalizedTarget}`)
		) {
			continue;
		}

		const version = e.skillVersion;
		let stats = map.get(version);
		if (!stats) {
			stats = { compliant: 0, violation: 0, total: 0, rate: 0 };
			map.set(version, stats);
		}
		stats.total += 1;
		if (e.complianceVerdict === 'compliant') stats.compliant += 1;
		if (e.complianceVerdict === 'violation') stats.violation += 1;
	}

	for (const stats of map.values()) {
		stats.rate = stats.total === 0 ? 0 : stats.compliant / stats.total;
	}

	return map;
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

// ============================================================================
// Frontmatter parsing — source knowledge IDs
// ============================================================================

/**
 * Read a SKILL.md file and extract the `generated_from_knowledge` UUIDs
 * from its YAML frontmatter.
 *
 * Expected frontmatter shape:
 * ```yaml
 * ---
 * name: some-skill
 * generated_from_knowledge:
 *   - uuid-1
 *   - uuid-2
 * ---
 * ```
 *
 * Returns an empty array if the file doesn't exist, has no frontmatter,
 * or the `generated_from_knowledge` key is absent.
 */
export async function resolveSourceKnowledgeIds(
	directory: string,
	skillPath: string,
): Promise<string[]> {
	try {
		// Strip file: protocol prefix from skill path (e.g., "file:.opencode/skills/...")
		let cleanPath = skillPath;
		if (cleanPath.startsWith('file:')) {
			cleanPath = cleanPath.slice(5);
		}

		// Reject path traversal sequences
		if (/\.\.[/\\]/.test(cleanPath)) {
			return [];
		}

		// Resolve to absolute and validate containment under directory
		const absolute = path.normalize(
			path.isAbsolute(cleanPath)
				? cleanPath
				: path.resolve(directory, cleanPath),
		);
		const baseDir = path.normalize(path.resolve(directory));

		// Ensure the resolved path starts with the project directory
		const isContained =
			process.platform === 'win32'
				? absolute.toLowerCase().startsWith((baseDir + path.sep).toLowerCase())
				: absolute.startsWith(baseDir + path.sep);

		if (!isContained) {
			return [];
		}

		if (!_internals.existsSync(absolute)) {
			return [];
		}

		const content = _internals.readFileSync(absolute, 'utf-8');
		return parseGeneratedFromKnowledge(content);
	} catch (err) {
		console.warn(
			'[skill-usage-log] resolveSourceKnowledgeIds failed (fail-open):',
			err instanceof Error ? err.message : String(err),
		);
		return [];
	}
}

/**
 * Pure helper: parse `generated_from_knowledge:` YAML list from frontmatter.
 * Uses a minimal regex-based parser — the SKILL.md format is well-known and narrow.
 * Does NOT use a full YAML parser to avoid adding a dependency.
 */
function parseGeneratedFromKnowledge(content: string): string[] {
	// Match frontmatter block (between --- delimiters at start of file)
	const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
	if (!frontmatterMatch) return [];

	const body = frontmatterMatch[1];
	const ids: string[] = [];

	// Match UUID-style entries under generated_from_knowledge:
	// Supports both "  - uuid" and "  - uuid  # comment" formats
	const sectionRegex =
		/generated_from_knowledge\s*:\s*\n((?:\s+-\s+\S+[^\n]*\n?)+)/;
	const sectionMatch = body.match(sectionRegex);
	if (!sectionMatch) return [];

	const lines = sectionMatch[1].split('\n');
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed.startsWith('-')) continue;
		// Extract the UUID — take the first token after "- "
		const parts = trimmed.slice(1).trim().split(/\s+/);
		if (parts.length > 0 && parts[0].length > 0) {
			ids.push(parts[0]);
		}
	}

	return ids;
}

// ============================================================================
// Feedback bridge — wire skill usage to knowledge confidence
// ============================================================================

/** Confidence boost applied per compliant skill usage cycle. */
const COMPLIANCE_BOOST = 0.05;

/** Confidence decay applied per violation cycle. */
const VIOLATION_DECAY = 0.1;

/**
 * Read skill-usage entries, resolve source knowledge IDs for each skill,
 * and apply confidence bumps/decays to the originating knowledge entries.
 *
 * For each unique skillPath with at least one compliance or violation entry:
 * 1. Resolve source knowledge UUIDs from the skill's SKILL.md frontmatter.
 * 2. Count compliant and violation events for that skill.
 * 3. Compute net delta: if compliant count > violation count → +0.05; else → -0.1.
 * 4. Call `bumpKnowledgeConfidenceBatch` with the aggregated deltas.
 *
 * @param directory       - Project root directory.
 * @param options.sinceTimestamp - Optional ISO 8601 cutoff; only process entries after this time.
 * @returns Count of processed skills and total confidence bumps/decays applied.
 */
export async function applySkillUsageFeedback(
	directory: string,
	options?: { sinceTimestamp?: string },
): Promise<{ processed: number; bumps: number }> {
	let processed = 0;
	let bumps = 0;

	try {
		const allEntries = readSkillUsageEntries(directory);

		// Filter to entries with actionable compliance verdicts
		const actionable = allEntries.filter((e) => {
			if (
				e.complianceVerdict !== 'compliant' &&
				e.complianceVerdict !== 'violation'
			) {
				return false;
			}
			if (options?.sinceTimestamp && e.timestamp <= options.sinceTimestamp) {
				return false;
			}
			return true;
		});

		if (actionable.length === 0) {
			return { processed: 0, bumps: 0 };
		}

		// Group by skillPath
		const groups = new Map<string, typeof actionable>();
		for (const entry of actionable) {
			const list = groups.get(entry.skillPath);
			if (list) list.push(entry);
			else groups.set(entry.skillPath, [entry]);
		}

		// Collect all deltas across all skills, then batch-apply once
		const allDeltas: Array<{ id: string; delta: number }> = [];

		for (const [skillPath, entries] of Array.from(groups)) {
			let compliantCount = 0;
			let violationCount = 0;

			for (const entry of entries) {
				if (entry.complianceVerdict === 'compliant') compliantCount++;
				else if (entry.complianceVerdict === 'violation') violationCount++;
			}

			// Skip skills with no actionable verdicts (shouldn't happen due to filter, but defensive)
			if (compliantCount === 0 && violationCount === 0) continue;

			const delta =
				compliantCount > violationCount ? COMPLIANCE_BOOST : -VIOLATION_DECAY;

			// Resolve source knowledge IDs from the skill's SKILL.md
			const sourceIds = await resolveSourceKnowledgeIds(directory, skillPath);
			if (sourceIds.length === 0) continue;

			for (const id of sourceIds) {
				allDeltas.push({ id, delta });
			}

			processed++;
			bumps += sourceIds.length;
		}

		// Aggregate deltas by knowledge ID to prevent unbounded stacking
		// when the same knowledge ID appears in multiple skills' lists
		const aggregated = new Map<string, number>();
		for (const { id, delta } of allDeltas) {
			aggregated.set(id, (aggregated.get(id) ?? 0) + delta);
		}
		// Clamp each net delta to allowed per-cycle bounds [+0.05, -0.1]
		const clampedDeltas = Array.from(aggregated.entries()).map(
			([id, netDelta]) => ({
				id,
				delta: Math.max(-VIOLATION_DECAY, Math.min(COMPLIANCE_BOOST, netDelta)),
			}),
		);

		// Batch-apply clamped deltas in a single call
		if (clampedDeltas.length > 0) {
			await bumpKnowledgeConfidenceBatch(directory, clampedDeltas);
		}
	} catch (err) {
		console.warn(
			'[skill-usage-log] applySkillUsageFeedback failed (fail-open):',
			err instanceof Error ? err.message : String(err),
		);
	}

	return { processed, bumps };
}
