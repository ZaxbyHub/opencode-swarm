/**
 * Workspace scanning and graph construction.
 *
 * Provides both synchronous (buildWorkspaceGraph) and async
 * (buildWorkspaceGraphAsync) builders that walk the file tree, extract
 * symbols, and produce a complete RepoGraph. The async variant yields
 * to the event loop between batches so the plugin host can continue
 * processing while a large workspace is scanned.
 *
 * Also exports upsertNode, addEdge, and resolveModuleSpecifier which are
 * used by both the builder and the incremental updater.
 */

import * as fsSync from 'node:fs';
import { existsSync, realpathSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as logger from '../../utils/logger';
import { containsControlChars } from '../../utils/path-security';
import { yieldToEventLoop } from '../../utils/timeout';
import { extractPythonSymbols, extractTSSymbols } from '../symbols';
import { safeRealpathSync } from './safe-realpath';
import type {
	BuildWorkspaceGraphOptions,
	GraphEdge,
	GraphNode,
	RepoGraph,
} from './types';
import {
	createEmptyGraph,
	normalizeGraphPath,
	updateGraphMetadata,
} from './types';
import {
	validateGraphEdge,
	validateGraphNode,
	validateWorkspace,
} from './validation';

/**
 * _internals DI seam for safeRealpathSync.
 * Defaults to the real implementation. Tests can override this to inject
 * mock behavior without calling mock.module(...) which leaks across test files
 * in Bun's shared test-runner process.
 */
export const _internals: {
	safeRealpathSync: typeof safeRealpathSync;
	extractTSSymbols: typeof extractTSSymbols;
	extractPythonSymbols: typeof extractPythonSymbols;
	parseFileImports: typeof parseFileImports;
} = {
	safeRealpathSync,
	extractTSSymbols,
	extractPythonSymbols,
	parseFileImports,
} as const;

// ============ Constants ============

/**
 * Directories to skip during workspace scanning (build artifacts, package managers, etc.).
 */
const SKIP_DIRECTORIES = new Set([
	'node_modules',
	'.git',
	'dist',
	'build',
	'out',
	'coverage',
	'.next',
	'.nuxt',
	'.cache',
	'vendor',
	'.svn',
	'.hg',
]);

/**
 * Supported source file extensions for graph scanning.
 */
const SUPPORTED_EXTENSIONS = [
	'.ts',
	'.tsx',
	'.js',
	'.jsx',
	'.mjs',
	'.cjs',
	'.py',
];

/**
 * Default safety budgets for workspace traversal.
 */
const DEFAULT_WALK_FILE_CAP = 10000;
const DEFAULT_WALK_BUDGET_MS = 5000;
const ASYNC_WALK_YIELD_INTERVAL = 200;

/**
 * Mapping of file extensions to language identifiers.
 */
const EXTENSION_TO_LANGUAGE: Record<string, string> = {
	'.ts': 'typescript',
	'.tsx': 'typescript',
	'.js': 'javascript',
	'.jsx': 'javascript',
	'.mjs': 'javascript',
	'.cjs': 'javascript',
	'.py': 'python',
};

// ============ Graph Node / Edge Operations ============

/**
 * Add or update a node in the graph.
 * @param graph - The graph to modify
 * @param node - The node to add/update
 */
export function upsertNode(graph: RepoGraph, node: GraphNode): void {
	validateGraphNode(node);
	const key = normalizeGraphPath(node.filePath);
	graph.nodes[key] = node;
	updateGraphMetadata(graph);
}

/**
 * Add an edge to the graph.
 * @param graph - The graph to modify
 * @param edge - The edge to add
 */
export function addEdge(graph: RepoGraph, edge: GraphEdge): void {
	validateGraphEdge(edge);
	// Avoid duplicates
	const exists = graph.edges.some(
		(e) =>
			e.source === edge.source &&
			e.target === edge.target &&
			e.importSpecifier === edge.importSpecifier,
	);
	if (!exists) {
		graph.edges.push(edge);
		updateGraphMetadata(graph);
	}
}

// ============ Path Resolution ============

/**
 * Resolve a module specifier relative to a source file within a workspace.
 *
 * CONTRACT for bare specifiers:
 * - Bare specifiers (e.g., 'lodash', 'zod', '@scope/pkg') return null because
 *   they require node_modules traversal to resolve, which is outside the scope
 *   of this module's responsibilities.
 * - Callers should treat null as "unresolvable at graph-build time" and may
 *   defer resolution to runtime or external tools.
 *
 * CONTRACT for workspace format:
 * - workspaceRoot is normally a relative path (e.g., "my-project") validated by
 *   validateWorkspace, but when called by buildWorkspaceGraph it may be an
 *   absolute scan root path. Both forms are accepted - the function handles
 *   path boundary checks consistently regardless of which form is provided.
 * - sourceFile must be an absolute path
 * - Returns absolute path if resolved, null otherwise
 *
 * @param workspaceRoot - The workspace root directory (relative or absolute path)
 * @param sourceFile - The file containing the import (absolute path)
 * @param specifier - The module specifier from the import statement
 * @returns Resolved absolute path or null if unresolvable
 */
export function resolveModuleSpecifier(
	workspaceRoot: string,
	sourceFile: string,
	specifier: string,
): string | null {
	// Reject control characters
	if (containsControlChars(specifier)) {
		return null;
	}

	// Reject absolute paths and URLs
	if (specifier.startsWith('/') || specifier.startsWith('\\')) {
		return null;
	}
	if (/^[A-Za-z]:[/\\]/.test(specifier)) {
		return null;
	}
	if (specifier.startsWith('http://') || specifier.startsWith('https://')) {
		return null;
	}

	try {
		// Resolve relative to source file
		if (specifier.startsWith('.')) {
			const sourceDir = path.dirname(sourceFile);
			let resolved = path.resolve(sourceDir, specifier);

			// SECURITY: Resolve symlinks to get the real path, then verify the
			// real path is still within the workspace boundary. This prevents
			// symlink-based workspace escape attacks.
			const initialRealResolved = _internals.safeRealpathSync(
				resolved,
				resolved,
			);
			if (initialRealResolved === null) {
				return null;
			}
			let realResolved = initialRealResolved;

			// Get the realpath of the workspace root to compare consistently
			const realRoot = _internals.safeRealpathSync(
				workspaceRoot,
				path.normalize(workspaceRoot),
			);
			if (realRoot === null) {
				return null;
			}

			// Try to resolve the extensionless path to a real file.
			// TypeScript/JavaScript imports commonly omit extensions: import { foo } from './utils'
			// We need to find the actual file: ./utils.ts, ./utils.js, etc.
			if (!existsSync(resolved)) {
				const EXTENSIONS = [
					'.ts',
					'.tsx',
					'.js',
					'.jsx',
					'.mjs',
					'.cjs',
					'.py',
					'.json',
				];
				let found: string | null = null;
				for (const ext of EXTENSIONS) {
					const candidate = resolved + ext;
					if (existsSync(candidate)) {
						found = candidate;
						break;
					}
				}
				if (found) {
					// Re-resolve symlinks for the found file
					const foundRealPath = _internals.safeRealpathSync(found, found);
					if (foundRealPath === null) {
						return null;
					}
					realResolved = foundRealPath;
					// Update resolved to the found path so the return value has the extension
					resolved = found;
				} else {
					// No matching file found — this import doesn't resolve to a workspace file
					return null;
				}
			}

			// Normalize for consistent comparison (computed AFTER extension resolution)
			const normalizedResolved = path.normalize(realResolved);
			const normalizedRoot = path.normalize(realRoot);

			// Ensure result is within workspace using real path boundaries
			if (
				!normalizedResolved.startsWith(normalizedRoot + path.sep) &&
				normalizedResolved !== normalizedRoot
			) {
				return null;
			}
			return resolved;
		}

		// Bare specifiers (e.g., 'lodash', '@scope/pkg') cannot be resolved
		// without node_modules traversal - return null per contract above
		return null;
	} catch {
		return null;
	}
}

// ============ Workspace Scan Builder ============

/**
 * Resolves to true when `target` is one of the well-known top-level paths we
 * refuse to scan as a workspace root. Returning true here is the regression
 * guard against the issue #704 failure mode where Desktop launches the
 * sidecar with `ctx.directory = $HOME` (or similar), which would otherwise
 * trigger a multi-minute or infinite recursive scan.
 *
 * The check uses real-paths so a symlink that resolves to `$HOME` is treated
 * the same as `$HOME` itself.
 */
function isRefusedWorkspaceRoot(target: string): boolean {
	let resolved: string;
	try {
		resolved = realpathSync(target);
	} catch {
		// If realpath fails, fall back to path.resolve. Not finding the path is
		// already handled upstream — here we only care about the refusal check.
		resolved = path.resolve(target);
	}
	const refused = new Set<string>();
	const add = (p: string | undefined) => {
		if (typeof p === 'string' && p.length > 0) {
			refused.add(path.resolve(p));
		}
	};
	add(os.homedir());
	add(os.tmpdir());
	add('/');
	add('/Users');
	add('/home');
	add('/root');
	if (process.platform === 'win32') {
		add('C:\\');
		add('C:\\Users');
	}
	return refused.has(resolved);
}

/**
 * Statistics collected during workspace scan.
 */
interface ScanStats {
	/** Total files scanned */
	filesScanned: number;
	/** Directories skipped */
	skippedDirs: number;
	/** Files skipped due to size/binary/errors */
	skippedFiles: number;
	/** True if maxFiles limit was hit */
	truncated: boolean;
}

/**
 * A parsed import with its specifier and type.
 */
interface ParsedImport {
	/** The module specifier (e.g., './foo', 'lodash') */
	specifier: string;
	/** The type of import */
	importType: 'default' | 'named' | 'namespace' | 'require' | 'sideeffect';
}

/**
 * Parse imports from file content using the same rules as imports.ts.
 * Handles ES module imports and CommonJS require() statements.
 *
 * @param content - File content to parse
 * @returns Array of parsed imports with specifier and type
 */
function parseFileImports(content: string): ParsedImport[] {
	const imports: ParsedImport[] = [];

	// Combined regex matching:
	// - import { x } from '...' or import { x as y } from '...'
	// - import x from '...' (default import)
	// - import * as x from '...' (namespace import)
	// - import '...' (side-effect only)
	// - import('...') (dynamic import)
	// - require('...')
	// - export { x } from '...' (named re-export)
	// - export * from '...' (namespace re-export)
	const importRegex =
		/import\s+(?:\{[\s\S]*?\}|(?:\*\s+as\s+\w+)|\w+)\s+from\s+['"`]([^'"`\0\t\r\n]+)['"`]|import\s+['"`]([^'"`\0\t\r\n]+)['"`]|require\s*\(\s*['"`]([^'"`\0\t\r\n]+)['"`]\s*\)|export\s*\{[^}]*\}\s*from\s+['"`]([^'"`\0\t\r\n]+)['"`]|export\s+\*(?:\s+as\s+\w+)?\s+from\s+['"`]([^'"`\0\t\r\n]+)['"`]|import\s*\(\s*['"`]([^'"`\0\t\r\n]+)['"`]\s*\)/g;

	for (const match of content.matchAll(importRegex)) {
		// Extract the module path from whichever capture group matched
		const modulePath =
			match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
		if (!modulePath) continue;
		// Belt-and-suspenders: drop any specifier that still contains control chars
		if (containsControlChars(modulePath)) continue;

		// Get the matched string for type detection
		const matchedString = match[0];

		// Determine import type - mirrors imports.ts classification logic
		let importType: ParsedImport['importType'] = 'named';
		if (matchedString.includes('* as')) {
			importType = 'namespace';
		} else if (/^import\s*\(/.test(matchedString)) {
			// Dynamic import: import('...')
			importType = 'sideeffect';
		} else if (/^export\s*\{/.test(matchedString)) {
			// Named re-export: export { Foo } from '...'
			importType = 'named';
		} else if (/^export\s+\*/.test(matchedString)) {
			// Namespace re-export: export * from '...'
			importType = 'namespace';
		} else if (/^import\s+\{/.test(matchedString)) {
			// Named import: import { Foo } from '...'
			importType = 'named';
		} else if (/^import\s+\w+\s+from\s+['"`]/.test(matchedString)) {
			// Default import: import foo from '...'
			importType = 'default';
		} else if (/^import\s+['"`]/m.test(matchedString)) {
			// Side-effect import: import '...' (no from with specifier)
			importType = 'sideeffect';
		} else if (matchedString.includes('require(')) {
			importType = 'require';
		}

		imports.push({ specifier: modulePath, importType });
	}

	return imports;
}

/**
 * Walk context shared between the sync and async traversals.
 *
 * `seenRealPaths` deduplicates by canonical path to break symlink cycles —
 * required because the previous implementation followed symlinks via
 * `statSync` with no visited-set, causing infinite recursion on macOS
 * iCloud / FileVault layouts, Linux FUSE mounts, and Windows junctions
 * (issue #704). The set is keyed by the realpath of every directory we
 * recurse into; if we ever revisit one, we bail.
 *
 * `startedAt` and `walkBudgetMs` cap wall-clock so a slow filesystem
 * (network share, NFS) cannot stall init forever. `maxFiles` short-circuits
 * the walk *during* traversal — the previous code post-truncated the result
 * array, which did nothing to bound walk time.
 */
interface WalkContext {
	stats: ScanStats;
	seenRealPaths: Set<string>;
	startedAt: number;
	walkBudgetMs: number;
	maxFiles: number;
	followSymlinks: boolean;
	abortReason?: 'budget' | 'cap';
}

function isWalkBudgetExceeded(ctx: WalkContext): boolean {
	if (ctx.abortReason !== undefined) return true;
	if (Date.now() - ctx.startedAt > ctx.walkBudgetMs) {
		ctx.abortReason = 'budget';
		return true;
	}
	return false;
}

function isFileCapReached(ctx: WalkContext, filesLength: number): boolean {
	if (filesLength >= ctx.maxFiles) {
		ctx.abortReason = 'cap';
		return true;
	}
	return false;
}

function canonicalDirKey(dir: string): string | null {
	try {
		return realpathSync(dir);
	} catch {
		return null;
	}
}

async function canonicalDirKeyAsync(dir: string): Promise<string | null> {
	try {
		return await fsPromises.realpath(dir);
	} catch {
		return null;
	}
}

function findSourceFiles(
	dir: string,
	stats: ScanStats,
	options?: {
		walkBudgetMs?: number;
		maxFiles?: number;
		followSymlinks?: boolean;
	},
): string[] {
	const ctx: WalkContext = {
		stats,
		seenRealPaths: new Set<string>(),
		startedAt: Date.now(),
		walkBudgetMs: options?.walkBudgetMs ?? DEFAULT_WALK_BUDGET_MS,
		maxFiles: options?.maxFiles ?? DEFAULT_WALK_FILE_CAP,
		followSymlinks: options?.followSymlinks ?? false,
	};
	const files: string[] = [];
	walkSyncInto(dir, ctx, files);
	if (ctx.abortReason === 'cap' || ctx.abortReason === 'budget') {
		stats.truncated = true;
	}
	return files;
}

function walkSyncInto(dir: string, ctx: WalkContext, files: string[]): void {
	if (isWalkBudgetExceeded(ctx) || isFileCapReached(ctx, files.length)) {
		return;
	}

	const key = canonicalDirKey(dir);
	if (key !== null) {
		if (ctx.seenRealPaths.has(key)) {
			ctx.stats.skippedDirs++;
			return;
		}
		ctx.seenRealPaths.add(key);
	}

	let entries: fsSync.Dirent[];
	try {
		entries = fsSync.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}

	// Deterministic order, case-insensitive — preserves prior behavior.
	entries.sort((a, b) =>
		a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
	);

	for (const entry of entries) {
		if (isWalkBudgetExceeded(ctx) || isFileCapReached(ctx, files.length)) {
			return;
		}
		if (SKIP_DIRECTORIES.has(entry.name)) {
			ctx.stats.skippedDirs++;
			continue;
		}
		const fullPath = path.join(dir, entry.name);

		// Symlinks are skipped by default. This excludes pnpm `.pnpm/` link
		// trees (already excluded via node_modules) and prevents cycle traps
		// on macOS/Windows. Set `followSymlinks: true` to opt in to the
		// previous (unsafe) behavior for monorepo-style symlink layouts.
		if (entry.isSymbolicLink() && !ctx.followSymlinks) {
			ctx.stats.skippedDirs++;
			continue;
		}

		if (entry.isDirectory()) {
			walkSyncInto(fullPath, ctx, files);
		} else if (entry.isFile()) {
			const ext = path.extname(fullPath).toLowerCase();
			if (SUPPORTED_EXTENSIONS.includes(ext)) {
				files.push(fullPath);
			}
		}
	}
}

/**
 * Async, chunked, cycle-safe equivalent of `findSourceFiles`.
 *
 * Yields to the event loop every `ASYNC_WALK_YIELD_INTERVAL` entries so the
 * Node/Bun macrotask queue continues to drain while the walk runs. This is
 * the variant called from the plugin init path; the sync variant remains
 * available for non-init callers (tools, tests) for compatibility.
 */
async function findSourceFilesAsync(
	dir: string,
	stats: ScanStats,
	options?: {
		walkBudgetMs?: number;
		maxFiles?: number;
		followSymlinks?: boolean;
	},
): Promise<string[]> {
	const ctx: WalkContext = {
		stats,
		seenRealPaths: new Set<string>(),
		startedAt: Date.now(),
		walkBudgetMs: options?.walkBudgetMs ?? DEFAULT_WALK_BUDGET_MS,
		maxFiles: options?.maxFiles ?? DEFAULT_WALK_FILE_CAP,
		followSymlinks: options?.followSymlinks ?? false,
	};
	const files: string[] = [];
	const queue: string[] = [dir];
	let processed = 0;
	while (queue.length > 0) {
		if (isWalkBudgetExceeded(ctx) || isFileCapReached(ctx, files.length)) {
			break;
		}
		const current = queue.shift() as string;
		const key = await canonicalDirKeyAsync(current);
		if (key !== null) {
			if (ctx.seenRealPaths.has(key)) {
				ctx.stats.skippedDirs++;
				continue;
			}
			ctx.seenRealPaths.add(key);
		}

		let entries: fsSync.Dirent[];
		try {
			entries = await fsPromises.readdir(current, { withFileTypes: true });
		} catch {
			continue;
		}
		entries.sort((a, b) =>
			a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
		);

		for (const entry of entries) {
			if (isWalkBudgetExceeded(ctx) || isFileCapReached(ctx, files.length)) {
				break;
			}
			if (SKIP_DIRECTORIES.has(entry.name)) {
				ctx.stats.skippedDirs++;
				continue;
			}
			const fullPath = path.join(current, entry.name);
			if (entry.isSymbolicLink() && !ctx.followSymlinks) {
				ctx.stats.skippedDirs++;
				continue;
			}
			if (entry.isDirectory()) {
				queue.push(fullPath);
			} else if (entry.isFile()) {
				const ext = path.extname(fullPath).toLowerCase();
				if (SUPPORTED_EXTENSIONS.includes(ext)) {
					files.push(fullPath);
				}
			}
			processed++;
			if (processed % ASYNC_WALK_YIELD_INTERVAL === 0) {
				await yieldToEventLoop();
			}
		}
	}
	if (ctx.abortReason === 'cap' || ctx.abortReason === 'budget') {
		ctx.stats.truncated = true;
	}
	return files;
}

/**
 * Normalize a file path to a module name relative to workspace root.
 * Uses forward slashes for cross-platform consistency.
 *
 * @param filePath - Absolute file path
 * @param workspaceRoot - Absolute path to workspace root
 * @returns Module name relative to workspace root
 */
function toModuleName(filePath: string, workspaceRoot: string): string {
	const relative = path.relative(workspaceRoot, filePath);
	// Normalize to forward slashes for cross-platform consistency
	return relative.split(path.sep).join('/');
}

/**
 * Get the language identifier for a file based on its extension.
 *
 * @param filePath - File path to get language for
 * @returns Language identifier string
 */
function getLanguage(filePath: string): string {
	const ext = path.extname(filePath).toLowerCase();
	return EXTENSION_TO_LANGUAGE[ext] ?? 'unknown';
}

/**
 * Check if file content appears to be binary.
 *
 * @param content - File content as string
 * @returns True if content appears binary
 */
function isBinaryContent(content: string): boolean {
	// Check for null bytes which indicate binary content
	if (content.includes('\0')) {
		return true;
	}
	return false;
}

// ============ Single-File Scanner ============

/**
 * Result of scanning a single file for graph updates.
 */
export interface ScanResult {
	/** The created node, or null if file was skipped */
	node: GraphNode | null;
	/** The edges created from this file's imports */
	edges: GraphEdge[];
}

/**
 * Scan a single file and extract its graph node and edges.
 * Reuses the same logic from buildWorkspaceGraph for consistency.
 *
 * @param filePath - Absolute path to the file to scan
 * @param absoluteRoot - Absolute path to workspace root
 * @param maxFileSize - Maximum file size in bytes
 * @returns ScanResult with node and edges
 */
export function scanFile(
	filePath: string,
	absoluteRoot: string,
	maxFileSize: number,
): ScanResult {
	let content: string;
	let fileStats: fsSync.Stats;

	try {
		fileStats = fsSync.statSync(filePath);
		if (fileStats.size > maxFileSize) {
			return { node: null, edges: [] };
		}
		content = fsSync.readFileSync(filePath, 'utf-8');
	} catch {
		return { node: null, edges: [] };
	}

	// Skip binary files
	if (isBinaryContent(content)) {
		return { node: null, edges: [] };
	}

	// Extract symbol exports based on file extension
	const ext = path.extname(filePath).toLowerCase();
	let exports: string[] = [];

	try {
		if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
			const relativePath = path.relative(absoluteRoot, filePath);
			const symbols = _internals.extractTSSymbols(relativePath, absoluteRoot);
			exports = symbols.filter((s) => s.exported).map((s) => s.name);
		} else if (ext === '.py') {
			const relativePath = path.relative(absoluteRoot, filePath);
			const symbols = _internals.extractPythonSymbols(
				relativePath,
				absoluteRoot,
			);
			exports = symbols.filter((s) => s.exported).map((s) => s.name);
		}

		// Parse imports to get specifiers with types
		const parsedImports = _internals.parseFileImports(content);

		// Create the graph node
		const node: GraphNode = {
			filePath,
			moduleName: toModuleName(filePath, absoluteRoot),
			exports,
			imports: parsedImports.map((p) => p.specifier),
			language: getLanguage(filePath),
			mtime: fileStats.mtime.toISOString(),
		};

		// Process imports to create edges
		const edges: GraphEdge[] = [];
		const sortedImports = [...parsedImports].sort((a, b) =>
			a.specifier.localeCompare(b.specifier),
		);

		for (const parsed of sortedImports) {
			const resolvedTarget = resolveModuleSpecifier(
				absoluteRoot,
				filePath,
				parsed.specifier,
			);

			if (resolvedTarget !== null) {
				edges.push({
					source: filePath,
					target: resolvedTarget,
					importSpecifier: parsed.specifier,
					importType: parsed.importType,
				});
			}
		}

		return { node, edges };
	} catch {
		// Skip malformed file without aborting incremental update
		return { node: null, edges: [] };
	}
}

// ============ Full Workspace Builders ============

/**
 * Build a complete dependency graph for a workspace by scanning all source files.
 *
 * The scan is deterministic: files are processed in sorted order, and edges
 * are added in a stable order based on source file and import specifier.
 *
 * @param workspaceRoot - Workspace root directory (absolute or relative path)
 * @param options - Optional scan configuration
 * @param options.maxFileSizeBytes - Maximum file size to scan (default 1MB)
 * @returns Complete RepoGraph with nodes and edges
 * @throws Error if workspace validation fails
 */
export function buildWorkspaceGraph(
	workspaceRoot: string,
	options?: BuildWorkspaceGraphOptions,
): RepoGraph {
	validateWorkspace(workspaceRoot);

	const maxFileSize = options?.maxFileSizeBytes ?? 1024 * 1024; // 1MB default
	const maxFiles = options?.maxFiles ?? DEFAULT_WALK_FILE_CAP;
	const walkBudgetMs = options?.walkBudgetMs ?? DEFAULT_WALK_BUDGET_MS;
	const followSymlinks = options?.followSymlinks ?? false;

	// Resolve workspace root to absolute path for scanning only
	const absoluteRoot = path.resolve(workspaceRoot);

	// Verify workspace directory exists before scanning
	if (!existsSync(absoluteRoot)) {
		throw new Error(`Workspace directory does not exist: ${workspaceRoot}`);
	}

	if (isRefusedWorkspaceRoot(absoluteRoot)) {
		throw new Error(
			`Refusing to scan top-level system path as workspace: ${absoluteRoot}. ` +
				`Set workspaceRoot to a project directory.`,
		);
	}

	// Create graph with original workspaceRoot form (not absolute path)
	const graph = createEmptyGraph(workspaceRoot);
	const stats: ScanStats = {
		filesScanned: 0,
		skippedDirs: 0,
		skippedFiles: 0,
		truncated: false,
	};

	const sourceFiles = findSourceFiles(absoluteRoot, stats, {
		walkBudgetMs,
		maxFiles,
		followSymlinks,
	});

	// Sort files for deterministic processing order
	sourceFiles.sort((a, b) => {
		const normA = normalizeGraphPath(a);
		const normB = normalizeGraphPath(b);
		return normA.localeCompare(normB);
	});

	if (stats.truncated) {
		logger.warn(
			`[repo-graph] Walk truncated: collected ${sourceFiles.length} files within ` +
				`${walkBudgetMs}ms / ${maxFiles}-file budget.`,
		);
	}

	// Process each file to extract nodes and edges
	for (const filePath of sourceFiles) {
		let content: string;
		let fileStats: fsSync.Stats;

		try {
			fileStats = fsSync.statSync(filePath);
			if (fileStats.size > maxFileSize) {
				stats.skippedFiles++;
				continue;
			}
			content = fsSync.readFileSync(filePath, 'utf-8');
		} catch {
			stats.skippedFiles++;
			continue;
		}

		// Skip binary files
		if (isBinaryContent(content)) {
			stats.skippedFiles++;
			continue;
		}

		stats.filesScanned++;

		// Extract symbol exports based on file extension
		const ext = path.extname(filePath).toLowerCase();
		let exports: string[] = [];
		let parsedImports: ParsedImport[] = [];

		try {
			if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
				const relativePath = path.relative(absoluteRoot, filePath);
				const symbols = _internals.extractTSSymbols(relativePath, absoluteRoot);
				exports = symbols.filter((s) => s.exported).map((s) => s.name);
			} else if (ext === '.py') {
				const relativePath = path.relative(absoluteRoot, filePath);
				const symbols = _internals.extractPythonSymbols(
					relativePath,
					absoluteRoot,
				);
				exports = symbols.filter((s) => s.exported).map((s) => s.name);
			}

			parsedImports = _internals.parseFileImports(content);
		} catch {
			// Skip malformed file without aborting entire graph build
			continue;
		}

		const node: GraphNode = {
			filePath,
			moduleName: toModuleName(filePath, absoluteRoot),
			exports,
			imports: parsedImports.map((p) => p.specifier),
			language: getLanguage(filePath),
			mtime: fileStats.mtime.toISOString(),
		};

		upsertNode(graph, node);

		// Sort imports deterministically by specifier for stable edge ordering
		const sortedImports = [...parsedImports].sort((a, b) =>
			a.specifier.localeCompare(b.specifier),
		);

		for (const parsed of sortedImports) {
			const resolvedTarget = resolveModuleSpecifier(
				absoluteRoot,
				filePath,
				parsed.specifier,
			);

			if (resolvedTarget !== null) {
				const edge: GraphEdge = {
					source: filePath,
					target: resolvedTarget,
					importSpecifier: parsed.specifier,
					importType: parsed.importType,
				};
				addEdge(graph, edge);
			}
		}
	}

	// Update final metadata with scan stats
	graph.metadata = {
		generatedAt: new Date().toISOString(),
		generator: 'repo-graph',
		nodeCount: Object.keys(graph.nodes).length,
		edgeCount: graph.edges.length,
	};

	if (stats.skippedFiles > 0 || stats.skippedDirs > 0 || stats.truncated) {
		logger.log(
			`[repo-graph] Scan stats: ${stats.filesScanned} files scanned, ` +
				`${stats.skippedFiles} files skipped, ${stats.skippedDirs} dirs skipped` +
				(stats.truncated ? ', TRUNCATED' : ''),
		);
	}

	return graph;
}

/**
 * Async, event-loop-safe variant of `buildWorkspaceGraph`. The traversal
 * yields between batches and uses async fs primitives, so callers can run
 * this from plugin init without freezing the host while a large workspace
 * is scanned. The per-file processing remains sync — it is CPU-bound symbol
 * extraction, and the existing per-file caps already prevent runaway work.
 *
 * Returned shape matches `buildWorkspaceGraph`. Same homedir guard, same
 * bounded walk behavior, same deterministic file order.
 */
export async function buildWorkspaceGraphAsync(
	workspaceRoot: string,
	options?: BuildWorkspaceGraphOptions,
): Promise<RepoGraph> {
	validateWorkspace(workspaceRoot);

	const maxFileSize = options?.maxFileSizeBytes ?? 1024 * 1024;
	const maxFiles = options?.maxFiles ?? DEFAULT_WALK_FILE_CAP;
	const walkBudgetMs = options?.walkBudgetMs ?? DEFAULT_WALK_BUDGET_MS;
	const followSymlinks = options?.followSymlinks ?? false;

	const absoluteRoot = path.resolve(workspaceRoot);
	if (!existsSync(absoluteRoot)) {
		throw new Error(`Workspace directory does not exist: ${workspaceRoot}`);
	}
	if (isRefusedWorkspaceRoot(absoluteRoot)) {
		throw new Error(
			`Refusing to scan top-level system path as workspace: ${absoluteRoot}. ` +
				`Set workspaceRoot to a project directory.`,
		);
	}

	const graph = createEmptyGraph(workspaceRoot);
	const stats: ScanStats = {
		filesScanned: 0,
		skippedDirs: 0,
		skippedFiles: 0,
		truncated: false,
	};

	const sourceFiles = await findSourceFilesAsync(absoluteRoot, stats, {
		walkBudgetMs,
		maxFiles,
		followSymlinks,
	});

	sourceFiles.sort((a, b) => {
		const normA = normalizeGraphPath(a);
		const normB = normalizeGraphPath(b);
		return normA.localeCompare(normB);
	});

	if (stats.truncated) {
		logger.warn(
			`[repo-graph] Walk truncated: collected ${sourceFiles.length} files within ` +
				`${walkBudgetMs}ms / ${maxFiles}-file budget.`,
		);
	}

	let processedSinceYield = 0;
	for (const filePath of sourceFiles) {
		const result = scanFile(filePath, absoluteRoot, maxFileSize);
		if (result.node) {
			upsertNode(graph, result.node);
			for (const edge of result.edges) {
				addEdge(graph, edge);
			}
			stats.filesScanned++;
		} else {
			stats.skippedFiles++;
		}
		processedSinceYield++;
		if (processedSinceYield % ASYNC_WALK_YIELD_INTERVAL === 0) {
			await yieldToEventLoop();
		}
	}

	graph.metadata = {
		generatedAt: new Date().toISOString(),
		generator: 'repo-graph',
		nodeCount: Object.keys(graph.nodes).length,
		edgeCount: graph.edges.length,
	};

	if (stats.skippedFiles > 0 || stats.skippedDirs > 0 || stats.truncated) {
		logger.log(
			`[repo-graph] Scan stats: ${stats.filesScanned} files scanned, ` +
				`${stats.skippedFiles} files skipped, ${stats.skippedDirs} dirs skipped` +
				(stats.truncated ? ', TRUNCATED' : ''),
		);
	}

	return graph;
}
