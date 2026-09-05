/**
 * Age/count directory pruner (issue #2483 §1).
 *
 * Deletes the OLDEST entries (mtime ascending, deterministic code-unit name
 * tie-break — never localeCompare) until the directory is within its caps.
 *
 * A DIRECTORY entry is aged by its CONTENT, not by the directory node's own
 * mtime: the effective mtime is the newest regular-file mtime anywhere in the
 * subtree (bounded, symlink-refusing). A directory's own mtime only reflects
 * metadata churn (entry creates/deletes/renames — e.g. another pruner
 * deleting a sibling refreshes the parent), so content age is the honest
 * "last write activity" signal. An empty subtree falls back to the
 * directory's own mtime; an unreadable or scan-budget-exhausted subtree is
 * treated as unprunable (effective mtime +Infinity — never a victim).
 *
 * Containment properties (issue #2483 edge cases):
 *  - symlink/junction entries are NEVER traversed or deleted (lstat check —
 *    the #2127 marker-symlink precedent), including inside subtrees;
 *  - entries with future mtimes (clock skew) are NEVER pruned;
 *  - enumeration is bounded (`maxScan`, per directory level AND per subtree
 *    walk) so a huge directory cannot turn the pruner into an unbounded scan
 *    on a cold Windows filesystem;
 *  - per-entry failures are swallowed (fail-open): one unreadable entry
 *    never aborts the family.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface PruneDirectoryOptions {
	/** Keep at most this many entries (newest by mtime). */
	maxEntries?: number;
	/** Delete entries strictly older than this (ms before `now`). */
	maxAgeMs?: number;
	/** Clock injection point for tests/checks. */
	now?: number;
	/**
	 * Enumeration bound (default 100000 — review FB-12: 20000 stat ops could
	 * exhaust before a legitimately large keyspace finished enumerating,
	 * silently skipping stale tail entries; the budget is stats, not
	 * deletions, so the higher ceiling stays bounded).
	 */
	maxScan?: number;
	/** Count victims without deleting (blast-radius rehearsal / dry_run). */
	dryRun?: boolean;
}

export interface PruneCandidate {
	name: string;
	mtimeMs: number;
}

/**
 * Effective mtime of a subtree: the newest regular-file mtime found inside
 * (never traversing symlinks), or `null` when the subtree contains no files.
 * `POSITIVE_INFINITY` signals "could not verify within budget" — callers must
 * treat that as unprunable. The walk is bounded by `maxScan` stat operations
 * total, so a pathological subtree degrades to keep, never to an unbounded
 * scan.
 */
export function subtreeNewestFileMtime(
	root: string,
	maxScan: number,
): number | null {
	let budget = maxScan;
	let newest: number | null = null;
	const stack: string[] = [root];
	while (stack.length > 0) {
		if (budget <= 0) return Number.POSITIVE_INFINITY;
		const dir = stack.pop() as string;
		let names: string[];
		try {
			names = fs.readdirSync(dir);
		} catch {
			// Unreadable level: content cannot be verified — refuse to prune.
			return Number.POSITIVE_INFINITY;
		}
		for (const name of names) {
			if (budget <= 0) return Number.POSITIVE_INFINITY;
			const entryPath = path.join(dir, name);
			let stat: fs.Stats;
			try {
				stat = fs.lstatSync(entryPath);
			} catch {
				continue; // vanished between readdir and lstat: not content
			}
			budget -= 1;
			if (stat.isSymbolicLink()) {
				// Never traversed; a symlink's own mtime is metadata, not
				// content, so it does not refresh the subtree's effective age.
				continue;
			}
			if (stat.isDirectory()) {
				stack.push(entryPath);
				continue;
			}
			if (stat.isFile() && stat.mtimeMs > (newest ?? -Infinity)) {
				newest = stat.mtimeMs;
			}
		}
	}
	return newest;
}

/**
 * Per-subtree walk budget. Deliberately NOT the caller's `maxScan`: the
 * top-level enumeration bound must not multiply into every child subtree.
 * Run/batch/candidate directories hold a handful of files each; 2000 stat
 * operations per subtree is generous, and exhausting it degrades to keep.
 */
export const SUBTREE_SCAN_CAP = 2000;

/** Resolve the effective (content-aware) mtime for a directory entry. */
function effectiveEntryMtime(entryPath: string, ownMtimeMs: number): number {
	const newest = subtreeNewestFileMtime(entryPath, SUBTREE_SCAN_CAP);
	// Empty subtree (no files anywhere): fall back to the directory node's
	// own mtime; unverifiable subtree: never prunable.
	if (newest === null) return ownMtimeMs;
	return newest;
}

/** List bounded entries with effective mtimes; symlinked entries are collected separately and refused. */
export function listPruneCandidates(
	dir: string,
	maxScan: number,
): { candidates: PruneCandidate[]; refusedSymlinks: string[] } {
	const candidates: PruneCandidate[] = [];
	const refusedSymlinks: string[] = [];
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return { candidates: [], refusedSymlinks: [] };
	}
	for (const name of names.slice(0, maxScan)) {
		const entryPath = path.join(dir, name);
		try {
			const stat = fs.lstatSync(entryPath);
			if (stat.isSymbolicLink()) {
				refusedSymlinks.push(name);
				continue;
			}
			candidates.push({
				name,
				mtimeMs: stat.isDirectory()
					? effectiveEntryMtime(entryPath, stat.mtimeMs)
					: stat.mtimeMs,
			});
		} catch {
			/* unreadable entry: skip */
		}
	}
	return { candidates, refusedSymlinks };
}

/**
 * Prune `dir` down to its caps. Returns the number of entries deleted. A
 * missing directory is a no-op (0). `dryRun` counts without deleting.
 */
export async function pruneDirectory(
	dir: string,
	opts: PruneDirectoryOptions,
): Promise<number> {
	const now = opts.now ?? Date.now();
	const maxScan = opts.maxScan ?? 100_000;
	const { candidates } = listPruneCandidates(dir, maxScan);
	if (candidates.length === 0) return 0;

	// Oldest first: mtime ascending, then code-unit name order for equal
	// mtimes (deterministic across platforms and locale settings).
	candidates.sort((a, b) =>
		a.mtimeMs === b.mtimeMs
			? a.name < b.name
				? -1
				: a.name > b.name
					? 1
					: 0
			: a.mtimeMs - b.mtimeMs,
	);

	const cutoff = opts.maxAgeMs !== undefined ? now - opts.maxAgeMs : null;
	const victims: PruneCandidate[] = [];
	for (const candidate of candidates) {
		// Future mtimes are never pruned (clock-skew guard): a rolled-back
		// clock must not mass-delete, and a skewed writer must not lose data.
		if (candidate.mtimeMs > now) continue;
		if (cutoff !== null && candidate.mtimeMs < cutoff) {
			victims.push(candidate);
		}
	}
	if (opts.maxEntries !== undefined) {
		const keepNewest = opts.maxEntries;
		const excess = candidates.length - keepNewest;
		for (let i = 0; i < excess; i++) {
			const candidate = candidates[i];
			if (candidate.mtimeMs > now) continue; // never prune future-mtime entries
			if (!victims.includes(candidate)) victims.push(candidate);
		}
	}

	let pruned = 0;
	if (opts.dryRun !== true) {
		for (const victim of victims) {
			try {
				fs.rmSync(path.join(dir, victim.name), {
					recursive: true,
					force: true,
				});
				pruned += 1;
			} catch {
				/* fail-open per entry */
			}
		}
		return pruned;
	}
	return victims.length;
}
