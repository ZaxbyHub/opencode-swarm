import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import { z } from 'zod';
import { loadPluginConfigWithMeta } from '../config/loader';
import { type RepoGraphConfig, RepoGraphConfigSchema } from '../config/schema';
import { telemetry } from '../telemetry';
import {
	containsControlChars,
	containsPathTraversal,
} from '../utils/path-security';
import { createSwarmTool } from './create-tool';
import {
	askGraph,
	buildOntologyPreflightPacket,
	buildTestPack,
	buildWorkspaceGraphAsync,
	explainGraphEntry,
	type FreshnessOptions,
	type FreshnessProbe,
	getBlastRadius,
	getCallers,
	getContextPack,
	getDeadExports,
	getDependencies,
	getDiffContext,
	getFileOntology,
	getGraphHealth,
	getImpactCone,
	getImporters,
	getKeyFiles,
	getLocalizationContext,
	getPackageBoundaries,
	getSymbolConsumers,
	getSymbolContext,
	inferPackageBoundary,
	isGraphWideInputPath,
	loadGraph,
	normalizeGraphPath,
	probeFreshness,
	type RepoGraph,
	type RouteMethod,
	routeRetrieval,
	saveGraph,
	searchSymbols,
	traceData,
	traceRoute,
	updateGraphForFiles,
	writeFingerprint,
} from './repo-graph';
import { searchWorkspaceLiteral } from './search';

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
	'symbol_search',
	'symbol_context',
	'impact_cone',
	'diff_context',
	'graph_explain',
	'route_trace',
	'data_trace',
	'test_pack',
	'graph_health',
	'ask',
	'retrieve',
] as const;

type RepoMapAction = (typeof VALID_ACTIONS)[number];

const MAX_FILE_PATH_LENGTH = 500;
const MAX_SYMBOL_LENGTH = 256;
const MAX_QUESTION_LENGTH = 500;
const MAX_LANGUAGE_LENGTH = 64;
const MAX_DIFF_LENGTH = 50_000;
const MAX_ROUTE_PATH_LENGTH = 500;
const ROUTE_METHODS: readonly RouteMethod[] = [
	'GET',
	'POST',
	'PUT',
	'PATCH',
	'DELETE',
	'OPTIONS',
	'HEAD',
	'ALL',
];
const REPO_GRAPH_DISABLED_NOTICE =
	'Repository graph is disabled by configuration (repo_graph.enabled=false).';

export const _internals = {
	loadPluginConfigWithMeta,
	probeFreshness,
	updateGraphForFiles,
	writeFingerprint,
	telemetry,
};

interface RepoMapArgs {
	action: string;
	file?: string;
	files?: string[];
	symbol?: string;
	symbol_id?: string;
	top_n?: number;
	max_depth?: number;
	question?: string;
	include_source?: boolean;
	max_tokens?: number;
	source_mode?: 'signature' | 'body' | 'mixed';
	kind?:
		| 'function'
		| 'class'
		| 'const'
		| 'type'
		| 'interface'
		| 'enum'
		| 'method';
	visibility?: 'exported' | 'module-local';
	language?: string;
	diff?: string;
	line?: number;
	route_path?: string;
	method?: RouteMethod;
	entity?: string;
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

function validateSymbolId(id: string): string | null {
	if (!/^[0-9a-f]{64}$/.test(id)) {
		return 'symbol_id must be a 64-character lowercase hex string (a stable symbol id from symbol_context)';
	}
	return null;
}

function validateLanguage(language: string): string | null {
	if (language.length === 0) return 'language is empty';
	if (language.length > MAX_LANGUAGE_LENGTH) {
		return `language exceeds maximum length of ${MAX_LANGUAGE_LENGTH}`;
	}
	if (containsControlChars(language)) {
		return 'language contains control characters';
	}
	return null;
}

/**
 * Route paths may contain dynamic segments (`/api/users/[id]`, `:id`) so the
 * file-path rules do not apply; the security-relevant checks are bounded
 * length, no control characters, no `..` traversal, and a leading slash.
 */
function validateRoutePath(p: string): string | null {
	if (p.length === 0) return 'route_path is empty';
	if (p.length > MAX_ROUTE_PATH_LENGTH) {
		return `route_path exceeds maximum length of ${MAX_ROUTE_PATH_LENGTH}`;
	}
	if (containsControlChars(p)) return 'route_path contains control characters';
	if (containsPathTraversal(p)) return 'route_path contains path traversal';
	if (!p.startsWith('/')) return 'route_path must start with "/"';
	return null;
}

function validateMethod(method: string): string | null {
	if (!(ROUTE_METHODS as readonly string[]).includes(method)) {
		return `method must be one of: ${ROUTE_METHODS.join(', ')}`;
	}
	return null;
}

/**
 * Entities are entity/table names, config/env keys, or Prisma-style model
 * names (e.g. `user`, `userAccount`, `API_BASE_URL`) — the same bound as
 * symbols: non-empty, <=256 chars, no control characters.
 */
function validateEntity(entity: string): string | null {
	if (entity.length === 0) return 'entity is empty';
	if (entity.length > MAX_SYMBOL_LENGTH) {
		return `entity exceeds maximum length of ${MAX_SYMBOL_LENGTH}`;
	}
	if (containsControlChars(entity)) return 'entity contains control characters';
	if (containsPathTraversal(entity)) return 'entity contains path traversal';
	return null;
}

/**
 * Validate diff text. `containsControlChars` rejects ALL code points <= 0x1f
 * — including the \r\n\t a unified diff legitimately contains — so the diff
 * check first strips those three, then runs the shared scanner. The error
 * names the character class without echoing the offending byte.
 */
function validateDiffText(diff: string): string | null {
	if (diff.trim().length === 0) return 'diff is empty';
	if (diff.length > MAX_DIFF_LENGTH) {
		return `diff exceeds maximum length of ${MAX_DIFF_LENGTH}`;
	}
	const stripped = diff.replace(/[\r\n\t]/g, '');
	if (containsControlChars(stripped)) {
		const hasBidi = /[\u202a-\u202e\u2066-\u2069]/.test(diff);
		return `diff contains control characters (class: ${
			hasBidi ? 'bidi' : 'control'
		}); only newlines and tabs are allowed`;
	}
	return null;
}

function err(action: string, message: string): string {
	return JSON.stringify({ success: false, action, error: message }, null, 2);
}

function ok(action: string, payload: Record<string, unknown>): string {
	return JSON.stringify({ success: true, action, ...payload }, null, 2);
}

/**
 * Uniform error-extraction for the KG-14 action handlers (OW-7): every new
 * action wraps its query call so an unexpected throw yields THIS module's
 * `{success, action, error}` envelope rather than the generic
 * create-tool failure shape, keeping `.action`-keyed consumers working.
 */
function failureMessage(e: unknown): string {
	const message = e instanceof Error ? e.message : String(e);
	return message;
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

async function prepareGraphQuery(
	directory: string,
	action: string,
	config: RepoGraphConfig,
): Promise<
	| { ok: true; graph: RepoGraph; freshness: RepoMapFreshnessMetadata }
	| { ok: false; response: string }
> {
	const loaded = await loadOrError(directory, action);
	if (!loaded.ok) return loaded;
	let graph = loaded.graph;
	const options = freshnessOptions(config);
	let probe = await _internals.probeFreshness(directory, options);
	const driftPaths = uniqueDriftPaths(probe);
	const detectedFiles = driftPaths.length;
	let refreshedFiles = 0;
	let freshnessNote: string | undefined;
	if (probe.state === 'drifted' && detectedFiles > 0) {
		if (driftPaths.some(isGraphWideInputPath)) {
			freshnessNote =
				'Graph-wide package manifest drift requires a full repo_map build; the stale graph was served without mutation.';
		} else if (config.refresh_cap > 0 && detectedFiles <= config.refresh_cap) {
			try {
				graph = await _internals.updateGraphForFiles(directory, driftPaths, {
					buildOptions: options,
				});
				refreshedFiles = detectedFiles;
				probe = await _internals.probeFreshness(directory, options);
				if (probe.state !== 'clean')
					freshnessNote =
						'Incremental refresh completed, but the follow-up probe did not certify a clean graph.';
			} catch (error) {
				freshnessNote = `Incremental refresh failed; serving the stale graph: ${
					error instanceof Error ? error.message : String(error)
				}`;
			}
		} else {
			freshnessNote =
				config.refresh_cap === 0
					? 'Automatic read-time refresh is disabled by repo_graph.refresh_cap=0; serving the stale graph.'
					: `Detected ${detectedFiles} changed files, above repo_graph.refresh_cap=${config.refresh_cap}; serving the stale graph.`;
		}
	} else if (probe.state === 'no-fingerprint') {
		freshnessNote =
			'No matching repository-graph fingerprint is available; run repo_map action="build" to certify the graph.';
	} else if (probe.state === 'inconclusive') {
		freshnessNote =
			'Workspace freshness is unknown because the bounded probe did not complete; the existing graph was served without refresh or deletion.';
	}
	return {
		ok: true,
		graph,
		freshness: metadataForProbe(
			probe,
			detectedFiles,
			refreshedFiles,
			freshnessNote,
		),
	};
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
		'"symbol_search" (find symbols by name with tiered, case-insensitive matching — exact/prefix/substring/subsequence, reported in each hit\'s `match` field — filterable by kind, language, file, and visibility; needs symbol as the search term; kind filters require a schema 1.6.0+ graph), ' +
		'"symbol_context" (focused definition-first context for one symbol — identity, stable symbol_id, signature, optional source, and direct callers/callees; needs file+symbol or symbol_id), ' +
		'"impact_cone" (structured impact of changing a file or symbol — symbol-level callers/callees by depth with confidence, file-level blast radius and risk, affected tests, routes, data/security facts, package boundaries; needs file, optional symbol), ' +
		'"diff_context" (map changed files or a unified diff to changed symbols and per-file impact cones; needs files or diff; diff paths must be workspace-relative and safe), ' +
		'"graph_explain" (explain why a file/symbol/span is graph-relevant — definition, incoming/outgoing symbol edges with provenance evidence, file-level importers; needs file, optional symbol or line), ' +
		'"route_trace" (change-risk pack for a route — handler + symbol binding with confidence, depth-1 services, data operations, auth/validation facts, unguarded-route findings, covering tests; needs route_path, file, or symbol; advisory, regex-based), ' +
		'"data_trace" (change-risk pack for an entity/table/config/env key — readers, writers, deleters, configurers, touching routes, tests, and risk notes; needs entity, file, or symbol; advisory), ' +
		'"test_pack" (tests, fixtures, helpers, and coverage hints for a file/symbol/changed files — explicit imports and colocated-name heuristics, missing-test warnings; needs file, files, symbol, or diff; never executes tests), ' +
		'"graph_health" (freshness and bounded extraction diagnostics; no file required), ' +
		'"ask" (zero-LLM file localization: pass a natural-language question to rank files by relevance via vocabulary expansion + IDF + PageRank; orientation only — read the located files before asserting anything about them). ' +
		'"retrieve" (deterministic graph/lexical/semantic/security/test/hybrid context routing with explicit explanation, fallback, budgets, and content-free telemetry; needs question). ' +
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
				'symbol_search',
				'symbol_context',
				'impact_cone',
				'diff_context',
				'graph_explain',
				'route_trace',
				'data_trace',
				'test_pack',
				'graph_health',
				'ask',
				'retrieve',
			])
			.describe(
				'Query action: "build" | "importers" | "dependencies" | "blast_radius" | "localization" | "key_files" | "ontology" | "package_boundaries" | "preflight_packet" | "callers" | "dead_exports" | "context_pack" | "symbol_search" | "symbol_context" | "impact_cone" | "diff_context" | "graph_explain" | "route_trace" | "data_trace" | "test_pack" | "graph_health" | "ask" | "retrieve"',
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
				'Exported symbol name. Restricts consumers on action="importers"; required for action="callers"/"context_pack". For action="symbol_search" it is the search term (name, prefix, or subsequence fragment; matching is case-insensitive). For action="symbol_context"/"impact_cone"/"graph_explain" it selects a specific symbol in the target file.',
			),
		symbol_id: z
			.string()
			.regex(/^[0-9a-f]{64}$/)
			.optional()
			.describe(
				'For action="symbol_context": resolve a symbol by its stable 64-hex id (as returned in symbol_context identity) instead of file+symbol.',
			),
		top_n: z
			.number()
			.int()
			.min(1)
			.max(100)
			.optional()
			.describe(
				'For action="key_files"/"package_boundaries": entries to return (default 10). For action="dead_exports": max candidates (default 100). For action="context_pack": max spans returned (default ~40 via token budget). For action="symbol_search": max hits (default 25). For action="symbol_context": max callers and max callees (default 25 each). For action="impact_cone": max cone entries (default 50). For action="diff_context": max changed symbols per file and max impacted files (default 25). For action="graph_explain": max reasons (default 20). For action="route_trace": max routes and per-list section size (default 25). For action="data_trace": max readers/writers/deleters/configurers/tests entries (default 25). For action="test_pack": max tests, fixtures, and helpers (default 25; uncovered-export hints use a per-target cap of 20).',
			),
		max_depth: z
			.number()
			.int()
			.min(1)
			.max(10)
			.optional()
			.describe(
				'For action="blast_radius": max BFS depth (default 3). For action="context_pack": traversal depth (default 2). For action="impact_cone": symbol/file traversal depth (default 3). For action="diff_context": impact traversal depth (default 2).',
			),
		question: z
			.string()
			.optional()
			.describe(
				'Natural-language question for action="ask" or action="retrieve". Ask is orientation only; retrieve deterministically selects and explains a bounded strategy.',
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
		kind: z
			.enum([
				'function',
				'class',
				'const',
				'type',
				'interface',
				'enum',
				'method',
			])
			.optional()
			.describe(
				'For action="symbol_search": declaration-kind filter. Requires a graph built at schema 1.6.0+; older graphs return a degradation warning instead of failing.',
			),
		visibility: z
			.enum(['exported', 'module-local'])
			.optional()
			.describe(
				'For action="symbol_search": filter by visibility tier — "exported" (public module surface) or "module-local" (widened-grammar member defs only present in exportRanges).',
			),
		language: z
			.string()
			.max(64)
			.optional()
			.describe(
				'For action="symbol_search": filter by node language (e.g. "typescript", "python").',
			),
		diff: z
			.string()
			.max(50_000)
			.optional()
			.describe(
				'For action="diff_context": unified diff text. File paths are parsed from +++ b/<path> headers and @@ hunks; hunk new-side line ranges map to changed symbols. Control characters other than newlines/tabs are rejected.',
			),
		line: z
			.number()
			.int()
			.min(1)
			.optional()
			.describe(
				'For action="graph_explain": 1-based line in the target file; resolves to the enclosing symbol (smallest containing span wins) before explaining.',
			),
		route_path: z
			.string()
			.max(500)
			.optional()
			.describe(
				'For action="route_trace": route path to match, e.g. "/api/users" or "/api/users/[id]" (dynamic segments normalize to :param / :param*). Requires a leading slash; combined with the optional method filter.',
			),
		method: z
			.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'ALL'])
			.optional()
			.describe(
				'For action="route_trace": filter matched routes by HTTP method (routes stored as ALL match any filter).',
			),
		entity: z
			.string()
			.max(256)
			.optional()
			.describe(
				'For action="data_trace": entity/table name, config/env key, or Prisma-style model name to trace readers/writers/deleters for (e.g. "user", "API_BASE_URL").',
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
		if (action === 'retrieve') {
			if (!a.question) return err(action, 'retrieve requires `question`');
			const questionError = validateQuestion(a.question);
			if (questionError) return err(action, questionError);
			if (a.file !== undefined) {
				const fileError = validateFile(a.file);
				if (fileError) return err(action, fileError);
			}
			for (const file of a.files ?? []) {
				const fileError = validateFile(file);
				if (fileError) return err(action, `files entry: ${fileError}`);
			}
			if (a.symbol !== undefined) {
				const symbolError = validateSymbol(a.symbol);
				if (symbolError) return err(action, symbolError);
			}
			if (a.route_path !== undefined) {
				const routeError = validateRoutePath(a.route_path);
				if (routeError) return err(action, routeError);
			}
			if (a.method !== undefined) {
				const methodError = validateMethod(a.method);
				if (methodError) return err(action, methodError);
			}
			if (a.entity !== undefined) {
				const entityError = validateEntity(a.entity);
				if (entityError) return err(action, entityError);
			}
			if (a.diff !== undefined) {
				const diffError = validateDiffText(a.diff);
				if (diffError) return err(action, diffError);
			}
			const hasRouteHint = a.route_path !== undefined || a.method !== undefined;
			const hasFiles = a.files !== undefined && a.files.length > 0;
			if (
				a.method !== undefined &&
				a.route_path === undefined &&
				a.file === undefined &&
				a.symbol === undefined
			) {
				return err(action, 'method requires route_path, file, or symbol');
			}
			if (
				a.entity !== undefined &&
				(hasRouteHint ||
					a.file !== undefined ||
					hasFiles ||
					a.symbol !== undefined ||
					a.diff !== undefined)
			) {
				return err(
					action,
					'entity cannot be combined with route or code-scope hints',
				);
			}
			if (hasRouteHint && (hasFiles || a.diff !== undefined)) {
				return err(action, 'route hints cannot be combined with files or diff');
			}
			const routedFile =
				a.file !== undefined
					? toRelativeGraphPath(a.file, directory)
					: undefined;
			const routedFiles =
				a.files !== undefined && a.files.length > 0
					? a.files.map((file) => toRelativeGraphPath(file, directory))
					: undefined;
			let graph: RepoGraph | null = null;
			let unavailable: string | undefined;
			let retrievalFreshness: RepoMapFreshnessMetadata | undefined;
			if (!repoGraphConfig.enabled) unavailable = 'graph_disabled';
			else {
				const prepared = await prepareGraphQuery(
					directory,
					action,
					repoGraphConfig,
				);
				if (prepared.ok) {
					graph = prepared.graph;
					retrievalFreshness = prepared.freshness;
				} else {
					unavailable = prepared.response.includes('No repo graph')
						? 'graph_missing'
						: 'graph_load_error';
				}
			}
			const result = await routeRetrieval(
				graph,
				{
					question: a.question,
					file: routedFile,
					files: routedFiles,
					symbol: a.symbol,
					diff: a.diff,
					entity: a.entity,
					routePath: a.route_path,
					method: a.method,
					maxTokens: a.max_tokens,
					topN: a.top_n,
				},
				async ({ query, files }) => {
					const searchResult = await searchWorkspaceLiteral({
						query,
						mode: 'literal',
						include: files?.join(','),
						maxResults: Math.min(a.top_n ?? 25, 100),
						maxLines: 200,
						workspace: directory,
					});
					return searchResult;
				},
				unavailable,
			);
			try {
				const sessionID = _ctx?.sessionID?.trim();
				if (sessionID) {
					_internals.telemetry.retrievalRouted(sessionID, {
						mode: result.mode,
						graph_hit: result.graphHit,
						fallback_reason: result.fallbackReason,
						token_budget_requested: result.budget.requestedTokens,
						token_budget_used: result.budget.usedTokens,
						omitted_context_count: result.budget.omittedContextCount,
					});
				}
			} catch {
				// Telemetry is diagnostic and must never make retrieval fail.
			}
			return ok(action, { ...result, ...(retrievalFreshness ?? {}) });
		}
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

		// All other actions share the same load/probe/refresh lifecycle as retrieve.
		const prepared = await prepareGraphQuery(
			directory,
			action,
			repoGraphConfig,
		);
		if (!prepared.ok) return prepared.response;
		const { graph, freshness } = prepared;

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

		if (action === 'symbol_search') {
			if (a.symbol === undefined) {
				return err(action, 'symbol_search requires `symbol` (the search term)');
			}
			const sErr = validateSymbol(a.symbol);
			if (sErr) return err(action, `invalid symbol: ${sErr}`);
			if (a.language !== undefined) {
				const lErr = validateLanguage(a.language);
				if (lErr) return err(action, `invalid language: ${lErr}`);
			}
			let fileTarget: string | undefined;
			if (a.file !== undefined) {
				const fErr = validateFile(a.file);
				if (fErr) return err(action, `invalid file: ${fErr}`);
				fileTarget = toRelativeGraphPath(a.file, directory);
			}
			try {
				const result = searchSymbols(graph, {
					query: a.symbol,
					...(a.kind !== undefined ? { kind: a.kind } : {}),
					...(a.visibility !== undefined ? { visibility: a.visibility } : {}),
					...(a.language !== undefined ? { language: a.language } : {}),
					...(fileTarget !== undefined ? { file: fileTarget } : {}),
					...(a.top_n !== undefined ? { topN: a.top_n } : {}),
				});
				return ok(action, { ...result, ...freshness });
			} catch (e) {
				return err(action, failureMessage(e));
			}
		}

		if (action === 'symbol_context') {
			if (
				a.symbol_id === undefined &&
				(a.file === undefined || a.symbol === undefined)
			) {
				return err(
					action,
					'symbol_context requires `symbol_id`, or `file` + `symbol`',
				);
			}
			if (a.symbol_id !== undefined) {
				const idErr = validateSymbolId(a.symbol_id);
				if (idErr) return err(action, `invalid symbol_id: ${idErr}`);
			}
			let fileTarget: string | undefined;
			if (a.file !== undefined) {
				const fErr = validateFile(a.file);
				if (fErr) return err(action, `invalid file: ${fErr}`);
				fileTarget = toRelativeGraphPath(a.file, directory);
			}
			if (a.symbol !== undefined) {
				const sErr = validateSymbol(a.symbol);
				if (sErr) return err(action, `invalid symbol: ${sErr}`);
			}
			try {
				const result = getSymbolContext(graph, {
					...(fileTarget !== undefined ? { file: fileTarget } : {}),
					...(a.symbol !== undefined ? { symbol: a.symbol } : {}),
					...(a.symbol_id !== undefined ? { symbolId: a.symbol_id } : {}),
					...(a.include_source !== undefined
						? { includeSource: a.include_source }
						: {}),
					...(a.top_n !== undefined ? { topN: a.top_n } : {}),
				});
				return ok(action, { ...result, ...freshness });
			} catch (e) {
				return err(action, failureMessage(e));
			}
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

		if (action === 'diff_context') {
			if (
				(a.files === undefined || a.files.length === 0) &&
				a.diff === undefined
			) {
				return err(
					action,
					'diff_context requires `files` (non-empty) or `diff`',
				);
			}
			if (a.diff !== undefined) {
				const dErr = validateDiffText(a.diff);
				if (dErr) return err(action, `invalid diff: ${dErr}`);
			}
			let fileTargets: string[] | undefined;
			if (a.files !== undefined && a.files.length > 0) {
				fileTargets = [];
				for (const f of a.files) {
					const v = validateFile(f);
					if (v) return err(action, `invalid file: ${v}`);
					fileTargets.push(toRelativeGraphPath(f, directory));
				}
			}
			try {
				const result = getDiffContext(graph, {
					...(fileTargets !== undefined ? { files: fileTargets } : {}),
					...(a.diff !== undefined ? { diff: a.diff } : {}),
					maxDepth: a.max_depth ?? 2,
					topN: a.top_n ?? 25,
				});
				return ok(action, { ...result, ...freshness });
			} catch (e) {
				return err(action, failureMessage(e));
			}
		}

		if (action === 'route_trace') {
			if (
				a.route_path === undefined &&
				a.file === undefined &&
				a.symbol === undefined
			) {
				return err(
					action,
					'route_trace requires `route_path`, `file`, or `symbol`',
				);
			}
			if (a.route_path !== undefined) {
				const rpErr = validateRoutePath(a.route_path);
				if (rpErr) return err(action, `invalid route_path: ${rpErr}`);
			}
			if (a.method !== undefined) {
				const mErr = validateMethod(a.method);
				if (mErr) return err(action, `invalid method: ${mErr}`);
			}
			if (a.symbol !== undefined) {
				const sErr = validateSymbol(a.symbol);
				if (sErr) return err(action, `invalid symbol: ${sErr}`);
			}
			let fileTarget: string | undefined;
			if (a.file !== undefined) {
				const fErr = validateFile(a.file);
				if (fErr) return err(action, `invalid file: ${fErr}`);
				fileTarget = toRelativeGraphPath(a.file, directory);
			}
			try {
				const result = traceRoute(graph, {
					...(a.route_path !== undefined ? { routePath: a.route_path } : {}),
					...(a.method !== undefined ? { method: a.method } : {}),
					...(fileTarget !== undefined ? { file: fileTarget } : {}),
					...(a.symbol !== undefined ? { symbol: a.symbol } : {}),
					...(a.top_n !== undefined ? { topN: a.top_n } : {}),
				});
				return ok(action, { ...result, ...freshness });
			} catch (e) {
				return err(action, failureMessage(e));
			}
		}

		if (action === 'data_trace') {
			if (
				a.entity === undefined &&
				a.file === undefined &&
				a.symbol === undefined
			) {
				return err(action, 'data_trace requires `entity`, `file`, or `symbol`');
			}
			if (a.entity !== undefined) {
				const eErr = validateEntity(a.entity);
				if (eErr) return err(action, `invalid entity: ${eErr}`);
			}
			if (a.symbol !== undefined) {
				const sErr = validateSymbol(a.symbol);
				if (sErr) return err(action, `invalid symbol: ${sErr}`);
			}
			let fileTarget: string | undefined;
			if (a.file !== undefined) {
				const fErr = validateFile(a.file);
				if (fErr) return err(action, `invalid file: ${fErr}`);
				fileTarget = toRelativeGraphPath(a.file, directory);
			}
			try {
				const result = traceData(graph, {
					...(a.entity !== undefined ? { entity: a.entity } : {}),
					...(fileTarget !== undefined ? { file: fileTarget } : {}),
					...(a.symbol !== undefined ? { symbol: a.symbol } : {}),
					...(a.top_n !== undefined ? { topN: a.top_n } : {}),
				});
				return ok(action, { ...result, ...freshness });
			} catch (e) {
				return err(action, failureMessage(e));
			}
		}

		if (action === 'test_pack') {
			const inputFiles =
				a.files && a.files.length > 0 ? a.files : a.file ? [a.file] : [];
			if (
				inputFiles.length === 0 &&
				a.symbol === undefined &&
				a.diff === undefined
			) {
				return err(
					action,
					'test_pack requires `file`, `files`, `symbol`, or `diff`',
				);
			}
			let fileTargets: string[] | undefined;
			if (inputFiles.length > 0) {
				fileTargets = [];
				for (const f of inputFiles) {
					const v = validateFile(f);
					if (v) return err(action, `invalid file: ${v}`);
					fileTargets.push(toRelativeGraphPath(f, directory));
				}
			}
			if (a.symbol !== undefined) {
				const sErr = validateSymbol(a.symbol);
				if (sErr) return err(action, `invalid symbol: ${sErr}`);
			}
			if (a.diff !== undefined) {
				const dErr = validateDiffText(a.diff);
				if (dErr) return err(action, `invalid diff: ${dErr}`);
			}
			try {
				const result = buildTestPack(graph, {
					...(fileTargets !== undefined ? { files: fileTargets } : {}),
					...(a.symbol !== undefined ? { symbol: a.symbol } : {}),
					...(a.diff !== undefined ? { diff: a.diff } : {}),
					...(a.top_n !== undefined ? { topN: a.top_n } : {}),
				});
				return ok(action, { ...result, ...freshness });
			} catch (e) {
				return err(action, failureMessage(e));
			}
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
			if (
				freshness.freshnessNote &&
				!warnings.includes(freshness.freshnessNote)
			) {
				warnings.push(freshness.freshnessNote);
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

		if (action === 'impact_cone') {
			if (a.symbol !== undefined) {
				const sErr = validateSymbol(a.symbol);
				if (sErr) return err(action, `invalid symbol: ${sErr}`);
			}
			try {
				const result = getImpactCone(graph, {
					file: target,
					...(a.symbol !== undefined ? { symbol: a.symbol } : {}),
					maxDepth: a.max_depth ?? 3,
					topN: a.top_n ?? 50,
				});
				return ok(action, { ...result, ...freshness });
			} catch (e) {
				return err(action, failureMessage(e));
			}
		}

		if (action === 'graph_explain') {
			if (a.symbol !== undefined) {
				const sErr = validateSymbol(a.symbol);
				if (sErr) return err(action, `invalid symbol: ${sErr}`);
			}
			try {
				const result = explainGraphEntry(graph, {
					file: target,
					...(a.symbol !== undefined ? { symbol: a.symbol } : {}),
					...(a.line !== undefined ? { line: a.line } : {}),
					...(a.top_n !== undefined ? { topN: a.top_n } : {}),
				});
				return ok(action, { ...result, ...freshness });
			} catch (e) {
				return err(action, failureMessage(e));
			}
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
