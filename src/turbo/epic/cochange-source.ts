/**
 * Co-change pair source for Epic mode.
 *
 * Composes the existing `co_change_analyzer` primitives (`parseGitLog`,
 * `buildCoChangeMatrix`) to produce a full, unfiltered list of file-pair
 * co-change entries the Epic conflict module can threshold itself.
 *
 * Why not call `detectDarkMatter` directly?
 *  - `detectDarkMatter` caps output at the top 20 pairs by NPMI and excludes
 *    pairs that already have a static import edge. That filter is correct for
 *    *dark-matter discovery* (its purpose) but wrong for lane-conflict signal:
 *    a high-NPMI pair with a static edge is still a real coupling signal the
 *    lane planner should know about.
 *
 * Caching:
 *  - One entry per project directory, keyed on `git rev-parse HEAD`.
 *  - Same HEAD → cache hit, no git re-scan.
 *  - Different HEAD or different directory → recompute.
 *  - FIFO eviction at `MAX_TRACKED_DIRS` so multi-project usage stays bounded
 *    (AGENTS.md invariant 8: module-level state needs explicit eviction).
 *
 * Reuse vs reimplementation:
 *  - This module never copies analyzer logic. It only orchestrates calls to
 *    the analyzer's existing exported `_internals` (per AGENTS.md invariant
 *    on composition).
 *  - The git HEAD read is a separate bounded subprocess, exposed via the
 *    `_internals` DI seam so tests can stub it without `mock.module`.
 */

import * as child_process from 'node:child_process';
import { promisify } from 'node:util';
import {
	type CoChangeEntry,
	_internals as coChangeAnalyzer,
} from '../../tools/co-change-analyzer.js';
import { canonicalRootKeyFresh } from '../../utils/canonical-root.js';
import { resolveGitExecutableAsync } from '../../utils/git-executable.js';

const execFileAsync = promisify(child_process.execFile);

/** Max directories tracked in the in-memory cache before FIFO eviction. */
const MAX_TRACKED_DIRS = 10;

/** Timeout for `git rev-parse HEAD`. Short — this should be near-instant. */
const GIT_HEAD_TIMEOUT_MS = 5_000;

/** Default commit window the analyzer scans, matching co_change_analyzer's own default. */
const DEFAULT_MAX_COMMITS = 500;

interface CacheEntry {
	head: string;
	entries: CoChangeEntry[];
	commitsObserved: number;
	computedAt: number;
}

const cache = new Map<string, CacheEntry>();

export interface GetCoChangePairsOptions {
	/** Maximum commits the analyzer scans. Defaults to 500. */
	maxCommitsToAnalyze?: number;
}

/**
 * Output of `getCoChangeData`. Carries the same `pairs` returned by
 * `getCoChangePairs`, plus the commit count the analyzer actually observed
 * — which Capability C's greenfield gate needs to decide whether the
 * signal is dense enough to trust.
 */
export interface CoChangeData {
	pairs: CoChangeEntry[];
	commitsObserved: number;
}

async function readGitHead(directory: string): Promise<string | null> {
	try {
		// AGENTS.md invariant 3: explicit cwd + timeout. `execFile` (promisified)
		// does not surface a ChildProcess handle, so `proc.kill()` in `finally`
		// is not applicable — the `timeout` option triggers the kill. `execFile`
		// also does not accept a `stdio` option (that's `spawn`'s API); `git
		// rev-parse HEAD` does not read stdin so the inherited pipe does not
		// block the child. Matches the precedent in `src/tools/co-change-analyzer.ts`.
		//
		// A resolver failure (every candidate rejected) is caught by this same
		// try, matching the existing "any failure -> null" contract below.
		const gitExecutable = await resolveGitExecutableAsync();
		const { stdout } = await _internals.execFile(
			gitExecutable,
			['rev-parse', 'HEAD'],
			{
				cwd: directory,
				timeout: GIT_HEAD_TIMEOUT_MS,
			},
		);
		const head = String(stdout).trim();
		// Defensive: a healthy `git rev-parse HEAD` prints exactly one short
		// line — a SHA or symbolic ref. Reject anything with whitespace
		// (multi-line banners, warnings) or non-ref characters so a
		// misconfigured git cannot poison the cache key with garbage.
		if (
			head.length === 0 ||
			/\s/.test(head) ||
			!/^[A-Za-z0-9_./-]+$/.test(head)
		) {
			return null;
		}
		return head;
	} catch {
		return null;
	}
}

/**
 * Return the full co-change data for the given directory at the current
 * git HEAD. The returned `pairs` are unfiltered (every pair the analyzer
 * recorded, with NPMI / lift / counts / static-edge fields); `commitsObserved`
 * is the number of distinct commits the analyzer scanned. Capability A
 * applies the NPMI threshold to `pairs`; Capability C's greenfield gate
 * inspects `commitsObserved`.
 *
 * Returns `{ pairs: [], commitsObserved: 0 }` when:
 *  - Directory is not a git repo, or `git` is unavailable / times out.
 *  - The analyzer's commit map is empty (greenfield repo).
 * Both cases are signal-absent.
 */
export async function getCoChangeData(
	directory: string,
	options?: GetCoChangePairsOptions,
): Promise<CoChangeData> {
	const head = await readGitHead(directory);
	if (head === null) {
		return { pairs: [], commitsObserved: 0 };
	}

	const key = canonicalRootKeyFresh(directory);
	const cached = cache.get(key);
	if (cached && cached.head === head) {
		return { pairs: cached.entries, commitsObserved: cached.commitsObserved };
	}

	const maxCommits = options?.maxCommitsToAnalyze ?? DEFAULT_MAX_COMMITS;
	let entries: CoChangeEntry[];
	let commitsObserved: number;
	try {
		const commitMap = await _internals.parseGitLog(directory, maxCommits);
		commitsObserved = commitMap.size;
		const matrix = _internals.buildCoChangeMatrix(commitMap);
		entries = Array.from(matrix.values());
	} catch {
		// Defense in depth: today `parseGitLog` catches internally and returns
		// an empty Map on any failure, so this branch is unreachable. If a
		// future analyzer change lets either primitive throw, fail soft to
		// preserve the documented "signal absent ⇒ empty" contract rather
		// than leaking exceptions through a planning path.
		return { pairs: [], commitsObserved: 0 };
	}

	if (!cache.has(key) && cache.size >= MAX_TRACKED_DIRS) {
		const oldestKey = cache.keys().next().value;
		if (oldestKey !== undefined) {
			cache.delete(oldestKey);
		}
	}

	cache.delete(key);
	cache.set(key, {
		head,
		entries,
		commitsObserved,
		computedAt: Date.now(),
	});

	return { pairs: entries, commitsObserved };
}

/**
 * Back-compat wrapper kept for the M2 path (`/swarm coupling` only needs
 * `pairs`). Capability C uses `getCoChangeData` directly for the
 * greenfield gate.
 */
export async function getCoChangePairs(
	directory: string,
	options?: GetCoChangePairsOptions,
): Promise<CoChangeEntry[]> {
	const data = await getCoChangeData(directory, options);
	return data.pairs;
}

/** Test-only: drop all cache entries. */
export function _clearCache(): void {
	cache.clear();
}

/** Test-only: cache size, for asserting eviction behavior. */
export function _cacheSize(): number {
	return cache.size;
}

/**
 * Test-only DI seam. Mutating this object is file-scoped and trivially
 * restorable via afterEach, avoiding Bun's cross-file `mock.module` leak
 * (AGENTS.md invariant 7).
 */
export const _internals: {
	execFile: typeof execFileAsync;
	parseGitLog: typeof coChangeAnalyzer.parseGitLog;
	buildCoChangeMatrix: typeof coChangeAnalyzer.buildCoChangeMatrix;
} = {
	execFile: execFileAsync,
	parseGitLog: coChangeAnalyzer.parseGitLog,
	buildCoChangeMatrix: coChangeAnalyzer.buildCoChangeMatrix,
};
