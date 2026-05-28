/** Core storage layer for the opencode-swarm v6.17 two-tier knowledge system. */

import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { atomicWriteFile } from '../evidence/task-file.js';
import type {
	ActionableDirectiveFields,
	KnowledgeEntryBase,
	RejectedLesson,
	RetrievalOutcome,
} from './knowledge-types.js';

// ============================================================================
// Path Resolvers
// ============================================================================

// Returns the platform-specific config directory for opencode-swarm
export function getPlatformConfigDir(): string {
	const platform = process.platform;
	// Read $HOME live each call so test redirection via process.env.HOME works.
	// Bun caches os.homedir(), so changing $HOME after first call is ignored.
	const home = process.env.HOME || os.homedir();
	if (platform === 'win32') {
		return path.join(
			process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
			'opencode-swarm',
			'config',
		);
	} else if (platform === 'darwin') {
		return path.join(home, 'Library', 'Application Support', 'opencode-swarm');
	} else {
		return path.join(
			process.env.XDG_CONFIG_HOME || path.join(home, '.config'),
			'opencode-swarm',
		);
	}
}

// Returns path to .swarm/knowledge.jsonl in the project directory
export function resolveSwarmKnowledgePath(directory: string): string {
	return path.join(directory, '.swarm', 'knowledge.jsonl');
}

// Returns path to .swarm/knowledge-rejected.jsonl in the project directory
export function resolveSwarmRejectedPath(directory: string): string {
	return path.join(directory, '.swarm', 'knowledge-rejected.jsonl');
}

// Returns path to .swarm/knowledge-retractions.jsonl in the project directory
export function resolveSwarmRetractionsPath(directory: string): string {
	return path.join(directory, '.swarm', 'knowledge-retractions.jsonl');
}

// Cross-platform resolver — inlined 15-line implementation (NO env-paths dependency)
export function resolveHiveKnowledgePath(): string {
	const platform = process.platform;
	// Read $HOME live each call so test redirection via process.env.HOME works.
	// Bun caches os.homedir(), so changing $HOME after first call is ignored.
	const home = process.env.HOME || os.homedir();
	let dataDir: string;
	if (platform === 'win32') {
		dataDir = path.join(
			process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
			'opencode-swarm',
			'Data',
		);
	} else if (platform === 'darwin') {
		dataDir = path.join(
			home,
			'Library',
			'Application Support',
			'opencode-swarm',
		);
	} else {
		dataDir = path.join(
			process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'),
			'opencode-swarm',
		);
	}
	return path.join(dataDir, 'shared-learnings.jsonl');
}

// Returns path to hive-level rejected lessons (same directory as hive knowledge)
export function resolveHiveRejectedPath(): string {
	const hivePath = resolveHiveKnowledgePath();
	return path.join(path.dirname(hivePath), 'shared-learnings-rejected.jsonl');
}

// ============================================================================
// Read Functions
// ============================================================================

// Read JSONL file. Skip lines that fail JSON.parse (log a warning for each skipped line).
// Returns empty array if file does not exist.
// v2: each parsed entry is passed through normalizeEntry() so v1 entries get
// optional v2 fields filled in WITHOUT mutating on-disk JSONL.
export async function readKnowledge<T>(filePath: string): Promise<T[]> {
	if (!existsSync(filePath)) return [];
	const content = await readFile(filePath, 'utf-8');
	const results: T[] = [];
	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const raw = JSON.parse(trimmed) as T;
			results.push(normalizeEntry(raw));
		} catch {
			console.warn(
				`[knowledge-store] Skipping corrupted JSONL line in ${filePath}: ${trimmed.slice(
					0,
					80,
				)}`,
			);
		}
	}
	return results;
}

// v2: Normalize a parsed entry to the current shape in memory.
// Adds defaulted retrieval-outcome counters for v1 entries; leaves on-disk JSONL untouched.
// Pass-through for non-knowledge types (RejectedLesson) — only mutates objects with retrieval_outcomes.
export function normalizeEntry<T>(raw: T): T {
	if (!raw || typeof raw !== 'object') return raw;
	const obj = raw as unknown as Record<string, unknown>;
	if (!('retrieval_outcomes' in obj)) return raw;
	const ro = obj.retrieval_outcomes as Record<string, unknown> | null;
	if (ro && typeof ro === 'object') {
		// Migrate: legacy 'applied_count' represented "shown" before v2.
		// We preserve it as-is for backward compatibility, but ensure all v2
		// counters exist with sane defaults.
		if (typeof ro.shown_count !== 'number') {
			ro.shown_count =
				typeof ro.applied_count === 'number' ? ro.applied_count : 0;
		}
		if (typeof ro.acknowledged_count !== 'number') ro.acknowledged_count = 0;
		if (typeof ro.applied_explicit_count !== 'number') {
			ro.applied_explicit_count = 0;
		}
		if (typeof ro.ignored_count !== 'number') ro.ignored_count = 0;
		if (typeof ro.violated_count !== 'number') ro.violated_count = 0;
		if (typeof ro.contradicted_count !== 'number') ro.contradicted_count = 0;
		if (typeof ro.succeeded_after_shown_count !== 'number') {
			ro.succeeded_after_shown_count =
				typeof ro.succeeded_after_count === 'number'
					? ro.succeeded_after_count
					: 0;
		}
		if (typeof ro.failed_after_shown_count !== 'number') {
			ro.failed_after_shown_count =
				typeof ro.failed_after_count === 'number' ? ro.failed_after_count : 0;
		}
	}
	// Backfill encounter_score for entries created before this field existed.
	// Legacy hive entries may lack encounter_score; default to 0 per spec FR-002.
	// try/catch guards against throwing getters (prototype pollution edge case).
	try {
		if (
			typeof obj.encounter_score !== 'number' ||
			Number.isNaN(obj.encounter_score)
		) {
			obj.encounter_score = 0;
		}
	} catch {
		// Throwing getter or Proxy trap — define own property directly
		// to bypass setter semantics on poisoned accessors
		try {
			Object.defineProperty(obj, 'encounter_score', {
				value: 0,
				writable: true,
				configurable: true,
				enumerable: true,
			});
		} catch {
			// Completely frozen/sealed object — nothing we can do
		}
	}
	// Ensure actionable arrays are at least undefined-or-array (never wrong type).
	const arrayFields: Array<keyof ActionableDirectiveFields> = [
		'triggers',
		'required_actions',
		'forbidden_actions',
		'applies_to_agents',
		'applies_to_tools',
		'verification_checks',
		'source_refs',
		'source_knowledge_ids',
	];
	for (const f of arrayFields) {
		const v = obj[f as string];
		if (v !== undefined && !Array.isArray(v)) {
			delete obj[f as string];
		}
	}
	// Default a non-array tags field so downstream readers that access
	// `tags.length` (ranking, dedup) never throw on a malformed entry. We do NOT
	// coerce `lesson`: consumers like the curator legitimately handle an object
	// lesson (JSON.stringify), and the normalize() helper tolerates non-strings.
	if (!Array.isArray(obj.tags)) {
		obj.tags = [];
	}
	return raw;
}

// Reads from the swarm-level rejected lessons file
export async function readRejectedLessons(
	directory: string,
): Promise<RejectedLesson[]> {
	return readKnowledge<RejectedLesson>(resolveSwarmRejectedPath(directory));
}

export interface KnowledgeRetractionRecord {
	id: string;
	retracted_lesson: string;
	normalized_lesson: string;
	recorded_at: string;
	reported_by: 'architect' | 'user' | 'auto';
	matched_swarm_ids: string[];
	matched_hive_ids: string[];
}

export async function readRetractionRecords(
	directory: string,
): Promise<KnowledgeRetractionRecord[]> {
	return readKnowledge<KnowledgeRetractionRecord>(
		resolveSwarmRetractionsPath(directory),
	);
}

export async function appendRetractionRecord(
	directory: string,
	record: KnowledgeRetractionRecord,
): Promise<void> {
	await appendKnowledge(resolveSwarmRetractionsPath(directory), record);
}

// ============================================================================
// Write Functions
// ============================================================================

// Append a single entry to a JSONL file, creating the directory if needed.
// Acquires the same directory-level lock as enforceKnowledgeCap and rewriteKnowledge
// to prevent TOCTOU races: a concurrent cap enforcement must not interleave with
// appends, and vice versa. The lock is on the directory (not the file) because
// proper-lockfile requires the target to exist; the directory is guaranteed to
// exist after mkdir.
export async function appendKnowledge<T>(
	filePath: string,
	entry: T,
): Promise<void> {
	const dir = path.dirname(filePath);
	await mkdir(dir, { recursive: true });

	let release: (() => Promise<void>) | null = null;
	try {
		release = await lockfile.lock(dir, {
			retries: { retries: 5, minTimeout: 100, maxTimeout: 500 },
			stale: 5000,
		});
		await appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf-8');
	} finally {
		if (release) {
			try {
				await release();
			} catch {
				/* lock release failed — non-blocking */
			}
		}
	}
}

// Rewrite the entire JSONL file with a new array of entries.
// Uses proper-lockfile on the directory for concurrent-access safety.
// The file write itself uses atomic temp-file + rename so readers never observe a torn file.
// The lock is acquired on the DIRECTORY (not the file) because proper-lockfile requires
// the target to exist. The directory is guaranteed to exist after mkdir.
export async function rewriteKnowledge<T>(
	filePath: string,
	entries: T[],
): Promise<void> {
	const dir = path.dirname(filePath);
	await mkdir(dir, { recursive: true });

	let release: (() => Promise<void>) | null = null;
	try {
		release = await lockfile.lock(dir, {
			retries: { retries: 5, minTimeout: 100, maxTimeout: 500 },
			stale: 5000,
		});
		const content =
			entries.map((e) => JSON.stringify(e)).join('\n') +
			(entries.length > 0 ? '\n' : '');
		await atomicWriteFile(filePath, content);
	} finally {
		if (release) {
			try {
				await release();
			} catch {
				/* lock release failed — log warning */
			}
		}
	}
}

// Enforce a FIFO max-entries cap on a JSONL file.
// If the file exceeds `maxEntries`, the oldest entries are dropped.
// No-op when the file has fewer entries than the cap.
// The full read-modify-write cycle is atomic under a directory lock to
// prevent concurrent appendKnowledge from inserting entries that get
// silently dropped by the rewrite (TOCTOU race condition).
export async function enforceKnowledgeCap<T>(
	filePath: string,
	maxEntries: number,
): Promise<void> {
	let release: (() => Promise<void>) | null = null;
	try {
		const dir = path.dirname(filePath);
		// Ensure directory exists before acquiring lock (required by proper-lockfile).
		await mkdir(dir, { recursive: true });
		// Acquire directory lock for entire read-modify-write to prevent
		// concurrent appendKnowledge from racing (TOCTOU race prevention)
		release = await lockfile.lock(dir, {
			retries: { retries: 5, minTimeout: 100, maxTimeout: 500 },
			stale: 5000,
		});

		const entries = await readKnowledge<T>(filePath);
		if (entries.length > maxEntries) {
			const trimmed = entries.slice(entries.length - maxEntries);
			// Write directly with the held lock (avoid nested lock via rewriteKnowledge).
			const content =
				trimmed.map((e) => JSON.stringify(e)).join('\n') +
				(trimmed.length > 0 ? '\n' : '');
			await writeFile(filePath, content, 'utf-8');
		}
	} finally {
		if (release) {
			try {
				await release();
			} catch {
				// Lock release failed — non-blocking
			}
		}
	}
}

// Results from a sweep operation (aging or TODO removal)
export interface SweepResult {
	scanned: number;
	aged: number;
	archived: number;
	removed: number;
	skipped_promoted: number;
}

// Increment phases_alive on all non-archived, non-promoted entries and archive
// those exceeding their TTL. Archives entries by setting status='archived' and
// updated_at timestamp; does not remove them from the JSONL (FIFO cap removes later).
// Promoted entries are TTL-exempt but still skipped (no age bumping for promoted).
export async function sweepAgedEntries<T extends KnowledgeEntryBase>(
	filePath: string,
	defaultMaxPhases: number,
): Promise<SweepResult> {
	let release: (() => Promise<void>) | null = null;
	try {
		const dir = path.dirname(filePath);
		// Ensure directory exists before acquiring lock (required by proper-lockfile).
		await mkdir(dir, { recursive: true });
		// Acquire directory lock for entire read-modify-write to prevent
		// concurrent appendKnowledge from racing (H2 race condition prevention)
		release = await lockfile.lock(dir, {
			retries: { retries: 5, minTimeout: 100, maxTimeout: 500 },
			stale: 5000,
		});

		const entries = await readKnowledge<T>(filePath);
		const result: SweepResult = {
			scanned: entries.length,
			aged: 0,
			archived: 0,
			removed: 0,
			skipped_promoted: 0,
		};
		if (entries.length === 0) return result;

		const now = new Date().toISOString();
		let mutated = false;
		for (const entry of entries) {
			// Skip age bumps for archived entries (already dead, no churn)
			if (entry.status === 'archived') continue;

			// Skip promoted entries: do not increment age and do not archive them
			// (promoted entries have unlimited TTL per feature design).
			if (entry.status === 'promoted') {
				result.skipped_promoted++;
				continue;
			}

			// Bump age and test against TTL. Any age change must persist.
			entry.phases_alive = (entry.phases_alive ?? 0) + 1;
			result.aged++;
			mutated = true;

			const ttl = entry.max_phases ?? defaultMaxPhases;
			// max_phases=N means entry can live N complete phases; archive on N+1.
			if (entry.phases_alive > ttl) {
				entry.status = 'archived';
				entry.updated_at = now;
				result.archived++;
			}
		}

		// Write directly with the held lock (avoid nested lock via rewriteKnowledge).
		if (mutated) {
			const content =
				entries.map((e) => JSON.stringify(e)).join('\n') +
				(entries.length > 0 ? '\n' : '');
			await writeFile(filePath, content, 'utf-8');
		}
		return result;
	} finally {
		if (release) {
			try {
				await release();
			} catch {
				// Lock release failed — non-blocking
			}
		}
	}
}

// Hard-remove todo-category entries that have aged past todoMaxPhases.
// Other entry categories are untouched; general aging is handled by sweepAgedEntries.
export async function sweepStaleTodos<T extends KnowledgeEntryBase>(
	filePath: string,
	todoMaxPhases: number,
): Promise<SweepResult> {
	let release: (() => Promise<void>) | null = null;
	try {
		const dir = path.dirname(filePath);
		// Ensure directory exists before acquiring lock (required by proper-lockfile).
		await mkdir(dir, { recursive: true });
		release = await lockfile.lock(dir, {
			retries: { retries: 5, minTimeout: 100, maxTimeout: 500 },
			stale: 5000,
		});

		const entries = await readKnowledge<T>(filePath);
		const result: SweepResult = {
			scanned: entries.length,
			aged: 0,
			archived: 0,
			removed: 0,
			skipped_promoted: 0,
		};
		if (entries.length === 0) return result;

		const kept = entries.filter((e) => {
			// Promoted entries are TTL-exempt per design, even for TODO category.
			if (e.category !== 'todo' || e.status === 'promoted') return true;
			const age = e.phases_alive ?? 0;
			if (age > todoMaxPhases) {
				result.removed++;
				return false;
			}
			return true;
		});

		// Write directly with the held lock (avoid nested lock via rewriteKnowledge).
		if (result.removed > 0) {
			const content =
				kept.map((e) => JSON.stringify(e)).join('\n') +
				(kept.length > 0 ? '\n' : '');
			await writeFile(filePath, content, 'utf-8');
		}
		return result;
	} finally {
		if (release) {
			try {
				await release();
			} catch {
				// Lock release failed — non-blocking
			}
		}
	}
}

// Append a RejectedLesson, enforcing a FIFO max-20 cap.
// If the file already has >= 20 entries, drop the oldest before appending.
export async function appendRejectedLesson(
	directory: string,
	lesson: RejectedLesson,
): Promise<void> {
	const filePath = resolveSwarmRejectedPath(directory);
	const existing = await readRejectedLessons(directory);
	const MAX = 20;
	const updated = [...existing, lesson];
	if (updated.length > MAX) {
		// FIFO: drop oldest entries
		const trimmed = updated.slice(updated.length - MAX);
		await rewriteKnowledge(filePath, trimmed);
	} else {
		await appendKnowledge(filePath, lesson);
	}
}

// ============================================================================
// Utility Functions (pure — no I/O)
// ============================================================================

// Normalize a string for comparison: lowercase, collapse whitespace, strip punctuation
export function normalize(text: string): string {
	// Tolerate non-string input (a malformed on-disk lesson) without throwing,
	// so a single corrupt entry can't fail an entire read. The stored entry is
	// left untouched — only this derived form is coerced.
	const s = typeof text === 'string' ? text : String(text ?? '');
	return s
		.toLowerCase()
		.replace(/[^\w\s]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

// Generate word bigrams from a string
export function wordBigrams(text: string): Set<string> {
	const words = normalize(text).split(' ').filter(Boolean);
	const bigrams = new Set<string>();
	for (let i = 0; i < words.length - 1; i++) {
		bigrams.add(`${words[i]} ${words[i + 1]}`);
	}
	return bigrams;
}

// Compute Jaccard similarity between two bigram sets
export function jaccardBigram(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 && b.size === 0) return 1.0;
	const aArr = Array.from(a);
	const intersection = new Set(aArr.filter((x) => b.has(x)));
	const union = new Set([...aArr, ...Array.from(b)]);
	return intersection.size / union.size;
}

// Find a near-duplicate entry in an array. Returns the first entry with
// Jaccard bigram similarity >= threshold (default 0.6) or undefined if none found.
export function findNearDuplicate<T extends { lesson: string }>(
	candidate: string,
	entries: T[],
	threshold = 0.6,
): T | undefined {
	const candidateBigrams = wordBigrams(candidate);
	return entries.find((entry) => {
		const entryBigrams = wordBigrams(entry.lesson);
		return jaccardBigram(candidateBigrams, entryBigrams) >= threshold;
	});
}

// Compute a confidence score for a new swarm entry based on initial metadata.
// Starting confidence: 0.5 (unconfirmed candidate). Boosted by:
// +0.1 for each non-null confirmed_by record (up to 3 boosts = 0.8 max from this)
// +0.1 if auto_generated is false (human-originated)
export function computeConfidence(
	confirmedByCount: number,
	autoGenerated: boolean,
): number {
	let score = 0.5;
	score += Math.min(confirmedByCount, 3) * 0.1;
	if (!autoGenerated) score += 0.1;
	return Math.min(score, 1.0);
}

// Laplace smoothing constant for computeOutcomeSignal. Pulls low-evidence entries
// toward 0 so a single applied/contradicted event can't dominate ranking or block
// promotion — meaningful influence needs a few corroborating outcomes.
export const OUTCOME_SIGNAL_SMOOTHING = 4;

// Event-sourced track-record signal in (-1, 1) derived from an entry's accumulated
// retrieval outcomes. Positive when the entry was applied / succeeded after being
// shown; negative when it was ignored / violated / contradicted / failed after.
// Returns 0 (neutral) when there is no outcome evidence, so entries that have never
// been acted on are neither boosted nor penalized. Reads only the v2/v3 outcome
// counters (NOT the frozen v1 applied_count), per the RetrievalOutcome contract.
export function computeOutcomeSignal(outcomes?: RetrievalOutcome): number {
	if (!outcomes) return 0;
	const positives =
		(outcomes.applied_explicit_count ?? 0) +
		(outcomes.succeeded_after_shown_count ?? 0);
	const negatives =
		(outcomes.ignored_count ?? 0) +
		(outcomes.violated_count ?? 0) +
		(outcomes.contradicted_count ?? 0) +
		(outcomes.failed_after_shown_count ?? 0);
	const total = positives + negatives;
	if (total === 0) return 0;
	return (positives - negatives) / (total + OUTCOME_SIGNAL_SMOOTHING);
}

// Infer tags from a lesson string. Returns lowercase tag strings.
// inferTags lives in knowledge-store.ts (NOT curator) to avoid circular dependency:
// curator imports validator, validator would need inferTags — so it lives here.
export function inferTags(lesson: string): string[] {
	const lower = lesson.toLowerCase();
	const tags: string[] = [];

	// Category + tag detection
	if (/(^|\s)(?:todo|remember|don't?(?:\s+)?forget)(?:\s|:|,|$)/i.test(lesson))
		tags.push('todo');

	// Tech/tool detection
	if (/\b(?:typescript|ts)\b/.test(lower)) tags.push('typescript');
	if (/\b(?:javascript|js)\b/.test(lower)) tags.push('javascript');
	if (/\b(?:python)\b/.test(lower)) tags.push('python');
	if (/\b(?:bun|node|deno)\b/.test(lower)) tags.push('runtime');
	if (/\b(?:react|vue|svelte|angular)\b/.test(lower)) tags.push('frontend');
	if (/\b(?:git|github|gitlab)\b/.test(lower)) tags.push('git');
	if (/\b(?:docker|kubernetes|k8s)\b/.test(lower)) tags.push('container');
	if (/\b(?:sql|postgres|mysql|sqlite)\b/.test(lower)) tags.push('database');
	if (/\b(?:test|spec|vitest|jest|mocha)\b/.test(lower)) tags.push('testing');
	if (/\b(?:ci|cd|pipeline|workflow|action)\b/.test(lower)) tags.push('ci-cd');
	if (/\b(?:security|auth|token|password|encrypt)\b/.test(lower))
		tags.push('security');
	if (/\b(?:performance|latency|throughput|cache)\b/.test(lower))
		tags.push('performance');
	if (/\b(?:api|rest|graphql|grpc|endpoint)\b/.test(lower)) tags.push('api');
	if (/\b(?:swarm|architect|agent|hook|plan)\b/.test(lower))
		tags.push('opencode-swarm');

	return Array.from(new Set(tags)); // deduplicate
}

// ============================================================================
// Feedback Bridge — Confidence Bumping
// ============================================================================

/** Confidence floor (below this, entries are considered unreliable). */
const CONFIDENCE_FLOOR = 0.1;

/** Confidence ceiling (maximum possible value). */
const CONFIDENCE_CEILING = 1.0;

/**
 * Batch-update confidence scores on knowledge entries identified by their UUIDs.
 *
 * For each delta, the function:
 * 1. Searches the swarm knowledge file for an entry with the given `id`.
 * 2. Falls back to the hive knowledge file if not found in swarm.
 * 3. Clamps the resulting confidence to [0.1, 1.0].
 * 4. Updates `confidence` and `updated_at`, then rewrites the file.
 *
 * The full read-modify-write cycle is atomic under a directory lock
 * (same pattern as `enforceKnowledgeCap`). Errors are logged but never
 * thrown — the function is fail-open.
 *
 * @param directory - Project root directory (used to resolve `.swarm/knowledge.jsonl`).
 * @param deltas    - Array of {id, delta} tuples. Delta may be positive (boost) or negative (decay).
 */
export async function bumpKnowledgeConfidenceBatch(
	directory: string,
	deltas: Array<{ id: string; delta: number }>,
): Promise<void> {
	if (deltas.length === 0) return;

	const swarmPath = resolveSwarmKnowledgePath(directory);
	const hivePath = resolveHiveKnowledgePath();

	try {
		// --- Swarm pass ---
		await applyConfidenceDeltas(swarmPath, deltas);

		// --- Hive pass (only for IDs not found in swarm) ---
		const swarmEntries = await readKnowledge<KnowledgeEntryBase>(swarmPath);
		const swarmIds = new Set(swarmEntries.map((e) => e.id));
		const hiveOnly = deltas.filter((d) => !swarmIds.has(d.id));
		if (hiveOnly.length > 0) {
			await applyConfidenceDeltas(hivePath, hiveOnly);
		}
	} catch (err) {
		console.warn(
			'[knowledge-store] bumpKnowledgeConfidenceBatch failed (fail-open):',
			err instanceof Error ? err.message : String(err),
		);
	}
}

/**
 * Internal helper: apply a set of confidence deltas to a single JSONL file.
 * Acquires a directory lock for the full read-modify-write cycle.
 */
async function applyConfidenceDeltas(
	filePath: string,
	deltas: Array<{ id: string; delta: number }>,
): Promise<void> {
	const idDeltaMap = new Map<string, number>();
	for (const d of deltas) {
		const existing = idDeltaMap.get(d.id);
		idDeltaMap.set(d.id, existing !== undefined ? existing + d.delta : d.delta);
	}

	let release: (() => Promise<void>) | null = null;
	try {
		const dir = path.dirname(filePath);
		await mkdir(dir, { recursive: true });
		release = await lockfile.lock(dir, {
			retries: { retries: 5, minTimeout: 100, maxTimeout: 500 },
			stale: 5000,
		});

		const entries = await readKnowledge<KnowledgeEntryBase>(filePath);
		if (entries.length === 0) return;

		const now = new Date().toISOString();
		let mutated = false;

		for (const entry of entries) {
			const delta = idDeltaMap.get(entry.id);
			if (delta === undefined) continue;

			entry.confidence = Math.max(
				CONFIDENCE_FLOOR,
				Math.min(CONFIDENCE_CEILING, entry.confidence + delta),
			);
			entry.updated_at = now;
			mutated = true;
		}

		if (mutated) {
			const content =
				entries.map((e) => JSON.stringify(e)).join('\n') +
				(entries.length > 0 ? '\n' : '');
			await writeFile(filePath, content, 'utf-8');
		}
	} catch (err) {
		console.warn(
			`[knowledge-store] applyConfidenceDeltas failed on ${filePath} (fail-open):`,
			err instanceof Error ? err.message : String(err),
		);
	} finally {
		if (release) {
			try {
				await release();
			} catch {
				/* lock release failed — non-blocking */
			}
		}
	}
}

// ============================================================================
// DI Seam — _internals
// ============================================================================

export const _internals: {
	getPlatformConfigDir: typeof getPlatformConfigDir;
	resolveSwarmKnowledgePath: typeof resolveSwarmKnowledgePath;
	resolveSwarmRejectedPath: typeof resolveSwarmRejectedPath;
	resolveHiveKnowledgePath: typeof resolveHiveKnowledgePath;
	resolveHiveRejectedPath: typeof resolveHiveRejectedPath;
	readKnowledge: typeof readKnowledge;
	readRejectedLessons: typeof readRejectedLessons;
	appendKnowledge: typeof appendKnowledge;
	rewriteKnowledge: typeof rewriteKnowledge;
	enforceKnowledgeCap: typeof enforceKnowledgeCap;
	sweepAgedEntries: typeof sweepAgedEntries;
	sweepStaleTodos: typeof sweepStaleTodos;
	appendRejectedLesson: typeof appendRejectedLesson;
	normalize: typeof normalize;
	wordBigrams: typeof wordBigrams;
	jaccardBigram: typeof jaccardBigram;
	findNearDuplicate: typeof findNearDuplicate;
	computeConfidence: typeof computeConfidence;
	computeOutcomeSignal: typeof computeOutcomeSignal;
	inferTags: typeof inferTags;
	bumpKnowledgeConfidenceBatch: typeof bumpKnowledgeConfidenceBatch;
} = {
	getPlatformConfigDir,
	resolveSwarmKnowledgePath,
	resolveSwarmRejectedPath,
	resolveHiveKnowledgePath,
	resolveHiveRejectedPath,
	readKnowledge,
	readRejectedLessons,
	appendKnowledge,
	rewriteKnowledge,
	enforceKnowledgeCap,
	sweepAgedEntries,
	sweepStaleTodos,
	appendRejectedLesson,
	normalize,
	wordBigrams,
	jaccardBigram,
	findNearDuplicate,
	computeConfidence,
	computeOutcomeSignal,
	inferTags,
	bumpKnowledgeConfidenceBatch,
};
