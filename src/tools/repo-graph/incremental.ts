/**
 * Incremental graph updates for changed files.
 *
 * updateGraphForFiles re-scans only the specified changed files, updates
 * their nodes and edges in the existing graph, and saves the result. It
 * includes an optimistic concurrency check (mtime comparison) so that
 * concurrent sessions do not overwrite each other's updates — when a race
 * is detected the function reloads the freshest on-disk graph and replays
 * the update once before falling back to a full rebuild.
 *
 * Asset edges (issue #1985, defect A1): an edge whose target is a real file
 * that never becomes a graph node (e.g. `import data from './data.json'`) is
 * tagged `targetKind: 'asset'`. Such edges only require their SOURCE node to
 * exist during validation, so a single asset import no longer forces a full
 * rebuild on every incremental update.
 */

import { existsSync, readdirSync, type Stats } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as logger from '../../utils/logger';
import { containsControlChars } from '../../utils/path-security';

/**
 * DI seam for the optimistic-concurrency stat check (defect A4). Tests override
 * `stat` to inject deterministic mtime shifts between load and the pre-save
 * re-check, exercising the reload-and-replay branch without races. Defaults to
 * the real `fsPromises.stat`. Restore in afterEach.
 */
export const _internals: {
	stat: (path: string) => Promise<Stats>;
} = {
	stat: (p: string) => fsPromises.stat(p),
};

import {
	addEdge,
	buildWorkspaceGraphAsync,
	isAssetEdge,
	isScannableSourcePath,
	scanFileAsync,
	upsertNode,
} from './builder';
import { clearCache, getCachedMtime } from './cache';
import { resetQueryCache } from './query';
import { getGraphPath, loadGraph, saveGraph } from './storage';
import type { GraphEdge, RepoGraph, SymbolEdge } from './types';
import { normalizeGraphPath, updateGraphMetadata } from './types';

/** Manifest basenames that mark a directory as a package root (mirrors builder). */
const MANIFEST_BASENAMES = new Set([
	'package.json',
	'Cargo.toml',
	'pyproject.toml',
	'go.mod',
]);

/**
 * Build a bounded `hasManifest(relDir)` closure for the incremental re-scan by
 * checking the unique ancestor directories of existing graph nodes for a package
 * manifest (defect A8 consistency, issue #1985 review). This keeps the manifest-
 * driven package boundary stable across incremental edits without redoing a full
 * workspace walk. A manifest anywhere on a node's directory chain counts (the
 * boundary rule queries `parts[0]` and `parts[0]/parts[1]`), so each ancestor up
 * to the workspace root is checked. Bounded: at most one `readdirSync` per
 * unique ancestor directory across all nodes.
 */
function buildManifestClosure(
	graph: RepoGraph,
	absoluteRoot: string,
): (relDir: string) => boolean {
	// Collect every unique ancestor directory (including the node's own parent)
	// of every node, so a manifest at any depth on the chain is detected.
	const dirs = new Set<string>();
	for (const node of Object.values(graph.nodes)) {
		const absDir = path.dirname(node.filePath);
		let rel = path.relative(absoluteRoot, absDir).split(path.sep).join('/');
		rel = rel.replace(/^(?:\.\/)+/, '');
		// Walk up the chain, recording each ancestor.
		while (true) {
			dirs.add(rel);
			const idx = rel.lastIndexOf('/');
			if (idx < 0) {
				if (rel !== '') dirs.add('');
				break;
			}
			rel = rel.slice(0, idx);
		}
	}
	const manifestDirs = new Set<string>();
	for (const relDir of dirs) {
		const absDir =
			relDir === '' ? absoluteRoot : path.join(absoluteRoot, relDir);
		try {
			const entries = readdirSync(absDir);
			if (entries.some((name) => MANIFEST_BASENAMES.has(name))) {
				manifestDirs.add(relDir);
			}
		} catch {
			/* directory unreadable — treat as no manifest */
		}
	}
	return (relDir: string) => manifestDirs.has(relDir);
}

/**
 * Delete + validation half of the per-file update. For each changed file that
 * no longer exists on disk, remove its node and all edges referencing it; then
 * validate the resulting edge set. The async re-scan of still-existing files
 * is handled separately by {@link applyAsyncFileUpdates}. Splitting the two
 * halves lets both the normal incremental path and the concurrent-save replay
 * path (defect A4) share one validation implementation.
 *
 * Asset edges only require their source node to exist; node→node edges require
 * both endpoints (defect A1). Returns `validationFailed: true` when a genuine
 * orphan edge remains, along with the offending edge for diagnostics.
 */
function applyFileUpdates(
	graph: RepoGraph,
	filePaths: string[],
): {
	validationFailed: boolean;
	offendingEdge?: GraphEdge;
	reason?: 'missing-source-node' | 'missing-target-node';
} {
	for (const rawFilePath of filePaths) {
		const normalizedPath = normalizeGraphPath(rawFilePath);
		if (existsSync(rawFilePath)) continue;

		// File was deleted - remove its node and all edges referencing it.
		// NOTE (defect A1): asset edges whose target no longer exists on disk
		// are retained but query-inert (assets are excluded from the reverse /
		// forward indexes and every direct edge loop); pruning them is out of
		// scope for this fix.
		delete graph.nodes[normalizedPath];
		graph.edges = graph.edges.filter(
			(e) =>
				normalizeGraphPath(e.source) !== normalizedPath &&
				normalizeGraphPath(e.target) !== normalizedPath,
		);
		if (graph.symbolEdges) {
			graph.symbolEdges = graph.symbolEdges.filter(
				(se) =>
					normalizeGraphPath(se.fromFile) !== normalizedPath &&
					normalizeGraphPath(se.toFile) !== normalizedPath,
			);
		}
	}

	// Validate that edge endpoints have corresponding nodes. Asset edges
	// (targetKind 'asset', or untagged edges whose target is not a scannable
	// source file on pre-1.3.0 graphs) only require their source node; node→node
	// edges require both endpoints (defect A1).
	for (const edge of graph.edges) {
		const normalizedSource = normalizeGraphPath(edge.source);
		if (!graph.nodes[normalizedSource]) {
			return {
				validationFailed: true,
				offendingEdge: edge,
				reason: 'missing-source-node',
			};
		}
		if (!isAssetEdge(edge)) {
			const normalizedTarget = normalizeGraphPath(edge.target);
			if (!graph.nodes[normalizedTarget]) {
				return {
					validationFailed: true,
					offendingEdge: edge,
					reason: 'missing-target-node',
				};
			}
		}
	}

	// Prune stale symbolEdges whose fromFile or toFile node no longer exists.
	if (graph.symbolEdges && graph.symbolEdges.length > 0) {
		const validSymbolEdges: SymbolEdge[] = [];
		for (const symbolEdge of graph.symbolEdges) {
			const normalizedFromFile = normalizeGraphPath(symbolEdge.fromFile);
			const normalizedToFile = normalizeGraphPath(symbolEdge.toFile);
			if (graph.nodes[normalizedFromFile] && graph.nodes[normalizedToFile]) {
				validSymbolEdges.push(symbolEdge);
			}
		}
		graph.symbolEdges = validSymbolEdges;
	}

	return { validationFailed: false };
}

/**
 * Incrementally update the graph for a set of changed files.
 * Re-scans only the specified files, updates their nodes and edges,
 * and falls back to a full rebuild if the incremental pass cannot be validated.
 *
 * @param workspaceRoot - Workspace root directory (relative path)
 * @param filePaths - Array of absolute file paths that changed
 * @param options - Optional configuration
 * @param options.forceRebuild - Force a full rebuild instead of incremental
 * @returns Updated RepoGraph
 */
export async function updateGraphForFiles(
	workspaceRoot: string,
	filePaths: string[],
	options?: { forceRebuild?: boolean },
): Promise<RepoGraph> {
	// If forced rebuild, do full rebuild and save
	if (options?.forceRebuild) {
		const graph = await buildWorkspaceGraphAsync(workspaceRoot);
		await saveGraph(workspaceRoot, graph);
		return graph;
	}

	// Try incremental update
	const existingGraph = await loadGraph(workspaceRoot);
	if (!existingGraph) {
		// No existing graph - fall back to full rebuild
		const graph = await buildWorkspaceGraphAsync(workspaceRoot);
		await saveGraph(workspaceRoot, graph);
		return graph;
	}

	const graph = existingGraph;
	const absoluteRoot = path.resolve(workspaceRoot);
	const maxFileSize = 1024 * 1024; // 1MB default

	// Manifest-aware package boundaries must stay consistent with the initial
	// build across incremental edits (defect A8). Re-derive a bounded
	// hasManifest closure from the existing graph's node directories.
	const hasManifest = buildManifestClosure(graph, absoluteRoot);

	await applyAsyncFileUpdates(
		graph,
		filePaths,
		absoluteRoot,
		maxFileSize,
		hasManifest,
	);

	const firstCheck = applyFileUpdates(graph, filePaths);
	if (firstCheck.validationFailed) {
		return await fallBackToFullRebuild(
			workspaceRoot,
			firstCheck.offendingEdge,
			firstCheck.reason,
		);
	}

	// Optimistic concurrency: check that the on-disk graph has not been
	// modified by another session since we loaded it. If the mtime differs,
	// another process saved a newer graph while we were computing our
	// incremental update. Reload the freshest graph, replay the update ONCE,
	// and if the mtime moved again during replay, fall back to a full rebuild
	// (defect A4 — bounded, never loops).
	const normalizedWorkspace = path.normalize(workspaceRoot);
	const loadedMtime = getCachedMtime(normalizedWorkspace);
	if (loadedMtime !== undefined) {
		const graphPath = getGraphPath(workspaceRoot);
		// The stat check is wrapped narrowly: a stat failure is a transient
		// I/O error we tolerate (proceed with the save). Every other branch
		// (mismatch detected, reload, replay) is handled explicitly below so a
		// failure there can NEVER fall through to saving the stale `graph` over
		// a newer on-disk graph (issue #1985 review).
		let currentStats: Stats | null = null;
		try {
			if (existsSync(graphPath)) {
				currentStats = await _internals.stat(graphPath);
			}
		} catch {
			// If we can't stat the file, proceed with the save anyway.
		}
		if (currentStats !== null && currentStats.mtimeMs !== loadedMtime) {
			// Concurrent modification detected — `graph` is now stale. Never
			// return to saving it: reload + replay, or terminal rebuild.
			clearCacheAndResetQuery(normalizedWorkspace);
			const freshGraph = await loadGraph(workspaceRoot);
			if (!freshGraph) {
				// File vanished between our load and the concurrent write —
				// full rebuild reconciles from the live workspace.
				return await fallBackToFullRebuild(workspaceRoot);
			}
			await applyAsyncFileUpdates(
				freshGraph,
				filePaths,
				absoluteRoot,
				maxFileSize,
				buildManifestClosure(freshGraph, absoluteRoot),
			);
			const replayCheck = applyFileUpdates(freshGraph, filePaths);
			if (replayCheck.validationFailed) {
				return await fallBackToFullRebuild(
					workspaceRoot,
					replayCheck.offendingEdge,
					replayCheck.reason,
				);
			}
			// Re-stat before save: if the mtime moved AGAIN during replay,
			// another writer beat us — terminal full rebuild. A re-stat failure
			// here is also treated as a rebuild (fail closed under concurrency).
			const postReplayMtime = getCachedMtime(normalizedWorkspace);
			try {
				const postReplayStats = await _internals.stat(graphPath);
				if (
					postReplayMtime !== undefined &&
					postReplayStats.mtimeMs !== postReplayMtime
				) {
					logger.warn(
						'[repo-graph] Concurrent modification persisted during replay — falling back to full rebuild',
					);
					return await fallBackToFullRebuild(workspaceRoot);
				}
			} catch {
				logger.warn(
					'[repo-graph] Re-stat failed after concurrent-modification replay — falling back to full rebuild',
				);
				return await fallBackToFullRebuild(workspaceRoot);
			}

			return finalizeAndSave(workspaceRoot, freshGraph);
		}
	}

	return finalizeAndSave(workspaceRoot, graph);
}

/**
 * Async re-scan half of the per-file update: for each existing file, remove
 * its old outgoing edges/symbolEdges, re-scan, and fold the new node + edges
 * + symbolEdges into `graph`. Deleted files are handled by the synchronous
 * `applyFileUpdates` delete branch.
 *
 * `hasManifest` (when available) is forwarded to the scanner so manifest-aware
 * package boundaries stay consistent with the initial build (defect A8). A
 * previously-tracked source file whose rescan returns `node: null` (it became
 * oversized, binary, or unreadable) has its stale node removed and any
 * incoming node→node edges caught by the subsequent validation fallback.
 */
async function applyAsyncFileUpdates(
	graph: RepoGraph,
	filePaths: string[],
	absoluteRoot: string,
	maxFileSize: number,
	hasManifest?: (relDir: string) => boolean,
): Promise<void> {
	for (const rawFilePath of filePaths) {
		const normalizedPath = normalizeGraphPath(rawFilePath);
		if (!existsSync(rawFilePath)) continue;

		// Defense in depth: only scannable source files become nodes. The write
		// hook already filters, but updateGraphForFiles is a public entry point
		// (issue #1985 review) — refuse to mutate the graph for an unsupported
		// extension rather than letting scanFileAsync create an 'unknown' node.
		if (!isScannableSourcePath(rawFilePath)) continue;

		// Remove old edges from this file before adding new ones.
		graph.edges = graph.edges.filter(
			(e) => normalizeGraphPath(e.source) !== normalizedPath,
		);
		if (graph.symbolEdges) {
			graph.symbolEdges = graph.symbolEdges.filter(
				(se) => normalizeGraphPath(se.fromFile) !== normalizedPath,
			);
		}

		const result = await scanFileAsync(
			rawFilePath,
			absoluteRoot,
			maxFileSize,
			hasManifest,
		);

		if (result.node) {
			// Sanitize imports: strip control-char specifiers that tree-sitter
			// may return raw (mirrors parseFileImports filtering in the sync path).
			const sanitizedImports = result.node.imports.filter(
				(imp) => !containsControlChars(imp),
			);
			const sanitizedNode: typeof result.node = {
				...result.node,
				imports: sanitizedImports,
			};

			delete graph.nodes[normalizedPath];
			upsertNode(graph, sanitizedNode);

			for (const edge of result.edges) {
				const edgeExists = graph.edges.some(
					(e) =>
						e.source === edge.source &&
						e.target === edge.target &&
						e.importSpecifier === edge.importSpecifier,
				);
				if (!edgeExists) {
					addEdge(graph, edge);
				}
			}

			if (result.symbolEdges.length > 0) {
				if (!graph.symbolEdges) {
					graph.symbolEdges = [];
				}
				const existingKeys = new Set(
					graph.symbolEdges.map(
						(se) =>
							`${se.fromFile}\u0000${se.fromSymbol}\u0000${se.toFile}\u0000${se.toSymbol}`,
					),
				);
				for (const symbolEdge of result.symbolEdges) {
					const key = `${symbolEdge.fromFile}\u0000${symbolEdge.fromSymbol}\u0000${symbolEdge.toFile}\u0000${symbolEdge.toSymbol}`;
					if (!existingKeys.has(key)) {
						graph.symbolEdges.push(symbolEdge);
						existingKeys.add(key);
					}
				}
			}
		} else {
			// The file was previously a node but is now oversized/binary/
			// unreadable. Remove its stale node so the subsequent validation
			// pass catches any dangling incoming node→node edges and triggers
			// the documented full-rebuild fallback (issue #1985 review).
			delete graph.nodes[normalizedPath];
		}
	}
}

function clearCacheAndResetQuery(normalizedWorkspace: string): void {
	clearCache(normalizedWorkspace);
	resetQueryCache();
}

async function finalizeAndSave(
	workspaceRoot: string,
	graph: RepoGraph,
): Promise<RepoGraph> {
	// Only keep symbolEdges when non-empty (matches buildWorkspaceGraphAsync behavior)
	if (graph.symbolEdges && graph.symbolEdges.length === 0) {
		delete graph.symbolEdges;
	}
	updateGraphMetadata(graph);
	resetQueryCache();
	await saveGraph(workspaceRoot, graph);
	return graph;
}

/**
 * Fall back to a full workspace rebuild, logging the specific offending edge
 * (when available) and incrementing the `incrementalFallbacks` diagnostics
 * counter so `graph_health` can surface recurring fallbacks (defect A1/A7).
 */
async function fallBackToFullRebuild(
	workspaceRoot: string,
	offendingEdge?: GraphEdge,
	reason?: 'missing-source-node' | 'missing-target-node',
): Promise<RepoGraph> {
	if (offendingEdge) {
		logger.warn(
			`[repo-graph] Incremental update failed, falling back to full rebuild ` +
				`(offending edge: source=${offendingEdge.source} target=${offendingEdge.target} ` +
				`importSpecifier=${offendingEdge.importSpecifier}` +
				(reason ? `, reason=${reason}` : '') +
				`)`,
		);
	} else {
		logger.warn(
			'[repo-graph] Concurrent modification detected — falling back to full rebuild',
		);
	}
	const rebuiltGraph = await buildWorkspaceGraphAsync(workspaceRoot);
	// Bump the fallback counter without clobbering extraction diagnostics.
	const prev = rebuiltGraph.diagnostics ?? {};
	const prevFallbacks =
		typeof prev.incrementalFallbacks === 'number'
			? prev.incrementalFallbacks
			: 0;
	rebuiltGraph.diagnostics = {
		...prev,
		incrementalFallbacks: prevFallbacks + 1,
	};
	await saveGraph(workspaceRoot, rebuiltGraph);
	return rebuiltGraph;
}
