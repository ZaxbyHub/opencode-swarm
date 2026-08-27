import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import { z } from 'zod';
import { loadPluginConfigWithMeta } from '../config/loader';
import { type RepoGraphConfig, RepoGraphConfigSchema } from '../config/schema';
import {
	containsControlChars,
	containsPathTraversal,
} from '../utils/path-security';
import { createSwarmTool } from './create-tool';
import {
	askGraph,
	buildOntologyPreflightPacket,
	buildWorkspaceGraphAsync,
	type FreshnessOptions,
	type FreshnessProbe,
	getBlastRadius,
	getCallers,
	getContextPack,
	getDeadExports,
	getDependencies,
	getFileOntology,
	getGraphHealth,
	getImporters,
	getKeyFiles,
	getLocalizationContext,
	getPackageBoundaries,
	getSymbolConsumers,
	inferPackageBoundary,
	isGraphWideInputPath,
	loadGraph,
	normalizeGraphPath,
	probeFreshness,
	type RepoGraph,
	saveGraph,
	updateGraphForFiles,
	writeFingerprint,
} from './repo-graph';

/**
 * repo_map: structural codebase awareness for swarm agents.
 *
 * Wraps the repo-graph query API in a single tool keyed off an `action`:
 *   - build         → (re)build the persistent .swarm/repo-graph.json
 *   - importers     → list files that import a given file
 *   - dependencies  → list files imported by a given file
 *   - blast_radius  → BFS over reverse edges; surface affected files + risk
 *   - localization  → compact context block for agent injection
 *   - key_files     → top-N most-imported files (architectural pillars)
 *
 * Always returns a JSON string. On error, returns
 *   { success: false, error: '...', action }.
 *
 * Auto-load: every action except `build` lazily loads the graph from
 * `.swarm/repo-graph.json`. Complete source drift at/below `refresh_cap` is
 * refreshed incrementally before answering. Missing, graph-wide, over-cap, or
 * inconclusive freshness is reported explicitly without an implicit full build.
 */

const VALID_ACTIONS = [
	'build',
	'importers',
	'dependencies',
	'blast_radius',
	'localization',
	'key_files',
	'ontology',
	'package_boundaries',
	'preflight_packet',
	'callers',
	'dead_exports',
	'context_pack',
	'graph_health',
	'ask',
] as const;

type RepoMapAction = (typeof VALID_ACTIONS)[number];

const MAX_FILE_PATH_LENGTH = 500;
const MAX_SYMBOL_LENGTH = 256;
const MAX_QUESTION_LENGTH = 500;
const REPO_GRAPH_DISABLED_NOTICE =
	'Repository graph is disabled by configuration (repo_graph.enabled=false).';

export const _internals = {
	loadPluginConfigWithMeta,
	probeFreshness,
	updateGraphForFiles,
	writeFingerprint,
};

interface RepoMapArgs {
	action: string;
	file?: string;
	files?: string[];
	symbol?: string;
	top_n?: number;
	max_depth?: number;
	question?: string;
	include_source?: boolean;
	max_tokens?: number;
	source_mode?: 'signature' | 'body' | 'mixed';
}

function validateFile(p: string): string | null {
	if (!p || typeof p !== 'string') return 'file is required';
	if (p.length === 0) return 'file is empty';
	if (p.length > MAX_FILE_PATH_LENGTH) {
		return `file exceeds maximum length of ${MAX_FILE_PATH_LENGTH}`;
	}
	if (containsControlChars(p)) return 'file contains control characters';
	if (containsPathTraversal(p)) return 'file contains path traversal';
	// Reject absolute paths (POSIX `/`, Windows `\`, drive letters like `C:`).
	// All graph paths are workspace-relative; an absolute input either escapes
	// the workspace or trivially mismatches the graph's relative keys.
	if (path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p)) {
		return 'file must be a workspace-relative path, not absolute';
	}
	return null;
}

function validateSymbol(s: string): string | null {
	if (s.length === 0) return 'symbol is empty';
	if (s.length > MAX_SYMBOL_LENGTH) {
		return `symbol exceeds maximum length of ${MAX_SYMBOL_LENGTH}`;
	}
	if (containsControlChars(s)) return 'symbol contains control characters';
	return null;
}

function validateQuestion(q: string): string | null {
	if (!q || q.trim().length === 0) return 'question is empty';
	if (q.length > MAX_QUESTION_LENGTH) {
		return `question exceeds maximum length of ${MAX_QUESTION_LENGTH}`;
	}
	if (containsControlChars(q)) return 'question contains control characters';
	return null;
}

function err(action: string, message: string): string {
	return JSON.stringify({ success: false, action, error: message }, null, 2);
}

function ok(action: string, payload: Record<string, unknown>): string {
	return JSON.stringify({ success: true, action, ...payload }, null, 2);
}

function resolveRepoGraphConfig(directory: string): RepoGraphConfig {
	try {
		const { config } = _internals.loadPluginConfigWithMeta(directory);
		return RepoGraphConfigSchema.parse(config.repo_graph ?? {});
	} catch {
		return RepoGraphConfigSchema.parse({});
	}
}

function freshnessOptions(config: RepoGraphConfig): FreshnessOptions {
	return {
		maxFiles: config.max_files,
		walkBudgetMs: config.walk_budget_ms,
		excludeDirs: config.exclude_dirs,
	};
}

function uniqueDriftPaths(probe: FreshnessProbe): string[] {
	return [...new Set([...probe.changed, ...probe.removed])];
}

interface RepoMapFreshnessMetadata {
	stale: boolean;
	probeState: FreshnessProbe['state'];
	changedFiles: number;
	refreshedFiles: number;
	freshnessNote?: string;
}

function metadataForProbe(
	probe: FreshnessProbe,
	detectedFiles: number,
	refreshedFiles: number,
	freshnessNote?: string,
): RepoMapFreshnessMetadata {
	return {
		stale: probe.state === 'drifted' || probe.state === 'no-fingerprint',
		probeState: probe.state,
		changedFiles: detectedFiles,
		refreshedFiles,
		...(freshnessNote ? { freshnessNote } : {}),
	};
}

/**
 * Resolve a workspace-relative target path. Accepts both absolute and relative
 * inputs but always returns a forward-slash, root-relative form for graph lookups.
 */
function toRelativeGraphPath(input: string, workspaceRoot: string): string {
	const normalized = input.replace(/\\/g, '/');
	if (path.isAbsolute(normalized)) {
		const rel = path.relative(workspaceRoot, normalized).replace(/\\/g, '/');
		return normalizeGraphPath(rel);
	}
	return normalizeGraphPath(normalized);
}

async function loadOrError(
	directory: string,
	action: string,
): Promise<{ ok: true; graph: RepoGraph } | { ok: false; response: string }> {
	try {
		const graph = await loadGraph(directory);
		if (!graph) {
			return {
				ok: false,
				response: err(
					action,
					'No repo graph found at .swarm/repo-graph.json. Run repo_map with action="build" first.',
				),
			};
		}
		return { ok: true, graph };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			response: err(action, `failed to load repo graph: ${message}`),
		};
	}
}

export const repo_map: ReturnType<typeof createSwarmTool> = createSwarmTool({
	description:
		'Query the repository code graph for structural awareness before editing. ' +
		'Actions: "build" (build/refresh .swarm/repo-graph.json), "importers" (who imports a file), ' +
		'"dependencies" (what a file imports), "blast_radius" (transitive dependents + risk), ' +
		'"localization" (compact context block for a target file), "key_files" (top-N most-imported files), ' +
		'"ontology" (file roles/routes/data/security/findings), "package_boundaries" (inferred package/layer boundaries), ' +
		'"preflight_packet" (bounded ontology packet for planning), ' +
		'"callers" (files that reference an exported symbol, call-site granularity; needs file+symbol), ' +
		'"dead_exports" (advisory: exported symbols with no detected in-repo reference; results are review candidates, not delete directives), ' +
		'"context_pack" (token-budgeted slice of source spans for a target symbol — definition + transitive callers/callees; advisory/conservative; needs file+symbol; uses max_depth for traversal depth, top_n for span cap; set include_source=true to embed source text in spans), ' +
		'"graph_health" (freshness and bounded extraction diagnostics; no file required), ' +
		'"ask" (zero-LLM file localization: pass a natural-language question to rank files by relevance via vocabulary expansion + IDF + PageRank; orientation only — read the located files before asserting anything about them). ' +
		'Use this before refactoring shared modules to avoid breaking unseen consumers. ' +
		'Note: "callers"/"dead_exports"/"context_pack" use conservative regex analysis (TS/JS/Python) and cannot see ' +
		'dynamic dispatch or namespace/barrel re-export usage; "dead_exports" results are review candidates, not delete directives.',
	args: {
		action: z
			.enum([
				'build',
				'importers',
				'dependencies',
				'blast_radius',
				'localization',
				'key_files',
				'ontology',
				'package_boundaries',
				'preflight_packet',
				'callers',
				'dead_exports',
				'context_pack',
				'graph_health',
				'ask',
			])
			.describe(
				'Query action: "build" | "importers" | "dependencies" | "blast_radius" | "localization" | "key_files" | "ontology" | "package_boundaries" | "preflight_packet" | "callers" | "dead_exports" | "context_pack" | "graph_health" | "ask"',
			),
		file: z
			.string()
			.optional()
			.describe(
				'Target file (workspace-relative or absolute). Required for importers/dependencies/localization/ontology. Optional for preflight_packet.',
			),
		files: z
			.array(z.string())
			.optional()
			.describe(
				'Multiple target files for blast_radius/preflight_packet. If omitted, falls back to `file`.',
			),
		symbol: z
			.string()
			.optional()
			.describe(
				'Exported symbol name. Restricts consumers on action="importers"; required for action="callers"/"context_pack".',
			),
		top_n: z
			.number()
			.int()
			.min(1)
			.max(100)
			.optional()
			.describe(
				'For action="key_files"/"package_boundaries": entries to return (default 10). For action="dead_exports": max candidates (default 100). For action="context_pack": max spans returned (default ~40 via token budget).',
			),
		max_depth: z
			.number()
			.int()
			.min(1)
			.max(10)
			.optional()
			.describe(
				'For action="blast_radius": max BFS depth (default 3). For action="context_pack": traversal depth (default 2).',
			),
		question: z
			.string()
			.optional()
			.describe(
				'Natural-language question for action="ask". Orientation only — read the located files before asserting anything about them.',
			),
		include_source: z
			.boolean()
			.optional()
			.describe(
				'For action="context_pack": embed source text in spans and return snippet objects (default false).',
			),
		max_tokens: z
			.number()
			.int()
			.min(1)
			.max(100000)
			.optional()
			.describe(
				'For action="context_pack": approximate token budget for the returned pack (default 4000). Packing is deterministic: spans are greedily admitted in relevance order (target → depth → file → symbol); the target span is always included even if it alone exceeds the budget. With include_source the budget is measured over the extracted source text.',
			),
		source_mode: z
			.enum(['signature', 'body', 'mixed'])
			.optional()
			.describe(
				'For action="context_pack" with include_source=true: "mixed" (default) embeds body text for near spans and signatures for the periphery; "body" embeds full range text for every span; "signature" embeds signatures only. Ignored (with a warning) when include_source is not true.',
			),
	},
	async execute(
		args: unknown,
		directory: string,
		_ctx?: ToolContext,
	): Promise<string> {
		const a = (args ?? {}) as RepoMapArgs;
		const action = String(a.action ?? '') as RepoMapAction;

		if (!VALID_ACTIONS.includes(action)) {
			return err(
				action || '(none)',
				`unknown action; expected one of: ${VALID_ACTIONS.join(', ')}`,
			);
		}

		const repoGraphConfig = resolveRepoGraphConfig(directory);
		if (!repoGraphConfig.enabled) {
			return err(action, REPO_GRAPH_DISABLED_NOTICE);
		}
		const probeOptions = freshnessOptions(repoGraphConfig);

		// ----- build -----
		if (action === 'build') {
			try {
				const start = Date.now();
				const graph = await buildWorkspaceGraphAsync(directory, probeOptions);
				await saveGraph(directory, graph);
				const fingerprintWritten = await _internals.writeFingerprint(
					directory,
					graph,
					probeOptions,
				);
				const elapsedMs = Date.now() - start;
				const fileCount = Object.keys(graph.nodes).length;
				const edgeCount = graph.edges.length;
				const ontologyFileCount = Object.values(graph.nodes).filter(
					(node) => node.ontology !== undefined,
				).length;
				return ok(action, {
					fileCount,
					edgeCount,
					ontologyFileCount,
					buildTimestamp: graph.metadata.generatedAt,
					elapsedMs,
					truncated: graph.diagnostics?.walkTruncated === true,
					fingerprintWritten,
					path: '.swarm/repo-graph.json',
				});
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				return err(action, `build failed: ${message}`);
			}
		}

		if (action === 'graph_health') {
			try {
				const graph = await loadGraph(directory);
				const probe = await _internals.probeFreshness(directory, probeOptions);
				return ok(action, { ...getGraphHealth(graph, directory, probe) });
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				return err(action, `failed to load repo graph: ${message}`);
			}
		}

		// All other actions need a loaded graph.
		const loaded = await loadOrError(directory, action);
		if (!loaded.ok) return loaded.response;
		let graph = loaded.graph;
		let probe = await _internals.probeFreshness(directory, probeOptions);
		const driftPaths = uniqueDriftPaths(probe);
		const detectedFiles = driftPaths.length;
		let refreshedFiles = 0;
		let freshnessNote: string | undefined;

		if (probe.state === 'drifted' && detectedFiles > 0) {
			const graphWideDrift = driftPaths.some(isGraphWideInputPath);
			if (graphWideDrift) {
				freshnessNote =
					'Graph-wide package manifest drift requires a full repo_map build; the stale graph was served without mutation.';
			} else if (
				repoGraphConfig.refresh_cap > 0 &&
				detectedFiles <= repoGraphConfig.refresh_cap
			) {
				try {
					graph = await _internals.updateGraphForFiles(directory, driftPaths, {
						buildOptions: probeOptions,
					});
					refreshedFiles = detectedFiles;
					probe = await _internals.probeFreshness(directory, probeOptions);
					if (probe.state !== 'clean') {
						freshnessNote =
							'Incremental refresh completed, but the follow-up probe did not certify a clean graph.';
					}
				} catch (error) {
					freshnessNote = `Incremental refresh failed; serving the stale graph: ${
						error instanceof Error ? error.message : String(error)
					}`;
				}
			} else {
				freshnessNote =
					repoGraphConfig.refresh_cap === 0
						? 'Automatic read-time refresh is disabled by repo_graph.refresh_cap=0; serving the stale graph.'
						: `Detected ${detectedFiles} changed files, above repo_graph.refresh_cap=${repoGraphConfig.refresh_cap}; serving the stale graph.`;
			}
		} else if (probe.state === 'no-fingerprint') {
			freshnessNote =
				'No matching repository-graph fingerprint is available; run repo_map action="build" to certify the graph.';
		} else if (probe.state === 'inconclusive') {
			freshnessNote =
				'Workspace freshness is unknown because the bounded probe did not complete; the existing graph was served without refresh or deletion.';
		}

		const freshness = metadataForProbe(
			probe,
			detectedFiles,
			refreshedFiles,
			freshnessNote,
		);

		// ----- key_files -----
		if (action === 'key_files') {
			const topN = a.top_n ?? 10;
			const nodes = getKeyFiles(graph, topN);
			const totalFiles = Object.keys(graph.nodes).length;
			const inDegrees = nodes.map(
				(n) => getImporters(graph, n.moduleName).length,
			);
			const maxInDegree = Math.max(1, ...inDegrees);
			const reverseCounts = nodes.map((n, i) => ({
				file: n.moduleName,
				language: n.language,
				exports: n.exports.length,
				roles: n.ontology?.roles ?? [],
				findings: n.ontology?.findings.length ?? 0,
				inDegree: inDegrees[i],
				hubScore: Math.round((inDegrees[i] / maxInDegree) * 1e4) / 1e4,
				community:
					n.ontology?.packageBoundary ?? inferPackageBoundary(n.moduleName),
			}));
			return ok(action, {
				count: reverseCounts.length,
				files: reverseCounts,
				budget: {
					returned: reverseCounts.length,
					dropped: Math.max(0, totalFiles - reverseCounts.length),
				},
				...freshness,
			});
		}

		if (action === 'package_boundaries') {
			const topN = a.top_n ?? 10;
			const boundaries = getPackageBoundaries(graph, topN);
			const maxDepOnBy = Math.max(
				1,
				...boundaries.map((b) => b.dependedOnBy.length),
			);
			const enriched = boundaries.map((b) => ({
				...b,
				hubScore: Math.round((b.dependedOnBy.length / maxDepOnBy) * 1e4) / 1e4,
				community: b.name,
			}));
			const totalBoundaries = new Set(
				Object.values(graph.nodes).map(
					(n) =>
						n.ontology?.packageBoundary ?? inferPackageBoundary(n.moduleName),
				),
			).size;
			return ok(action, {
				count: enriched.length,
				boundaries: enriched,
				budget: {
					returned: enriched.length,
					dropped: Math.max(0, totalBoundaries - enriched.length),
				},
				...freshness,
			});
		}

		if (action === 'dead_exports') {
			const result = getDeadExports(graph, { maxCandidates: a.top_n ?? 100 });
			return ok(action, {
				...result,
				budget: { returned: result.candidates.length },
				...freshness,
			});
		}

		if (action === 'preflight_packet') {
			const inputs =
				a.files && a.files.length > 0 ? a.files : a.file ? [a.file] : [];
			for (const f of inputs) {
				const v = validateFile(f);
				if (v) return err(action, `invalid file: ${v}`);
			}
			const targets = inputs.map((f) => toRelativeGraphPath(f, directory));
			return ok(action, {
				packet: buildOntologyPreflightPacket(graph, targets, {
					maxFiles: a.top_n ?? 12,
					maxBoundaries: 10,
				}),
				...freshness,
			});
		}

		if (action === 'ask') {
			if (!a.question) return err(action, 'ask requires `question`');
			const qErr = validateQuestion(a.question);
			if (qErr) return err(action, `invalid question: ${qErr}`);
			const topN = Math.min(a.top_n ?? 8, 25);
			const result = askGraph(graph, a.question, { topN });
			return ok(action, { ...result, ...freshness });
		}

		// Remaining actions need a file or files list.
		if (action === 'blast_radius') {
			const inputs =
				a.files && a.files.length > 0 ? a.files : a.file ? [a.file] : null;
			if (!inputs) {
				return err(action, 'blast_radius requires `file` or `files`');
			}
			for (const f of inputs) {
				const v = validateFile(f);
				if (v) return err(action, `invalid file: ${v}`);
			}
			const targets = inputs.map((f) => toRelativeGraphPath(f, directory));
			const result = getBlastRadius(graph, targets, a.max_depth ?? 3);
			return ok(action, { ...result, ...freshness });
		}

		if (!a.file) {
			return err(action, `${action} requires \`file\``);
		}
		const fileErr = validateFile(a.file);
		if (fileErr) return err(action, `invalid file: ${fileErr}`);
		const target = toRelativeGraphPath(a.file, directory);

		if (action === 'importers') {
			if (a.symbol !== undefined) {
				const sErr = validateSymbol(a.symbol);
				if (sErr) return err(action, `invalid symbol: ${sErr}`);
				const consumers = getSymbolConsumers(graph, target, a.symbol);
				return ok(action, {
					target,
					symbol: a.symbol,
					count: consumers.length,
					consumers,
					...freshness,
				});
			}
			const importers = getImporters(graph, target);
			return ok(action, {
				target,
				count: importers.length,
				importers,
				...freshness,
			});
		}

		if (action === 'callers') {
			if (a.symbol === undefined) {
				return err(action, 'callers requires `symbol` (the exported name)');
			}
			const sErr = validateSymbol(a.symbol);
			if (sErr) return err(action, `invalid symbol: ${sErr}`);
			const callers = getCallers(graph, target, a.symbol);
			return ok(action, {
				target,
				symbol: a.symbol,
				count: callers.length,
				callers,
				...freshness,
			});
		}

		if (action === 'context_pack') {
			if (a.symbol === undefined) {
				return err(
					action,
					'context_pack requires `symbol` (the exported name)',
				);
			}
			const sErr = validateSymbol(a.symbol);
			if (sErr) return err(action, `invalid symbol: ${sErr}`);
			const raw = getContextPack(graph, target, a.symbol, {
				maxDepth: a.max_depth ?? 2,
				maxTokens: a.max_tokens ?? 4000,
				includeSource: a.include_source ?? false,
				sourceMode: a.source_mode,
				directory,
			});
			// Normalize absolute paths to workspace-relative (Phase 4 SME caveat).
			// If the input is already relative (e.g. from a pre-1.2.0 graph fallback
			// that returns the original target), pass it through unchanged —
			// path.relative(directory, relativePath) would resolve against
			// the process's current working directory.
			const toRel = (p: string) => {
				if (!path.isAbsolute(p)) return p.replace(/\\/g, '/');
				try {
					return path.relative(directory, p).replace(/\\/g, '/');
				} catch {
					return p;
				}
			};
			// `|| target`: toRel yields '' only when the graph node's path IS the
			// workspace root itself (hand-crafted graph); fall back to the
			// validated workspace-relative input instead of emitting an empty file.
			const normalizedTarget = {
				...raw.target,
				file: toRel(raw.target.file) || target,
			};
			const normalizedSpans = raw.spans
				.map((s) => ({ ...s, file: toRel(s.file) }))
				.filter((s) => s.file.length > 0);
			const truncated =
				raw.truncated ||
				(a.top_n !== undefined && normalizedSpans.length > a.top_n);
			const cappedSpans =
				a.top_n !== undefined
					? normalizedSpans.slice(0, a.top_n)
					: normalizedSpans;
			// Coverage must reflect the FINAL response: top_n slicing happens
			// here, after the query-layer token budget already shaped the spans.
			const topNDropped = normalizedSpans.length - cappedSpans.length;
			const coverage = raw.coverage
				? {
						...raw.coverage,
						returnedSymbols: cappedSpans.length,
						omittedByBudget:
							raw.coverage.omittedByBudget + Math.max(0, topNDropped),
					}
				: undefined;
			// Bounded, deduplicated query-layer warnings + handler-level ones.
			const warnings = [...(raw.warnings ?? [])];
			if (
				a.source_mode !== undefined &&
				a.include_source !== true &&
				!warnings.includes('source_mode ignored: include_source is not true')
			) {
				warnings.push('source_mode ignored: include_source is not true');
			}
			if (freshnessNote && !warnings.includes(freshnessNote)) {
				warnings.push(freshnessNote);
			}
			// Snippets mirror the returned spans exactly: the top_n slice that
			// shaped `cappedSpans` must also bound `snippets`, or the response
			// would carry source text for symbols that were dropped.
			const returnedKeys = new Set(
				cappedSpans.map((s) => `${s.file}\0${s.symbol}`),
			);
			const normalizedSnippets = raw.snippets
				? raw.snippets
						.map((s) => ({ ...s, file: toRel(s.file) }))
						.filter(
							(s) =>
								s.file.length > 0 && returnedKeys.has(`${s.file}\0${s.symbol}`),
						)
				: undefined;
			return ok(action, {
				target: normalizedTarget,
				spans: cappedSpans,
				truncated,
				estimatedTokens: raw.estimatedTokens,
				budget: {
					returned: cappedSpans.length,
					dropped: Math.max(0, normalizedSpans.length - cappedSpans.length),
				},
				...freshness,
				schemaSupported: raw.schemaSupported,
				...(raw.note ? { note: raw.note } : {}),
				...(raw.sourceIncluded ? { sourceIncluded: true } : {}),
				...(normalizedSnippets ? { snippets: normalizedSnippets } : {}),
				...(coverage ? { coverage } : {}),
				warnings,
			});
		}

		if (action === 'dependencies') {
			const deps = getDependencies(graph, target);
			return ok(action, {
				target,
				count: deps.length,
				dependencies: deps,
				...freshness,
			});
		}

		if (action === 'localization') {
			const ctx = getLocalizationContext(graph, target, {
				maxDepth: a.max_depth,
			});
			return ok(action, { ...ctx, ...freshness });
		}

		if (action === 'ontology') {
			const ontology = getFileOntology(graph, target);
			if (!ontology) {
				return err(
					action,
					`No ontology facts found for ${target}. Rebuild the graph if the file was recently added.`,
				);
			}
			return ok(action, { target, ontology, ...freshness });
		}

		// Should be unreachable due to enum validation above.
		return err(action, 'unhandled action');
	},
});
