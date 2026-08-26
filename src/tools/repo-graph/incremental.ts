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

import {
	addEdge,
	buildWorkspaceGraphAsync,
	isAssetEdge,
	isScannableSourcePath,
	MAX_EXTRACTOR_INPUT_WITNESSES,
	reconcileEdgeTargetKinds,
	scanFileAsync,
	upsertNode,
} from './builder';
import { clearCache, getCachedMtime } from './cache';
import { writeFingerprint } from './freshness';
import { resetQueryCache } from './query';
import { getGraphPath, loadGraph, saveGraph } from './storage';
import {
	deriveRepoRootId,
	mergeSymbolEdges,
	normalizeSymbolEdge,
} from './symbol-edge';
import type {
	BuildWorkspaceGraphOptions,
	GraphEdge,
	GraphExtractorInputWitness,
	RepoGraph,
	RepoGraphDiagnostics,
	SymbolEdge,
} from './types';
import { normalizeGraphPath, updateGraphMetadata } from './types';

/** Public options shared by hook, read-repair, and direct callers. */
export interface IncrementalUpdateOptions {
	forceRebuild?: boolean;
	/** Bounds and exclusions used by both direct and fallback full builds. */
	buildOptions?: BuildWorkspaceGraphOptions;
}

/**
 * DI seam for concurrency, scan-failure, and paired-persistence tests. Tests
 * must restore every replaced entry in afterEach.
 */
export const _internals: {
	stat: (path: string) => Promise<Stats>;
	scanFileAsync: typeof scanFileAsync;
	buildWorkspaceGraphAsync: typeof buildWorkspaceGraphAsync;
	saveGraph: typeof saveGraph;
	writeFingerprint: typeof writeFingerprint;
} = {
	stat: (p: string) => fsPromises.stat(p),
	scanFileAsync,
	buildWorkspaceGraphAsync,
	saveGraph,
	writeFingerprint,
};

const MAX_DIAGNOSTIC_ENTRIES = 200;

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
 * Validate the graph after filesystem reconciliation. Asset edges require
 * only their source node; node-to-node edges require both endpoints.
 */
function validateFileUpdates(graph: RepoGraph): {
	validationFailed: boolean;
	offendingEdge?: GraphEdge;
	reason?: 'missing-source-node' | 'missing-target-node';
} {
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

function diagnosticName(filePath: string, absoluteRoot: string): string {
	return path.relative(absoluteRoot, filePath).split(path.sep).join('/');
}

function dedupeCapped<T>(
	entries: readonly T[],
	keyOf: (entry: T) => string,
	limit = MAX_DIAGNOSTIC_ENTRIES,
): T[] {
	const seen = new Set<string>();
	const result: T[] = [];
	for (const entry of entries) {
		const key = keyOf(entry);
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(entry);
		if (result.length >= limit) break;
	}
	return result;
}

/** Replace diagnostics for one file while retaining unrelated entries. */
function replaceFileDiagnostics(
	graph: RepoGraph,
	file: string,
	replacement?: RepoGraphDiagnostics,
): void {
	const diagnostics: RepoGraphDiagnostics = { ...(graph.diagnostics ?? {}) };
	const replaceStrings = (
		current: readonly string[] | undefined,
		incoming: readonly string[] | undefined,
	): string[] =>
		dedupeCapped(
			[
				...(current ?? []).filter((entry) => entry !== file),
				...(incoming ?? []),
			],
			(entry) => entry,
		);

	diagnostics.extractionFailures = dedupeCapped(
		[
			...(diagnostics.extractionFailures ?? []).filter(
				(entry) => entry.file !== file,
			),
			...(replacement?.extractionFailures ?? []),
		],
		(entry) => `${entry.file}\u0000${entry.language}\u0000${entry.reason}`,
	);
	diagnostics.unresolvedImports = dedupeCapped(
		[
			...(diagnostics.unresolvedImports ?? []).filter(
				(entry) => entry.file !== file,
			),
			...(replacement?.unresolvedImports ?? []),
		],
		(entry) => `${entry.file}\u0000${entry.specifier}`,
	);
	diagnostics.oversizedFiles = replaceStrings(
		diagnostics.oversizedFiles,
		replacement?.oversizedFiles,
	);
	diagnostics.binaryFiles = replaceStrings(
		diagnostics.binaryFiles,
		replacement?.binaryFiles,
	);
	diagnostics.unreadableFiles = replaceStrings(
		diagnostics.unreadableFiles,
		replacement?.unreadableFiles,
	);
	diagnostics.validationSkippedFiles = replaceStrings(
		diagnostics.validationSkippedFiles,
		replacement?.validationSkippedFiles,
	);
	diagnostics.extractorInputWitnesses = dedupeCapped(
		[
			...(diagnostics.extractorInputWitnesses ?? []).filter(
				(entry) => entry.file !== file,
			),
			...(replacement?.extractorInputWitnesses ?? []),
		],
		(entry) => `${entry.kind}\u0000${entry.file}`,
		MAX_EXTRACTOR_INPUT_WITNESSES,
	);
	graph.diagnostics = diagnostics;
}

function scanDiagnostics(
	diagnostics: RepoGraphDiagnostics | undefined,
	inputWitness?: GraphExtractorInputWitness,
): RepoGraphDiagnostics | undefined {
	if (!diagnostics && !inputWitness) return undefined;
	return {
		...(diagnostics ?? {}),
		extractorInputWitnesses: inputWitness ? [inputWitness] : [],
	};
}

function isEnoent(error: unknown): boolean {
	return (
		error instanceof Error &&
		'code' in error &&
		(error as NodeJS.ErrnoException).code === 'ENOENT'
	);
}

/** Delete only when the immediately preceding async stat returned ENOENT. */
function applyAuthorizedDeletion(
	graph: RepoGraph,
	filePath: string,
	absoluteRoot: string,
): void {
	const normalizedPath = normalizeGraphPath(filePath);
	delete graph.nodes[normalizedPath];
	graph.edges = graph.edges.filter(
		(edge) =>
			normalizeGraphPath(edge.source) !== normalizedPath &&
			normalizeGraphPath(edge.target) !== normalizedPath,
	);
	if (graph.symbolEdges) {
		graph.symbolEdges = graph.symbolEdges.filter(
			(edge) =>
				normalizeGraphPath(edge.fromFile) !== normalizedPath &&
				normalizeGraphPath(edge.toFile) !== normalizedPath,
		);
	}
	replaceFileDiagnostics(graph, diagnosticName(filePath, absoluteRoot));
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
	options?: IncrementalUpdateOptions,
): Promise<RepoGraph> {
	// If forced rebuild, do full rebuild and save
	if (options?.forceRebuild) {
		const graph = await _internals.buildWorkspaceGraphAsync(
			workspaceRoot,
			options.buildOptions,
		);
		await persistGraph(workspaceRoot, graph, options.buildOptions);
		return graph;
	}

	// Try incremental update
	const existingGraph = await loadGraph(workspaceRoot);
	if (!existingGraph) {
		// No existing graph - fall back to full rebuild
		const graph = await _internals.buildWorkspaceGraphAsync(
			workspaceRoot,
			options?.buildOptions,
		);
		await persistGraph(workspaceRoot, graph, options?.buildOptions);
		return graph;
	}

	const graph = existingGraph;
	const absoluteRoot = path.resolve(workspaceRoot);
	const maxFileSize = options?.buildOptions?.maxFileSizeBytes ?? 1024 * 1024;

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

	const firstCheck = validateFileUpdates(graph);
	if (firstCheck.validationFailed) {
		return await fallBackToFullRebuild(
			workspaceRoot,
			firstCheck.offendingEdge,
			firstCheck.reason,
			options?.buildOptions,
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
				return await fallBackToFullRebuild(
					workspaceRoot,
					undefined,
					undefined,
					options?.buildOptions,
				);
			}
			await applyAsyncFileUpdates(
				freshGraph,
				filePaths,
				absoluteRoot,
				maxFileSize,
				buildManifestClosure(freshGraph, absoluteRoot),
			);
			const replayCheck = validateFileUpdates(freshGraph);
			if (replayCheck.validationFailed) {
				return await fallBackToFullRebuild(
					workspaceRoot,
					replayCheck.offendingEdge,
					replayCheck.reason,
					options?.buildOptions,
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
					return await fallBackToFullRebuild(
						workspaceRoot,
						undefined,
						undefined,
						options?.buildOptions,
					);
				}
			} catch {
				logger.warn(
					'[repo-graph] Re-stat failed after concurrent-modification replay — falling back to full rebuild',
				);
				return await fallBackToFullRebuild(
					workspaceRoot,
					undefined,
					undefined,
					options?.buildOptions,
				);
			}

			return finalizeAndSave(workspaceRoot, freshGraph, options?.buildOptions);
		}
	}

	return finalizeAndSave(workspaceRoot, graph, options?.buildOptions);
}

/**
 * Reconcile changed paths against live filesystem state. ENOENT is the only
 * file-deletion authorization; recreation is scanned normally, and transient
 * read failures preserve the last-known-good node and edges.
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

		// Defense in depth: only scannable source files become nodes. The write
		// hook already filters, but updateGraphForFiles is a public entry point
		// (issue #1985 review) — refuse to mutate the graph for an unsupported
		// extension rather than letting scanFileAsync create an 'unknown' node.
		if (!isScannableSourcePath(rawFilePath)) continue;

		const fileDiagnosticName = diagnosticName(rawFilePath, absoluteRoot);
		try {
			await _internals.stat(rawFilePath);
		} catch (error: unknown) {
			if (isEnoent(error)) {
				applyAuthorizedDeletion(graph, rawFilePath, absoluteRoot);
			} else {
				replaceFileDiagnostics(graph, fileDiagnosticName, {
					unreadableFiles: [fileDiagnosticName],
				});
			}
			continue;
		}

		const result = await _internals.scanFileAsync(
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

			try {
				upsertNode(graph, sanitizedNode);
			} catch {
				const validationWitness =
					typeof sanitizedNode.sizeBytes === 'number' &&
					typeof sanitizedNode.mtimeMs === 'number'
						? {
								file: fileDiagnosticName,
								kind: 'stable-skip' as const,
								sizeBytes: sanitizedNode.sizeBytes,
								mtimeMs: sanitizedNode.mtimeMs,
							}
						: undefined;
				replaceFileDiagnostics(
					graph,
					fileDiagnosticName,
					scanDiagnostics(
						{
							...result.diagnostics,
							validationSkippedFiles: [fileDiagnosticName],
						},
						validationWitness,
					),
				);
				continue;
			}

			graph.edges = graph.edges.filter(
				(edge) => normalizeGraphPath(edge.source) !== normalizedPath,
			);
			if (graph.symbolEdges) {
				graph.symbolEdges = graph.symbolEdges.filter(
					(edge) => normalizeGraphPath(edge.fromFile) !== normalizedPath,
				);
			}

			for (const edge of result.edges) {
				const edgeExists = graph.edges.some(
					(e) =>
						e.source === edge.source &&
						e.target === edge.target &&
						e.importSpecifier === edge.importSpecifier,
				);
				if (!edgeExists) {
					try {
						addEdge(graph, edge);
					} catch {
						/* invalid individual edge: retain the valid node */
					}
				}
			}

			if (result.symbolEdges.length > 0) {
				if (!graph.symbolEdges) {
					graph.symbolEdges = [];
				}
				const repoRootId =
					graph.repoRootId ?? deriveRepoRootId(graph.workspaceRoot);
				graph.repoRootId = repoRootId;
				graph.symbolEdges = graph.symbolEdges.map((edge) =>
					normalizeSymbolEdge(edge, graph.workspaceRoot, repoRootId),
				);
				const existingById = new Map(
					graph.symbolEdges.map((edge, index) => [edge.id as string, index]),
				);
				for (const symbolEdge of result.symbolEdges) {
					const normalized = normalizeSymbolEdge(
						symbolEdge,
						graph.workspaceRoot,
						repoRootId,
					);
					const existingIndex = existingById.get(normalized.id);
					if (existingIndex === undefined) {
						graph.symbolEdges.push(normalized);
						existingById.set(normalized.id, graph.symbolEdges.length - 1);
					} else {
						graph.symbolEdges[existingIndex] = mergeSymbolEdges(
							graph.symbolEdges[existingIndex] as SymbolEdge,
							normalized,
							graph.workspaceRoot,
							repoRootId,
						);
					}
				}
			}
			replaceFileDiagnostics(
				graph,
				fileDiagnosticName,
				scanDiagnostics(result.diagnostics, result.inputWitness),
			);
		} else {
			const definitelyUnindexable =
				(result.diagnostics?.oversizedFiles?.length ?? 0) > 0 ||
				(result.diagnostics?.binaryFiles?.length ?? 0) > 0;
			if (definitelyUnindexable) {
				graph.edges = graph.edges.filter(
					(edge) => normalizeGraphPath(edge.source) !== normalizedPath,
				);
				if (graph.symbolEdges) {
					graph.symbolEdges = graph.symbolEdges.filter(
						(edge) => normalizeGraphPath(edge.fromFile) !== normalizedPath,
					);
				}
				delete graph.nodes[normalizedPath];
				replaceFileDiagnostics(
					graph,
					fileDiagnosticName,
					scanDiagnostics(result.diagnostics, result.inputWitness),
				);
				continue;
			}

			try {
				await _internals.stat(rawFilePath);
				replaceFileDiagnostics(graph, fileDiagnosticName, {
					...result.diagnostics,
					unreadableFiles: [fileDiagnosticName],
				});
			} catch (error: unknown) {
				if (isEnoent(error)) {
					applyAuthorizedDeletion(graph, rawFilePath, absoluteRoot);
				} else {
					replaceFileDiagnostics(graph, fileDiagnosticName, {
						...result.diagnostics,
						unreadableFiles: [fileDiagnosticName],
					});
				}
			}
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
	buildOptions?: BuildWorkspaceGraphOptions,
): Promise<RepoGraph> {
	// Only keep symbolEdges when non-empty (matches buildWorkspaceGraphAsync behavior)
	if (graph.symbolEdges && graph.symbolEdges.length === 0) {
		delete graph.symbolEdges;
	}
	// The "a `'node'` target is a file that became a node" invariant has to hold
	// on EVERY path that mutates edges, not just full builds. An incremental
	// update rescans a file and re-adds its edges through `scanFileAsync`, which
	// resolves imports without consulting the walker's skip rules — so without
	// this, an incremental update silently re-introduces exactly the dangling
	// edges a full build had just reconciled away.
	reconcileEdgeTargetKinds(graph);
	updateGraphMetadata(graph);
	resetQueryCache();
	await persistGraph(workspaceRoot, graph, buildOptions);
	return graph;
}

async function persistGraph(
	workspaceRoot: string,
	graph: RepoGraph,
	buildOptions?: BuildWorkspaceGraphOptions,
): Promise<void> {
	await _internals.saveGraph(workspaceRoot, graph);
	await _internals.writeFingerprint(workspaceRoot, graph, {
		maxFiles: buildOptions?.maxFiles,
		walkBudgetMs: buildOptions?.walkBudgetMs,
		followSymlinks: buildOptions?.followSymlinks,
		excludeDirs: buildOptions?.excludeDirs,
	});
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
	buildOptions?: BuildWorkspaceGraphOptions,
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
	const rebuiltGraph = await _internals.buildWorkspaceGraphAsync(
		workspaceRoot,
		buildOptions,
	);
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
	await persistGraph(workspaceRoot, rebuiltGraph, buildOptions);
	return rebuiltGraph;
}
