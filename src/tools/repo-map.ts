import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import { z } from 'zod';
import {
	buildAndSaveGraph,
	getBlastRadius,
	getDependencies,
	getImporters,
	getKeyFiles,
	getLocalizationContext,
	getSymbolConsumers,
	isGraphFresh,
	loadGraph,
	normalizeGraphPath,
	type RepoGraph,
} from '../graph';
import {
	containsControlChars,
	containsPathTraversal,
} from '../utils/path-security';
import { createSwarmTool } from './create-tool';

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
 * `.swarm/repo-graph.json`; if absent or stale, the caller is told to run
 * `action: "build"` first (we do not auto-rebuild — builds can take seconds
 * and should be explicit so the agent sees the cost).
 */

const VALID_ACTIONS = [
	'build',
	'importers',
	'dependencies',
	'blast_radius',
	'localization',
	'key_files',
] as const;

type RepoMapAction = (typeof VALID_ACTIONS)[number];

const MAX_FILE_PATH_LENGTH = 500;
const MAX_SYMBOL_LENGTH = 256;

interface RepoMapArgs {
	action: string;
	file?: string;
	files?: string[];
	symbol?: string;
	top_n?: number;
	max_depth?: number;
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

function err(action: string, message: string): string {
	return JSON.stringify({ success: false, action, error: message }, null, 2);
}

function ok(action: string, payload: Record<string, unknown>): string {
	return JSON.stringify({ success: true, action, ...payload }, null, 2);
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

function loadOrError(
	directory: string,
	action: string,
): { ok: true; graph: RepoGraph } | { ok: false; response: string } {
	const graph = loadGraph(directory);
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
}

export const repo_map: ReturnType<typeof createSwarmTool> = createSwarmTool({
	description:
		'Query the repository code graph for structural awareness before editing. ' +
		'Actions: "build" (build/refresh .swarm/repo-graph.json), "importers" (who imports a file), ' +
		'"dependencies" (what a file imports), "blast_radius" (transitive dependents + risk), ' +
		'"localization" (compact context block for a target file), "key_files" (top-N most-imported files). ' +
		'Use this before refactoring shared modules to avoid breaking unseen consumers.',
	args: {
		action: z
			.enum([
				'build',
				'importers',
				'dependencies',
				'blast_radius',
				'localization',
				'key_files',
			])
			.describe(
				'Query action: "build" | "importers" | "dependencies" | "blast_radius" | "localization" | "key_files"',
			),
		file: z
			.string()
			.optional()
			.describe(
				'Target file (workspace-relative or absolute). Required for importers/dependencies/localization.',
			),
		files: z
			.array(z.string())
			.optional()
			.describe(
				'Multiple target files for blast_radius. If omitted, falls back to `file`.',
			),
		symbol: z
			.string()
			.optional()
			.describe(
				'When provided alongside `file` on action="importers", restrict to consumers of this exported symbol.',
			),
		top_n: z
			.number()
			.int()
			.min(1)
			.max(100)
			.optional()
			.describe(
				'For action="key_files": number of files to return (default 10).',
			),
		max_depth: z
			.number()
			.int()
			.min(1)
			.max(10)
			.optional()
			.describe('For action="blast_radius": max BFS depth (default 3).'),
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

		// ----- build -----
		if (action === 'build') {
			try {
				const start = Date.now();
				const graph = await buildAndSaveGraph(directory);
				const elapsedMs = Date.now() - start;
				const fileCount = Object.keys(graph.files).length;
				let edgeCount = 0;
				for (const node of Object.values(graph.files)) {
					edgeCount += node.imports.length;
				}
				return ok(action, {
					fileCount,
					edgeCount,
					buildTimestamp: graph.buildTimestamp,
					elapsedMs,
					path: '.swarm/repo-graph.json',
				});
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				return err(action, `build failed: ${message}`);
			}
		}

		// All other actions need a loaded graph.
		const loaded = loadOrError(directory, action);
		if (!loaded.ok) return loaded.response;
		const graph = loaded.graph;
		const stale = !isGraphFresh(graph);

		// ----- key_files -----
		if (action === 'key_files') {
			const topN = a.top_n ?? 10;
			const nodes = getKeyFiles(graph, topN);
			const reverseCounts = nodes.map((n) => ({
				file: n.path,
				language: n.language,
				exports: n.exports.length,
				inDegree: getImporters(graph, n.path).length,
			}));
			return ok(action, {
				count: reverseCounts.length,
				files: reverseCounts,
				stale,
			});
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
			return ok(action, { ...result, stale });
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
					stale,
				});
			}
			const importers = getImporters(graph, target);
			return ok(action, {
				target,
				count: importers.length,
				importers,
				stale,
			});
		}

		if (action === 'dependencies') {
			const deps = getDependencies(graph, target);
			return ok(action, {
				target,
				count: deps.length,
				dependencies: deps,
				stale,
			});
		}

		if (action === 'localization') {
			const ctx = getLocalizationContext(graph, target, {
				maxDepth: a.max_depth,
			});
			return ok(action, { ...ctx, stale });
		}

		// Should be unreachable due to enum validation above.
		return err(action, 'unhandled action');
	},
});
