/** Core storage layer for the opencode-swarm v6.17 two-tier knowledge system. */

import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import type { KnowledgeEntryBase, RejectedLesson } from './knowledge-types.js';

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
export async function readKnowledge<T>(filePath: string): Promise<T[]> {
	if (!existsSync(filePath)) return [];
	const content = await readFile(filePath, 'utf-8');
	const results: T[] = [];
	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			results.push(JSON.parse(trimmed) as T);
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

// Reads from the swarm-level rejected lessons file
export async function readRejectedLessons(
	directory: string,
): Promise<RejectedLesson[]> {
	return readKnowledge<RejectedLesson>(resolveSwarmRejectedPath(directory));
}

// ============================================================================
// Write Functions
// ============================================================================

// Append a single entry to a JSONL file, creating the directory if needed.
// Uses OS-level atomic append — no lock needed for append-only operations.
export async function appendKnowledge<T>(
	filePath: string,
	entry: T,
): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	await appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf-8');
}

// Rewrite the entire JSONL file with a new array of entries.
// Uses proper-lockfile on the directory for crash-safe writes.
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
		await writeFile(filePath, content, 'utf-8');
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
export async function enforceKnowledgeCap<T>(
	filePath: string,
	maxEntries: number,
): Promise<void> {
	const entries = await readKnowledge<T>(filePath);
	if (entries.length > maxEntries) {
		const trimmed = entries.slice(entries.length - maxEntries);
		await rewriteKnowledge(filePath, trimmed);
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
	return text
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
	inferTags: typeof inferTags;
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
	inferTags,
};
