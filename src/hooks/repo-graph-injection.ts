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
 * Caching: the loaded graph is cached per-directory in module scope to
 * avoid re-reading the JSON on every system prompt construction. The
 * cache is bypassed if the file's mtime advances.
 */

import * as fs from 'node:fs';
import {
	getBlastRadius,
	getGraphNode,
	getGraphPath,
	getLocalizationContext,
	loadGraphSync,
	type RepoGraph,
} from '../tools/repo-graph';

interface CachedGraph {
	graph: RepoGraph;
	mtimeMs: number;
	size: number;
}

const cache = new Map<string, CachedGraph>();

/**
 * Load the repo graph for `directory`, using a per-directory cache that
 * invalidates on file mtime change. Returns null if no graph exists.
 *
 * Exported only for tests; production callers use the buildXxxBlock helpers below.
 */
export function getCachedGraph(directory: string): RepoGraph | null {
	const file = getGraphPath(directory);
	let stat: fs.Stats;
	try {
		stat = fs.statSync(file);
	} catch {
		// No graph file. Drop any stale cache entry.
		cache.delete(directory);
		return null;
	}
	const cached = cache.get(directory);
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
		return cached.graph;
	}
	let graph: RepoGraph | null;
	try {
		graph = loadGraphSync(directory);
	} catch {
		cache.delete(directory);
		return null;
	}
	if (!graph) {
		cache.delete(directory);
		return null;
	}
	cache.set(directory, { graph, mtimeMs: stat.mtimeMs, size: stat.size });
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
export function buildCoderLocalizationBlock(
	directory: string,
	targetFile: string,
): string | null {
	if (!targetFile) return null;
	const graph = getCachedGraph(directory);
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
export function buildReviewerBlastRadiusBlock(
	directory: string,
	changedFiles: string[],
): string | null {
	if (changedFiles.length === 0) return null;
	const graph = getCachedGraph(directory);
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
