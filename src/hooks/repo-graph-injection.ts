/**
 * Repo graph context injection for the system-enhancer hook.
 *
 * Produces compact text blocks that surface structural information
 * (importers, dependents, blast radius) for the file the agent is about
 * to edit. Designed to fit within the system-enhancer's per-block budget
 * (~300-500 chars).
 *
 * Failure mode: silent. If no graph exists (`.swarm/repo-graph.json`
 * absent or invalid), this module returns `null` for every helper —
 * the agent simply doesn't get the extra context. The graph is built
 * on-demand by the agent calling `repo_map` with action="build".
 *
 * Caching: the loaded graph is cached in a bounded per-directory LRU and
 * invalidated when the graph artifact changes. Before returning it, the shared
 * bounded workspace probe gates use of the graph. Uncertified graphs and
 * complete drift above the configured refresh cap are suppressed;
 * inconclusive probes remain usable as freshness-unknown, without mutation.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	type FreshnessOptions,
	getBlastRadius,
	getGraphNode,
	getGraphPath,
	getLocalizationContext,
	loadGraphSync,
	probeFreshness,
	type RepoGraph,
} from '../tools/repo-graph';

interface CachedGraph {
	graph: RepoGraph;
	mtimeMs: number;
	size: number;
}

const cache = new Map<string, CachedGraph>();
const MAX_CACHED_DIRECTORIES = 16;

export interface RepoGraphInjectionOptions extends FreshnessOptions {
	enabled?: boolean;
	refreshCap?: number;
}

export const _internals = {
	probeFreshness,
	cacheSize: () => cache.size,
};

function touchCache(key: string, value: CachedGraph): void {
	cache.delete(key);
	cache.set(key, value);
	while (cache.size > MAX_CACHED_DIRECTORIES) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
}

/**
 * Load the repo graph for `directory`, using a bounded per-directory cache that
 * invalidates on file mtime/size change and a shared content-freshness gate.
 * Returns null if no graph exists or its workspace alignment is unsafe.
 *
 * Exported only for tests; production callers use the buildXxxBlock helpers below.
 */
export async function getCachedGraph(
	directory: string,
	options?: RepoGraphInjectionOptions,
): Promise<RepoGraph | null> {
	const key = path.normalize(path.resolve(directory));
	if (options?.enabled === false) {
		cache.delete(key);
		return null;
	}
	const file = getGraphPath(directory);
	let stat: fs.Stats;
	try {
		stat = fs.statSync(file);
	} catch {
		// No graph file. Drop any stale cache entry.
		cache.delete(key);
		return null;
	}
	const cached = cache.get(key);
	let graph: RepoGraph | null;
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
		graph = cached.graph;
		touchCache(key, cached);
	} else {
		try {
			graph = loadGraphSync(directory);
		} catch {
			cache.delete(key);
			return null;
		}
		if (!graph) {
			cache.delete(key);
			return null;
		}
		touchCache(key, { graph, mtimeMs: stat.mtimeMs, size: stat.size });
	}

	const probe = await _internals.probeFreshness(directory, options);
	const observedDrift = probe.changed.length + probe.removed.length;
	const refreshCap = options?.refreshCap ?? 50;
	if (
		probe.state === 'no-fingerprint' ||
		(probe.state === 'drifted' && observedDrift > refreshCap)
	) {
		return null;
	}
	return graph;
}

/** Test-only: clear the per-directory cache. */
export function resetGraphInjectionCache(): void {
	cache.clear();
}

/**
 * Build a localization block for a target file. Used by the coder agent
 * to surface importers/dependencies/blast-radius before editing.
 *
 * Returns null when:
 *   - No graph exists.
 *   - The target isn't tracked in the graph (file too new, language unsupported).
 */
export async function buildCoderLocalizationBlock(
	directory: string,
	targetFile: string,
	options?: RepoGraphInjectionOptions,
): Promise<string | null> {
	if (!targetFile) return null;
	const graph = await getCachedGraph(directory, options);
	if (!graph) return null;
	const normalized = targetFile.replace(/\\/g, '/').replace(/^\.\/+/, '');
	const targetNode = getGraphNode(graph, normalized);
	if (!targetNode) return null;
	const ctx = getLocalizationContext(graph, normalized, {
		maxImporters: 5,
		maxDeps: 5,
		maxDepth: 2,
	});
	return [
		'## REPO GRAPH — LOCALIZATION',
		ctx.summary,
		'_(Run `repo_map action="blast_radius"` for full transitive dependents.)_',
	].join('\n');
}

/**
 * Build a blast-radius block for a list of changed files. Used by the
 * reviewer agent to spot-check whether unseen consumers might break.
 *
 * Returns null when no graph exists or when none of the files are in the
 * graph. The result is bounded to the top 8 dependents to stay within
 * the per-block context budget.
 */
export async function buildReviewerBlastRadiusBlock(
	directory: string,
	changedFiles: string[],
	options?: RepoGraphInjectionOptions,
): Promise<string | null> {
	if (changedFiles.length === 0) return null;
	const graph = await getCachedGraph(directory, options);
	if (!graph) return null;
	const normalized = changedFiles
		.map((f) => f.replace(/\\/g, '/').replace(/^\.\/+/, ''))
		.filter((f) => getGraphNode(graph, f) !== undefined);
	if (normalized.length === 0) return null;

	const blast = getBlastRadius(graph, normalized, 3);
	const directList =
		blast.directDependents.length === 0
			? '(none)'
			: blast.directDependents.slice(0, 8).join(', ') +
				(blast.directDependents.length > 8
					? `, +${blast.directDependents.length - 8} more`
					: '');
	const transitiveSummary =
		blast.transitiveDependents.length === 0
			? '(none)'
			: `${blast.transitiveDependents.length} files (depth ${blast.depthReached})`;

	const targetList =
		normalized.length <= 3
			? normalized.join(', ')
			: `${normalized.slice(0, 3).join(', ')}, +${normalized.length - 3} more`;

	return [
		'## REPO GRAPH — BLAST RADIUS',
		`  Changed: ${targetList}`,
		`  Direct dependents: ${directList}`,
		`  Transitive dependents: ${transitiveSummary}`,
		`  Risk: ${blast.riskLevel} (${blast.totalDependents} total)`,
		'_Verify these dependents still build/typecheck._',
	].join('\n');
}
