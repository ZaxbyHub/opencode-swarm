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
import { LANGUAGE_REGISTRY } from '../../lang/profiles';
import { extractFileSymbols } from '../../lang/symbol-graph';
import * as logger from '../../utils/logger';
import { containsControlChars } from '../../utils/path-security';
import { yieldToEventLoop } from '../../utils/timeout';
import {
	extractGoSymbols,
	extractPythonSymbols,
	extractRustSymbols,
	extractTSSymbols,
} from '../symbols';
import { extractFileOntology } from './ontology';
import { safeRealpathSync } from './safe-realpath';
import type {
	BuildWorkspaceGraphOptions,
	GraphEdge,
	GraphExtractorInputWitness,
	GraphNode,
	GraphUnresolvedImport,
	RepoGraph,
	RepoGraphDiagnostics,
	SymbolEdge,
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
 * _internals DI seam for the walk clock and graph helpers.
 * Defaults to the real implementations. Tests can override these to inject
 * deterministic behavior without calling mock.module(...) which leaks across
 * test files in Bun's shared test-runner process.
 */
export const _internals: {
	now: () => number;
	safeRealpathSync: typeof safeRealpathSync;
	extractTSSymbols: typeof extractTSSymbols;
	extractPythonSymbols: typeof extractPythonSymbols;
	extractRustSymbols: typeof extractRustSymbols;
	extractGoSymbols: typeof extractGoSymbols;
	parseFileImports: typeof parseFileImports;
	extractFileOntology: typeof extractFileOntology;
	stripComments: typeof stripComments;
	computeUsedSymbols: typeof computeUsedSymbols;
	extractFileSymbols: typeof extractFileSymbols;
} = {
	now: Date.now,
	safeRealpathSync,
	extractTSSymbols,
	extractPythonSymbols,
	extractRustSymbols,
	extractGoSymbols,
	parseFileImports,
	extractFileOntology,
	stripComments,
	computeUsedSymbols,
	extractFileSymbols,
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
	// SvelteKit build output (issue #1448): minified chunks here are generated
	// artifacts, never source, and previously crashed the graph build.
	'.svelte-kit',
]);

/**
 * Build the effective set of directory basenames to skip during a walk:
 * the built-in {@link SKIP_DIRECTORIES} defaults plus any caller-provided
 * `excludeDirs` (issue #1448). When no excludes are supplied, the shared
 * constant is returned directly to avoid a per-walk allocation.
 */
function resolveSkipDirectories(
	excludeDirs?: readonly string[],
): ReadonlySet<string> {
	const extras = excludeDirs?.filter((d) => d.length > 0) ?? [];
	if (extras.length === 0) return SKIP_DIRECTORIES;
	return new Set<string>([...SKIP_DIRECTORIES, ...extras]);
}

/**
 * Supported source file extensions for graph scanning.
 */
const SUPPORTED_EXTENSIONS = new Set(
	LANGUAGE_REGISTRY.getAll()
		.filter((p) => !p.parserOnly)
		.flatMap((p) => p.extensions),
);

/**
 * Whether `p` is a scannable source file — i.e. one of the extensions the
 * walker turns into a graph node. This is the SINGLE source of truth for "is
 * this a graph-node-able file" (issue #1985, defect A2): the write hook and
 * the incremental updater both route through it so the allowlist can never
 * drift from the builder's `LANGUAGE_REGISTRY`-derived set.
 */
export function isScannableSourcePath(p: string): boolean {
	return SUPPORTED_EXTENSIONS.has(path.extname(p).toLowerCase());
}

/**
 * Whether an edge's resolved target is an asset (a real file that never
 * becomes a graph node, e.g. JSON/CSS) rather than a node. Uses the explicit
 * `targetKind` tag on schema >= 1.3.0 graphs and falls back to an extension
 * check on older graphs whose edges are untagged (issue #1985, defect A1).
 * Asset edges only require their source node to exist during incremental
 * validation and are excluded from in-degree ranking / importer / dependent
 * queries.
 */
export function isAssetEdge(edge: GraphEdge): boolean {
	if (edge.targetKind === 'asset') return true;
	if (edge.targetKind === 'node') return false;
	return !isScannableSourcePath(edge.target);
}

/**
 * Default safety budgets for workspace traversal.
 */
const DEFAULT_WALK_FILE_CAP = 10000;
const DEFAULT_WALK_BUDGET_MS = 5000;
const ASYNC_WALK_YIELD_INTERVAL = 200;
const ASYNC_SCAN_YIELD_INTERVAL = 16;
const MAX_DIAGNOSTIC_ENTRIES = 200;
/** Correctness witnesses are not display diagnostics and must cover the full walk. */
export const MAX_EXTRACTOR_INPUT_WITNESSES = 100_256;

/**
 * Mapping of file extensions to tree-sitter grammar identifiers.
 * Derived from the language profiles registry.
 */
const EXTENSION_TO_LANGUAGE: Record<string, string> = {};
for (const profile of LANGUAGE_REGISTRY.getAll()) {
	if (profile.parserOnly) continue;
	for (const ext of profile.extensions) {
		EXTENSION_TO_LANGUAGE[ext] = profile.treeSitter.grammarId;
	}
}
const JS_FAMILY_EXTENSION_TO_LANGUAGE: Record<string, string> = {
	'.js': 'javascript',
	'.jsx': 'javascript',
	'.mjs': 'javascript',
	'.cjs': 'javascript',
	'.ts': 'typescript',
	'.tsx': 'tsx',
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

// ---------------------------------------------------------------------------
// Bulk-insert helpers for full-workspace construction (issue #1144).
//
// The exported upsertNode/addEdge above recompute graph.metadata
// (Object.keys(graph.nodes).length — O(nodes)) on EVERY insert, and addEdge
// scans all existing edges (O(edges)) to dedup. Calling them once per file and
// once per edge inside the build loops makes full-workspace construction
// O(N^2): on large repos this saturates the single-threaded event loop and
// stalls plugin startup for tens of seconds.
//
// These helpers insert in O(1): nodes go straight into the map, edges are
// deduped against a caller-owned Set, and metadata is computed ONCE after the
// loop (both build functions already do this). Output is byte-identical to the
// upsertNode/addEdge path — same validation, same node key + last-write-wins,
// same (source, target, importSpecifier) dedup, same push order. The exported
// helpers are intentionally left unchanged for incremental callers that mutate
// a small number of files, where the per-call cost is negligible.

/**
 * Build a collision-proof dedup key for an edge. Uses a NUL (U+0000) separator:
 * file paths and import specifiers can never contain NUL — parseFileImports
 * skips any import whose specifier contains a control character (and
 * path-security rejects control chars in resolved source/target paths), so
 * distinct edges can never alias even when paths/specifiers contain spaces.
 * `importType` is intentionally excluded, matching addEdge's
 * `(source, target, importSpecifier)` dedup predicate.
 */
function buildLoopEdgeKey(edge: GraphEdge): string {
	return `${edge.source}\u0000${edge.target}\u0000${edge.importSpecifier}`;
}

/** O(1) node insert mirroring upsertNode, minus the per-call metadata recompute. */
function appendNodeFast(graph: RepoGraph, node: GraphNode): void {
	validateGraphNode(node);
	graph.nodes[normalizeGraphPath(node.filePath)] = node;
}

/** O(1) deduped edge insert mirroring addEdge, minus the per-call metadata recompute. */
function appendEdgeFast(
	graph: RepoGraph,
	edge: GraphEdge,
	seenEdgeKeys: Set<string>,
): void {
	validateGraphEdge(edge);
	const key = buildLoopEdgeKey(edge);
	if (seenEdgeKeys.has(key)) return;
	seenEdgeKeys.add(key);
	graph.edges.push(edge);
}

// ============ Path Resolution ============

/**
 * Workspace-relative source roots probed when mapping a JVM/.NET dotted module
 * name onto a file. `''` covers a package-rooted layout (`com/example/Repo.java`
 * directly under the workspace root); the rest cover the conventional
 * Maven/Gradle and .NET layouts.
 */
const JVM_DOTNET_DOTTED_ROOTS = [
	'',
	'src',
	'src/main/java',
	'src/main/kotlin',
] as const;

/** Candidate file extensions for a dotted import, keyed on the *importing* file. */
function jvmDotnetSiblingExtensions(sourceFile: string): readonly string[] {
	switch (path.extname(sourceFile).toLowerCase()) {
		case '.java':
			return ['.java'];
		case '.kt':
		case '.kts':
			return ['.kt', '.kts'];
		case '.cs':
		case '.csx':
			return ['.cs', '.csx'];
		default:
			return [];
	}
}

/**
 * Conventional JVM/.NET test-file names: `FooTest.java`, `FooTests.cs`,
 * `FooSpec.kt`. The `Test`/`Tests`/`Spec` suffix must start with a capital, and
 * must be preceded by another identifier character, so ordinary production
 * names whose last syllable merely rhymes are not swept up — `Latest.cs`,
 * `Contest.java`, `Protest.kt` and `Respec.cs` all correctly fail this.
 */
const JVM_DOTNET_TEST_FILE_RE = /\w(?:Tests?|Spec)\.[A-Za-z]+$/;

/**
 * Representative source file for a package/namespace specifier (`import a.b.*;`,
 * `using App.Data;`), which names a directory rather than a single file.
 *
 * This mirrors the convention this module already uses for Go, whose imports
 * are likewise package-granular: `findDirectoryEntry` prefers
 * `<dirname>.go` and otherwise takes the first source file in the directory.
 * The resulting edge is a package-level dependency expressed through a
 * representative member, not a claim that the source named that exact file.
 *
 * A same-named file (`Data/Data.cs`) is preferred so the representative is
 * stable and meaningful where the convention exists; otherwise the first entry
 * by code-unit order is used, which is locale-independent and therefore
 * reproducible across machines.
 */
function firstSourceFileIn(
	directory: string,
	extensions: readonly string[],
): string | null {
	try {
		if (!fsSync.statSync(directory).isDirectory()) return null;
		const matching = fsSync
			.readdirSync(directory)
			.filter((entry) =>
				extensions.some((ext) => entry.toLowerCase().endsWith(ext)),
			)
			// Code-unit order, NOT localeCompare: ICU collation is host-dependent
			// and would make graph builds differ across machines.
			.sort();
		// Mirror the Go precedent's `!entry.endsWith('_test.go')` filter: a test
		// class is a poor representative of a package, and alphabetical order
		// makes `AaaTests.cs` beat the real type. Fall back to the unfiltered
		// list for a directory that contains nothing but tests, so a
		// test-only package still yields an edge.
		const nonTest = matching.filter(
			(entry) => !JVM_DOTNET_TEST_FILE_RE.test(entry),
		);
		const entries = nonTest.length > 0 ? nonTest : matching;
		const preferred = entries.find(
			(entry) =>
				path.basename(entry, path.extname(entry)).toLowerCase() ===
				path.basename(directory).toLowerCase(),
		);
		for (const entry of preferred ? [preferred, ...entries] : entries) {
			const candidate = path.join(directory, entry);
			// readdirSync also returns directories; a directory named `Foo.cs`
			// must never become an import target.
			try {
				if (fsSync.statSync(candidate).isFile()) return candidate;
			} catch {
				// unreadable entry - try the next one
			}
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Probe the workspace for the file a JVM/.NET dotted module specifier names.
 *
 * Two candidate shapes are tried, under each conventional source root:
 * 1. the full dotted path — `com.example.Repo` -> `com/example/Repo.java`
 *    (a type), or `com/example/` as a directory when the specifier names a
 *    package/namespace (`com.example.*`, C# `using App.Data;`);
 * 2. the parent path **as a file only** — `com.example.Outer.Inner` ->
 *    `com/example/Outer.java` (nested type), and the same shape a static
 *    member import reduces to.
 *
 * The parent path is deliberately NOT probed as a directory. Doing so would
 * make an import of a type that does not exist (`import com.example.Nope;`)
 * resolve to an arbitrary alphabetically-first sibling in `com/example/`,
 * fabricating an edge to a file the source never referenced.
 *
 * SECURITY: this returns a *candidate path only* and performs no symlink or
 * containment validation of its own. The caller rewrites the result into a
 * `./`-relative specifier and falls through to the shared relative-resolution
 * branch, so `safeRealpathSync` symlink resolution and the workspace
 * real-path containment check apply to a dotted specifier exactly as they do
 * to a relative one. Never return a path from here to a caller that skips
 * that fall-through.
 *
 * The `^[A-Za-z_][\w.]*(?:\.\*)?$` shape check also rejects any specifier
 * carrying `/` or `\`, so a crafted `foo/../../etc` import never reaches the
 * filesystem probe. It does NOT reject `..` on its own — `a..b` matches the
 * shape. Empty segments are dropped by the `.split('.').filter(Boolean)` in the
 * body, and THAT is what prevents a `..` path component from being built. Do
 * not remove that filter on the assumption the shape check covers it.
 */
function findDottedModuleCandidate(
	workspaceRoot: string,
	sourceFile: string,
	specifier: string,
): string | null {
	if (!/^[A-Za-z_][\w.]*(?:\.\*)?$/.test(specifier)) return null;
	const extensions = jvmDotnetSiblingExtensions(sourceFile);
	if (extensions.length === 0) return null;

	const isWildcard = specifier.endsWith('.*');
	const parts = specifier.replace(/\.\*$/, '').split('.').filter(Boolean);
	if (parts.length === 0) return null;
	const full = parts.join(path.sep);
	// A wildcard names a package, never a type, so its last segment must not be
	// re-interpreted as an enclosing type by the nested-type probe below.
	const parent =
		!isWildcard && parts.length > 1 ? parts.slice(0, -1).join(path.sep) : null;

	for (const rootPrefix of JVM_DOTNET_DOTTED_ROOTS) {
		const fullBase = path.join(workspaceRoot, rootPrefix, full);
		for (const ext of extensions) {
			// existsSync follows symlinks, so a dangling link is skipped here and
			// a live one is validated by the caller's realpath check.
			if (existsSync(fullBase + ext)) return fullBase + ext;
		}

		// The specifier names a package/namespace directory: resolve to a
		// representative member, matching the Go convention above.
		const inPackage = firstSourceFileIn(fullBase, extensions);
		if (inPackage) return inPackage;

		if (parent === null) continue;
		const parentBase = path.join(workspaceRoot, rootPrefix, parent);
		for (const ext of extensions) {
			if (existsSync(parentBase + ext)) return parentBase + ext;
		}
	}
	return null;
}

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
		let normalizedSpecifier = specifier;
		const rustParts = specifier.split('::').filter(Boolean);
		if (rustParts[0] === 'crate') {
			let target = path.join(workspaceRoot, ...rustParts.slice(1));
			const targetExists =
				existsSync(target) ||
				existsSync(`${target}.rs`) ||
				existsSync(path.join(target, 'mod.rs'));
			if (!targetExists) {
				target = path.join(path.dirname(sourceFile), ...rustParts.slice(1));
			}
			normalizedSpecifier = path
				.relative(path.dirname(sourceFile), target)
				.replace(/\\/g, '/');
			if (!normalizedSpecifier.startsWith('.')) {
				normalizedSpecifier = `./${normalizedSpecifier}`;
			}
		} else if (rustParts[0] === 'self') {
			normalizedSpecifier = `./${rustParts.slice(1).join('/')}`;
		} else if (rustParts[0] === 'super') {
			let superCount = 0;
			while (rustParts[superCount] === 'super') superCount++;
			normalizedSpecifier = `${'../'.repeat(superCount)}${rustParts
				.slice(superCount)
				.join('/')}`;
		} else {
			// JVM/.NET dotted module (`com.example.Repo`, `com.example.*`). Like
			// the `crate` branch above, this only REWRITES the specifier into a
			// `./`-relative form; the resolution, symlink realpath, and workspace
			// containment checks below are then applied unchanged (issue #1529,
			// F7). No-ops for every non-JVM/.NET source file.
			const dottedTarget = findDottedModuleCandidate(
				workspaceRoot,
				sourceFile,
				normalizedSpecifier,
			);
			if (dottedTarget !== null) {
				normalizedSpecifier = path
					.relative(path.dirname(sourceFile), dottedTarget)
					.replace(/\\/g, '/');
				// A same-directory target yields a bare `Repo.java` with no leading
				// `./`, which would fall through to the bare-specifier `return null`.
				if (!normalizedSpecifier.startsWith('.')) {
					normalizedSpecifier = `./${normalizedSpecifier}`;
				}
			}
		}

		// Resolve relative to source file
		if (normalizedSpecifier.startsWith('.')) {
			const sourceDir = path.dirname(sourceFile);
			let resolved = path.resolve(sourceDir, normalizedSpecifier);

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

			const findDirectoryEntry = (directory: string): string | null => {
				for (const initName of ['__init__.py', '__init__.pyw', 'mod.rs']) {
					const candidate = path.join(directory, initName);
					if (existsSync(candidate)) return candidate;
				}
				if (path.extname(sourceFile).toLowerCase() === '.go') {
					const basenameCandidate = path.join(
						directory,
						`${path.basename(directory)}.go`,
					);
					if (existsSync(basenameCandidate)) return basenameCandidate;
					try {
						const firstGo = fsSync
							.readdirSync(directory)
							.filter(
								(entry) => entry.endsWith('.go') && !entry.endsWith('_test.go'),
							)
							.sort((a, b) => a.localeCompare(b))[0];
						if (firstGo) return path.join(directory, firstGo);
					} catch {
						return null;
					}
				}
				return null;
			};

			if (existsSync(resolved)) {
				try {
					if (fsSync.statSync(resolved).isDirectory()) {
						const found = findDirectoryEntry(resolved);
						if (!found) return null;
						const foundRealPath = _internals.safeRealpathSync(found, found);
						if (foundRealPath === null) return null;
						realResolved = foundRealPath;
						resolved = found;
					}
				} catch {
					return null;
				}
			}

			// Try to resolve the extensionless path to a real file.
			// TypeScript/JavaScript imports commonly omit extensions: import { foo } from './utils'
			// We need to find the actual file: ./utils.ts, ./utils.js, etc.
			if (!existsSync(resolved)) {
				const EXTENSIONS =
					path.extname(sourceFile).toLowerCase() === '.pyw'
						? [
								'.pyw',
								'.py',
								'.rs',
								'.go',
								'.ts',
								'.tsx',
								'.js',
								'.jsx',
								'.mjs',
								'.cjs',
								'.json',
							]
						: [
								'.ts',
								'.tsx',
								'.js',
								'.jsx',
								'.mjs',
								'.cjs',
								'.py',
								'.pyw',
								'.rs',
								'.go',
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
				if (!found) {
					found = findDirectoryEntry(resolved);
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
	/**
	 * Absolute scan root, stashed by the builder so the recursive walker can
	 * compute workspace-relative manifest-dir paths without threading an extra
	 * parameter through every recursion (defect A8). Underscore-prefixed
	 * because it is build-internal plumbing, not a reported diagnostic.
	 */
	_absoluteRoot?: string;
}

/**
 * Fully-populated diagnostics shape used during a build. `Required<>` would
 * make `walkTruncationReason` (a `'budget' | 'cap'` union with no `undefined`)
 * non-optional and therefore unrepresentable as "unset" — `undefined` is not
 * assignable to that union under `strict` (issue #1985, defect A7). Omit the
 * reason from `Required<>` and re-declare it optional so the rest of the
 * fields stay required while the reason can be absent until a walk truncates.
 */
type FilledDiagnostics = Omit<
	Required<RepoGraphDiagnostics>,
	'walkTruncationReason'
> & {
	walkTruncationReason?: 'budget' | 'cap';
};

function createEmptyDiagnostics(): FilledDiagnostics {
	return {
		extractionFailures: [],
		unresolvedImports: [],
		oversizedFiles: [],
		unsupportedFiles: [],
		binaryFiles: [],
		unreadableFiles: [],
		validationSkippedFiles: [],
		extractorInputWitnesses: [],
		lowConfidenceEdgeCount: 0,
		walkTruncated: false,
		incrementalFallbacks: 0,
	};
}

function diagnosticsHaveEntries(diagnostics: RepoGraphDiagnostics): boolean {
	return (
		(diagnostics.extractionFailures?.length ?? 0) > 0 ||
		(diagnostics.unresolvedImports?.length ?? 0) > 0 ||
		(diagnostics.oversizedFiles?.length ?? 0) > 0 ||
		(diagnostics.unsupportedFiles?.length ?? 0) > 0 ||
		(diagnostics.binaryFiles?.length ?? 0) > 0 ||
		(diagnostics.unreadableFiles?.length ?? 0) > 0 ||
		(diagnostics.validationSkippedFiles?.length ?? 0) > 0 ||
		(diagnostics.extractorInputWitnesses?.length ?? 0) > 0 ||
		(diagnostics.lowConfidenceEdgeCount ?? 0) > 0 ||
		diagnostics.walkTruncated === true ||
		diagnostics.walkTruncationReason !== undefined ||
		(diagnostics.incrementalFallbacks ?? 0) > 0
	);
}

function pushCapped<T>(target: T[], value: T): void {
	if (target.length < MAX_DIAGNOSTIC_ENTRIES) {
		target.push(value);
	}
}

function pushInputWitness(
	target: GraphExtractorInputWitness[],
	value: GraphExtractorInputWitness,
): void {
	if (target.length < MAX_EXTRACTOR_INPUT_WITNESSES) target.push(value);
}

function mergeDiagnostics(
	target: FilledDiagnostics,
	source: RepoGraphDiagnostics | undefined,
): void {
	if (!source) return;
	for (const entry of source.extractionFailures ?? []) {
		pushCapped(target.extractionFailures, entry);
	}
	for (const entry of source.unresolvedImports ?? []) {
		pushCapped(target.unresolvedImports, entry);
	}
	for (const entry of source.oversizedFiles ?? []) {
		pushCapped(target.oversizedFiles, entry);
	}
	for (const entry of source.unsupportedFiles ?? []) {
		pushCapped(target.unsupportedFiles, entry);
	}
	for (const entry of source.binaryFiles ?? []) {
		pushCapped(target.binaryFiles, entry);
	}
	for (const entry of source.unreadableFiles ?? []) {
		pushCapped(target.unreadableFiles, entry);
	}
	for (const entry of source.validationSkippedFiles ?? []) {
		pushCapped(target.validationSkippedFiles, entry);
	}
	for (const entry of source.extractorInputWitnesses ?? []) {
		pushInputWitness(target.extractorInputWitnesses, entry);
	}
	target.lowConfidenceEdgeCount += source.lowConfidenceEdgeCount ?? 0;
	// incrementalFallbacks accumulates across per-file scans (rare, but a
	// single build could surface multiple); walk-level fields are set once
	// after the walk completes, so they are NOT merged here.
	target.incrementalFallbacks += source.incrementalFallbacks ?? 0;
}

function isRelativeImportSpecifier(specifier: string): boolean {
	return (
		specifier === '.' ||
		specifier === '..' ||
		specifier.startsWith('./') ||
		specifier.startsWith('../')
	);
}

function unresolvedRelativeImportsFor(
	parsedImports: ParsedImport[],
	filePath: string,
	absoluteRoot: string,
): GraphUnresolvedImport[] {
	const unresolved: GraphUnresolvedImport[] = [];
	const moduleName = toModuleName(filePath, absoluteRoot);
	for (const parsed of parsedImports) {
		if (!isRelativeImportSpecifier(parsed.specifier)) continue;
		const resolvedTarget = resolveModuleSpecifier(
			absoluteRoot,
			filePath,
			parsed.specifier,
		);
		if (resolvedTarget === null) {
			unresolved.push({ file: moduleName, specifier: parsed.specifier });
		}
	}
	return unresolved;
}

/**
 * A parsed import with its specifier and type.
 */
/**
 * A single imported binding: the symbol's *exported* name in the target file
 * and the *local* name it is bound to in the importing file (differs when an
 * `as` alias or default import is used). Used to attribute call-site usage back
 * to the correct exported symbol.
 */
interface ImportBinding {
	imported: string;
	local: string;
}

interface ParsedImport {
	/** The module specifier (e.g., './foo', 'lodash') */
	specifier: string;
	/** The type of import */
	importType:
		| 'default'
		| 'named'
		| 'namespace'
		| 'require'
		| 'sideeffect'
		| 'type';
	/** Named imported symbols when statically detectable */
	importedSymbols: string[];
	/** Alias-aware imported→local bindings for usage attribution */
	bindings: ImportBinding[];
	/** True for `export { x } from '...'` re-exports (symbols are re-exposed). */
	reExport: boolean;
}

/**
 * Parse imports from file content using the same rules as imports.ts.
 * Handles ES module imports and CommonJS require() statements.
 *
 * @param content - File content to parse
 * @returns Array of parsed imports with specifier and type
 */
/**
 * Characters after which a `/` begins a regex literal rather than a division
 * operator. At these expression-start positions `/` cannot be division, so a
 * following `/regex/` is a regex literal whose body must be treated opaquely
 * (it may legally contain `/*`, `//`, quotes, etc.).
 */
const REGEX_ALLOWED_AFTER = new Set('(,=:[!&|?{};*+-~^<>%'.split(''));

/**
 * Strip line (`//…`) and block (`/* … *\/`) comments from JS/TS source while
 * preserving string, template-literal, and regex-literal contents (DD-C010).
 * Import specifiers live inside string literals, so strings must be kept
 * intact; only comment spans are removed. This is a bounded single-pass scanner
 * — not a full parser (AST parsing in the repo-graph init path would violate
 * AGENTS.md invariant 1) — and it eliminates the most common source of false
 * import edges: import-like text inside comments (`// import x from "y"`).
 *
 * It is string-aware (a `//` inside `"http://…"` is not a comment) and
 * regex-aware (a regex literal such as `/[/*]/` must not be mistaken for the
 * start of a block comment, which would otherwise run to EOF and delete real
 * imports). Regex-vs-division is disambiguated by the previous significant
 * character (REGEX_ALLOWED_AFTER).
 */
function stripComments(content: string): string {
	let out = '';
	let i = 0;
	const n = content.length;
	type State =
		| 'code'
		| 'single'
		| 'double'
		| 'template'
		| 'line'
		| 'block'
		| 'regex';
	let state: State = 'code';
	// Last non-whitespace char emitted while in `code` — disambiguates a `/`
	// that starts a regex literal from a division operator. Empty = start of
	// input (regex allowed).
	let prevSignificant = '';
	// Whether the regex scanner is inside a `[...]` character class, where `/`
	// is literal and does not close the regex.
	let regexInClass = false;
	while (i < n) {
		const ch = content[i];
		const next = i + 1 < n ? content[i + 1] : '';
		switch (state) {
			case 'code':
				// `//` and `/*` always start comments — a regex literal can begin
				// with neither (`//` is an empty regex = comment per the JS grammar;
				// `/*` cannot start a regex since `*` is an invalid leading quantifier).
				if (ch === '/' && next === '/') {
					state = 'line';
					i += 2;
				} else if (ch === '/' && next === '*') {
					state = 'block';
					i += 2;
				} else if (ch === '/' && REGEX_ALLOWED_AFTER.has(prevSignificant)) {
					// Regex literal — consume its body opaquely.
					state = 'regex';
					regexInClass = false;
					out += ch;
					i += 1;
				} else {
					if (ch === "'") state = 'single';
					else if (ch === '"') state = 'double';
					else if (ch === '`') state = 'template';
					out += ch;
					if (ch.trim() !== '') prevSignificant = ch;
					i += 1;
				}
				break;
			case 'single':
			case 'double':
			case 'template': {
				const quote = state === 'single' ? "'" : state === 'double' ? '"' : '`';
				if (ch === '\\') {
					// Preserve escape sequences verbatim.
					out += ch + next;
					i += 2;
				} else {
					if (ch === quote) {
						state = 'code';
						// A literal is a value: a following `/` is division.
						prevSignificant = quote;
					}
					out += ch;
					i += 1;
				}
				break;
			}
			case 'regex':
				if (ch === '\\') {
					out += ch + next;
					i += 2;
				} else if (ch === '\n') {
					// Regex literals cannot span lines — bail defensively to code.
					state = 'code';
					out += ch;
					i += 1;
				} else {
					if (ch === '[') regexInClass = true;
					else if (ch === ']') regexInClass = false;
					else if (ch === '/' && !regexInClass) {
						state = 'code';
						prevSignificant = '/'; // after a regex, `/` is division
					}
					out += ch;
					i += 1;
				}
				break;
			case 'line':
				// Drop comment chars; preserve the newline so line structure (and
				// downstream regex anchors) are unaffected.
				if (ch === '\n') {
					state = 'code';
					out += ch;
				}
				i += 1;
				break;
			case 'block':
				if (ch === '*' && next === '/') {
					state = 'code';
					i += 2;
				} else {
					// Preserve newlines inside block comments.
					if (ch === '\n') out += ch;
					i += 1;
				}
				break;
		}
	}
	return out;
}

function parseFileImports(
	rawContent: string,
	sourceFile?: string,
	workspaceRoot?: string,
): ParsedImport[] {
	const ext = sourceFile ? path.extname(sourceFile).toLowerCase() : '';
	if (ext === '.py' || ext === '.pyw') {
		return parsePythonFileImports(rawContent, sourceFile);
	}
	if (ext === '.rs') {
		return parseRustFileImports(rawContent, sourceFile, workspaceRoot);
	}
	if (ext === '.go') {
		return parseGoFileImports(rawContent);
	}
	if (ext === '.java') {
		return parseJavaFileImports(rawContent);
	}
	if (ext === '.kt' || ext === '.kts') {
		return parseKotlinFileImports(rawContent);
	}
	if (ext === '.cs' || ext === '.csx') {
		return parseCSharpFileImports(rawContent);
	}

	const imports: ParsedImport[] = [];
	const content = stripComments(rawContent);

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

		imports.push({
			specifier: modulePath,
			importType,
			importedSymbols: parseImportedSymbols(matchedString, importType),
			bindings: parseImportBindings(matchedString, importType),
			reExport: /^\s*export\b/.test(matchedString),
		});
	}

	return imports;
}

function makeParsedImport(
	specifier: string,
	importType: ParsedImport['importType'],
	bindings: ImportBinding[],
	reExport = false,
): ParsedImport | null {
	if (!specifier || containsControlChars(specifier)) return null;
	return {
		specifier,
		importType,
		importedSymbols: bindings.map((binding) => binding.imported),
		bindings,
		reExport,
	};
}

/** Final segment of a dotted name: `a.b.C` -> `C`. */
function finalDottedSegment(value: string): string {
	const parts = value.split('.').filter(Boolean);
	return parts[parts.length - 1] ?? value;
}

/**
 * Regex import fallback for Java. Used only when tree-sitter extraction fails
 * (grammar load failure, AST timeout, parse error) and `scanFileAsync` falls
 * back to `scanFile` — before this branch existed, `.java` fell through to the
 * TypeScript ESM regex and produced zero imports (issue #1529, RC-10).
 *
 * Binding semantics deliberately mirror `parseJavaImport` in
 * `src/lang/symbol-graph.ts` so the AST path and the fallback path emit the
 * same shape:
 * - `import a.b.C;`         -> specifier `a.b.C`, named, binding `C`
 * - `import static a.b.C.m;` -> specifier `a.b.C`, named, binding `m`
 * - `import a.b.*;`          -> specifier `a.b.*`, namespace, no named binding
 */
function parseJavaFileImports(rawContent: string): ParsedImport[] {
	const imports: ParsedImport[] = [];
	const content = stripComments(rawContent);
	const re =
		/^[ \t]*import[ \t]+(static[ \t]+)?([A-Za-z_][\w.]*(?:\.\*)?)[ \t]*;?[ \t]*\r?$/gm;
	for (let m = re.exec(content); m !== null; m = re.exec(content)) {
		const isStatic = Boolean(m[1]);
		const raw = m[2];
		if (raw.endsWith('.*')) {
			const parsed = makeParsedImport(raw, 'namespace', []);
			if (parsed) imports.push(parsed);
			continue;
		}
		// A static single-member import names the member, so the module is the
		// enclosing type and the binding is the member.
		const imported = finalDottedSegment(raw);
		const specifier = isStatic ? raw.split('.').slice(0, -1).join('.') : raw;
		const parsed = makeParsedImport(specifier, 'named', [
			{ imported, local: imported },
		]);
		if (parsed) imports.push(parsed);
	}
	return imports;
}

/**
 * Regex import fallback for Kotlin (see {@link parseJavaFileImports}).
 * - `import a.b.C`        -> named, binding `C`
 * - `import a.b.C as D`   -> named, imported `C`, local `D`
 * - `import a.b.*`        -> namespace, no named binding
 * Kotlin has no `static` form; a member import is spelled like a type import.
 */
function parseKotlinFileImports(rawContent: string): ParsedImport[] {
	const imports: ParsedImport[] = [];
	const content = stripComments(rawContent);
	const re =
		/^[ \t]*import[ \t]+([A-Za-z_][\w.]*(?:\.\*)?)(?:[ \t]+as[ \t]+([A-Za-z_]\w*))?[ \t]*;?[ \t]*\r?$/gm;
	for (let m = re.exec(content); m !== null; m = re.exec(content)) {
		const raw = m[1];
		const alias = m[2];
		if (raw.endsWith('.*')) {
			const parsed = makeParsedImport(raw, 'namespace', []);
			if (parsed) imports.push(parsed);
			continue;
		}
		const imported = finalDottedSegment(raw);
		const parsed = makeParsedImport(raw, 'named', [
			{ imported, local: alias ?? imported },
		]);
		if (parsed) imports.push(parsed);
	}
	return imports;
}

/**
 * Regex import fallback for C# (see {@link parseJavaFileImports}).
 * - `using A.B;`            -> namespace, no named binding
 * - `using static A.B;`     -> namespace, no named binding
 * - `using X = A.B.C;`      -> named, imported `C`, local `X`
 * - `global using A.B;`     -> same as `using A.B;`
 *
 * The trailing `;` is REQUIRED by the pattern: without it, the C# 8 using
 * *declaration* (`using var stream = File.OpenRead(p);`) and the using
 * *statement* (`using (var x = …)`) both match and fabricate an import of a
 * module literally named `var`. A generic alias
 * (`using L = System.Collections.Generic.List<int>;`) is intentionally not
 * matched rather than mis-parsed.
 */
function parseCSharpFileImports(rawContent: string): ParsedImport[] {
	const imports: ParsedImport[] = [];
	const content = stripComments(rawContent);
	const re =
		/^[ \t]*(?:global[ \t]+)?using[ \t]+(static[ \t]+)?(?:([A-Za-z_]\w*)[ \t]*=[ \t]*)?([A-Za-z_][\w.]*)[ \t]*;[ \t]*\r?$/gm;
	for (let m = re.exec(content); m !== null; m = re.exec(content)) {
		const alias = m[2];
		const specifier = m[3];
		const parsed = alias
			? makeParsedImport(specifier, 'named', [
					{ imported: finalDottedSegment(specifier), local: alias },
				])
			: makeParsedImport(specifier, 'namespace', []);
		if (parsed) imports.push(parsed);
	}
	return imports;
}

function parsePythonFileImports(
	rawContent: string,
	sourceFile?: string,
): ParsedImport[] {
	const imports: ParsedImport[] = [];
	const isPackageInit = sourceFile
		? ['__init__.py', '__init__.pyw'].includes(path.basename(sourceFile))
		: false;

	for (const line of rawContent.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;

		const fullImport = trimmed.match(/^import\s+(.+?)(?:\s*#.*)?$/);
		if (fullImport) {
			for (const rawPart of fullImport[1].split(',')) {
				const part = rawPart.trim();
				if (!part) continue;
				const alias = part.match(/^([\w.]+)\s+as\s+(\w+)$/);
				const specifier = alias ? alias[1] : part;
				const local = alias ? alias[2] : specifier.split('.')[0];
				if (!/^\w+$/.test(local)) continue;
				const parsed = makeParsedImport(specifier, 'namespace', [
					{ imported: specifier, local },
				]);
				if (parsed) imports.push(parsed);
			}
			continue;
		}

		const fromImport = trimmed.match(
			/^from\s+(\S+)\s+import\s+(.+?)(?:\s*#.*)?$/,
		);
		if (!fromImport) continue;
		if (fromImport[2].trim() === '*') {
			const parsed = makeParsedImport(
				normalizePythonModuleSpecifier(fromImport[1]),
				'namespace',
				[],
				isPackageInit,
			);
			if (parsed) imports.push(parsed);
			continue;
		}

		const bindings: ImportBinding[] = [];
		for (const rawPart of fromImport[2].split(',')) {
			const part = rawPart.trim();
			if (!part) continue;
			const alias = part.match(/^(\w+)\s+as\s+(\w+)$/);
			if (alias) {
				bindings.push({ imported: alias[1], local: alias[2] });
			} else if (/^\w+$/.test(part)) {
				bindings.push({ imported: part, local: part });
			}
		}
		const parsed = makeParsedImport(
			normalizePythonModuleSpecifier(fromImport[1]),
			'named',
			bindings,
			isPackageInit,
		);
		if (parsed) imports.push(parsed);
	}

	return imports;
}

function normalizePythonModuleSpecifier(specifier: string): string {
	const leadingDots = specifier.match(/^\.+/)?.[0].length ?? 0;
	if (leadingDots === 0) return specifier;
	const rest = specifier.slice(leadingDots).replace(/\./g, '/');
	const prefix = leadingDots === 1 ? './' : '../'.repeat(leadingDots - 1);
	return `${prefix}${rest}`;
}

function rustModulePathToSpecifier(
	modulePath: string,
	sourceFile?: string,
	workspaceRoot?: string,
): string {
	const parts = modulePath.split('::').filter(Boolean);
	if (parts.length === 0) return modulePath;
	if (parts[0] === 'self') {
		return `./${parts.slice(1).join('/')}`;
	}
	if (parts[0] === 'super') {
		let superCount = 0;
		while (parts[superCount] === 'super') superCount++;
		return `${'../'.repeat(superCount)}${parts.slice(superCount).join('/')}`;
	}
	if (parts[0] === 'crate' && sourceFile && workspaceRoot) {
		const target = path.join(workspaceRoot, ...parts.slice(1));
		let relative = path
			.relative(path.dirname(sourceFile), target)
			.replace(/\\/g, '/');
		if (!relative.startsWith('.')) relative = `./${relative}`;
		return relative;
	}
	return modulePath;
}

function parseRustFileImports(
	rawContent: string,
	sourceFile?: string,
	workspaceRoot?: string,
): ParsedImport[] {
	const imports: ParsedImport[] = [];
	for (const line of rawContent.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed.startsWith('use ')) continue;

		const grouped = trimmed.match(/^use\s+(.+?)::\{(.+)\}\s*;?\s*$/);
		if (grouped) {
			const specifier = rustModulePathToSpecifier(
				grouped[1].trim(),
				sourceFile,
				workspaceRoot,
			);
			const bindings: ImportBinding[] = [];
			for (const rawPart of grouped[2].split(',')) {
				const part = rawPart.trim();
				if (!part) continue;
				const alias = part.match(/^(\w+)\s+as\s+(\w+)$/);
				if (alias) {
					bindings.push({ imported: alias[1], local: alias[2] });
				} else if (/^\w+$/.test(part)) {
					const local =
						part === 'self' ? grouped[1].split('::').pop() || grouped[1] : part;
					bindings.push({ imported: part, local });
				}
			}
			const parsed = makeParsedImport(specifier, 'named', bindings);
			if (parsed) imports.push(parsed);
			continue;
		}

		const simple = trimmed.match(/^use\s+(.+?)\s*;?\s*$/);
		if (!simple) continue;
		const rawPath = simple[1].trim();
		const alias = rawPath.match(/^(.+?)\s+as\s+(\w+)$/);
		const fullPath = (alias ? alias[1] : rawPath).trim();
		const parts = fullPath.split('::').filter(Boolean);
		const imported = parts.pop() ?? fullPath;
		const specifier = rustModulePathToSpecifier(
			parts.join('::') || fullPath,
			sourceFile,
			workspaceRoot,
		);
		const local = alias ? alias[2] : imported;
		const parsed = makeParsedImport(
			specifier,
			'named',
			/^\w+$/.test(imported) && /^\w+$/.test(local)
				? [{ imported, local }]
				: [],
		);
		if (parsed) imports.push(parsed);
	}
	return imports;
}

function parseGoFileImports(rawContent: string): ParsedImport[] {
	const imports: ParsedImport[] = [];
	const content = stripComments(rawContent);
	const parseSpec = (text: string) => {
		const spec = text.trim();
		if (!spec) return;
		const aliased = spec.match(/^([\w._]+)\s+["`]([^"`]+)["`]$/);
		if (aliased) {
			if (aliased[1] === '_') {
				const parsed = makeParsedImport(aliased[2], 'sideeffect', []);
				if (parsed) imports.push(parsed);
				return;
			}
			if (aliased[1] === '.') {
				const parsed = makeParsedImport(aliased[2], 'namespace', [
					{ imported: '*', local: '.' },
				]);
				if (parsed) imports.push(parsed);
				return;
			}
			const parsed = makeParsedImport(aliased[2], 'named', [
				{ imported: aliased[2], local: aliased[1] },
			]);
			if (parsed) imports.push(parsed);
			return;
		}

		const simple = spec.match(/^["`]([^"`]+)["`]$/);
		if (simple) {
			const parsed = makeParsedImport(simple[1], 'namespace', []);
			if (parsed) imports.push(parsed);
		}
	};

	for (const block of content.matchAll(/import\s*\(([\s\S]*?)\)/g)) {
		for (const line of block[1].split(/\r?\n/)) parseSpec(line);
	}
	const withoutBlocks = content.replace(/import\s*\([\s\S]*?\)/g, '');
	for (const match of withoutBlocks.matchAll(/^\s*import\s+(.+)$/gm)) {
		parseSpec(match[1]);
	}
	return imports;
}

/**
 * Parse alias-aware imported→local bindings from a matched import statement.
 *
 * Unlike {@link parseImportedSymbols} (which returns only exported names, plus
 * the sentinels '*'/'default'), this returns the *local* binding name actually
 * referenced at call sites, so usage can be attributed to the correct exported
 * symbol. Returns [] for namespace/side-effect/require imports, where per-symbol
 * usage is not statically resolvable.
 */
function parseImportBindings(
	matchedString: string,
	importType: ParsedImport['importType'],
): ImportBinding[] {
	if (importType === 'namespace') return [];
	if (importType === 'default') {
		const defaultMatch = matchedString.match(/^import\s+(\w+)\s+from\s+['"`]/);
		return defaultMatch
			? [{ imported: 'default', local: defaultMatch[1] }]
			: [];
	}
	if (importType !== 'named') return [];

	const braceMatch = matchedString.match(/\{\s*([\s\S]*?)\s*\}/);
	if (!braceMatch) return [];
	const bindings: ImportBinding[] = [];
	const seen = new Set<string>();
	for (const rawPart of braceMatch[1].split(',')) {
		const part = rawPart.trim().replace(/^type\s+/, '');
		if (!part) continue;
		const aliasSplit = part.split(/\s+as\s+/i);
		const imported = aliasSplit[0].trim();
		const local = (aliasSplit[1] ?? aliasSplit[0]).trim();
		if (!/^[A-Za-z_$][\w$]*$/.test(imported)) continue;
		if (!/^[A-Za-z_$][\w$]*$/.test(local)) continue;
		if (seen.has(imported)) continue;
		seen.add(imported);
		bindings.push({ imported, local });
	}
	return bindings;
}

/**
 * Identifier pattern safe to embed in a `\b...\b` word-boundary regex.
 * Excludes `$`-containing identifiers, which interact badly with `\b`.
 */
const SAFE_USAGE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Conservatively determine which imported bindings are actually referenced in
 * the importing file's body.
 *
 * Heuristic: in a well-formed import statement, each local binding name appears
 * exactly once. Counting occurrences of the local name across the
 * comment-stripped file content, a count > 1 means at least one body reference.
 * Strings are intentionally *not* stripped, so the bias is toward "used" — a
 * conservative direction that avoids false dead-export positives. Bindings whose
 * local name cannot be safely word-boundary matched are assumed used.
 *
 * @returns the *exported* names (binding.imported) judged to be used.
 */
function computeUsedSymbols(
	strippedContent: string,
	bindings: readonly ImportBinding[],
): string[] {
	if (bindings.length === 0) return [];
	const used = new Set<string>();
	for (const binding of bindings) {
		if (!SAFE_USAGE_IDENTIFIER.test(binding.local)) {
			used.add(binding.imported); // cannot analyze safely → assume used
			continue;
		}
		const re = new RegExp(`\\b${binding.local}\\b`, 'g');
		let count = 0;
		for (const _match of strippedContent.matchAll(re)) {
			count++;
			if (count > 1) break;
		}
		if (count > 1) used.add(binding.imported);
	}
	return [...used].sort((a, b) => a.localeCompare(b));
}

/**
 * Compute the `usedSymbols` value for a single import's edge, or `undefined`
 * when per-symbol usage is not statically resolvable (namespace/side-effect/
 * require/dynamic imports). Named re-exports treat all imported symbols as used,
 * since re-exporting exposes them to downstream consumers.
 */
function usedSymbolsForImport(
	parsed: ParsedImport,
	strippedContent: string,
): string[] | undefined {
	if (
		parsed.importType === 'namespace' ||
		parsed.importType === 'sideeffect' ||
		parsed.importType === 'require'
	) {
		return undefined;
	}
	if (parsed.reExport) {
		return [...new Set(parsed.bindings.map((b) => b.imported))].sort((a, b) =>
			a.localeCompare(b),
		);
	}
	return computeUsedSymbols(strippedContent, parsed.bindings);
}

/**
 * Collect a file's exported symbol names and their definition lines.
 *
 * A default export (`export default function go` / `export default class Foo`)
 * is extracted by `extractTSSymbols` under its *local* declaration name, but is
 * only ever referenced cross-file via the `default` sentinel that the import
 * side records. Normalizing it to `'default'` here keeps node `exports` /
 * `exportLines` reconciled with edge `usedSymbols` / `importedSymbols`, so the
 * `callers` / `dead_exports` queries do not mis-handle default exports
 * (issue #1409 review). Non-default exports are preserved verbatim, including
 * order and duplicates, so output stays byte-identical to the prior behavior.
 */
function collectExports(symbols: ReturnType<typeof extractTSSymbols>): {
	exports: string[];
	exportLines: Record<string, number>;
} {
	const exported = symbols.filter((s) => s.exported);
	const exports = exported.map((s) =>
		s.signature === `default ${s.name}` ? 'default' : s.name,
	);
	const exportLines: Record<string, number> = {};
	for (let i = 0; i < exported.length; i++) {
		const s = exported[i];
		const name = exports[i];
		if (
			typeof s.line === 'number' &&
			Number.isFinite(s.line) &&
			exportLines[name] === undefined
		) {
			exportLines[name] = s.line;
		}
	}
	return { exports, exportLines };
}

function parseImportedSymbols(
	matchedString: string,
	importType: ParsedImport['importType'],
): string[] {
	if (importType === 'namespace') return ['*'];
	if (importType === 'default') {
		const defaultMatch = matchedString.match(/^import\s+(\w+)\s+from\s+['"`]/);
		return defaultMatch ? ['default'] : [];
	}
	if (importType !== 'named') return [];

	const braceMatch = matchedString.match(/\{\s*([\s\S]*?)\s*\}/);
	if (!braceMatch) return [];
	const symbols = new Set<string>();
	for (const rawPart of braceMatch[1].split(',')) {
		const part = rawPart.trim();
		if (!part) continue;
		const cleaned = part
			.replace(/^type\s+/, '')
			.split(/\s+as\s+/i)[0]
			.trim();
		if (/^[A-Za-z_$][\w$]*$/.test(cleaned)) {
			symbols.add(cleaned);
		}
	}
	return [...symbols].sort((a, b) => a.localeCompare(b));
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
	/** Directory basenames to skip (built-in defaults ∪ caller excludeDirs). */
	skipDirs: ReadonlySet<string>;
	abortReason?: 'budget' | 'cap';
	/**
	 * Workspace-relative directories (forward slashes, no leading `./`) that
	 * contain a package manifest (`package.json`, `Cargo.toml`,
	 * `pyproject.toml`, `go.mod`). Populated during enumeration so the pure
	 * ontology extractor can apply the generic manifest-driven boundary rule
	 * without doing any fs I/O itself (issue #1985, defect A8). The workspace
	 * root's own manifest is recorded as `''`; the seg0/seg1 boundary rule
	 * never consults it (no seg0/seg1 at depth 1).
	 */
	manifestDirs: Set<string>;
	/** Build-time witnesses for graph-wide manifests found by the sync walk. */
	manifestWitnesses: GraphExtractorInputWitness[];
}

/** Manifest basenames that mark a directory as a package root (defect A8). */
const MANIFEST_BASENAMES = new Set([
	'package.json',
	'Cargo.toml',
	'pyproject.toml',
	'go.mod',
]);

/**
 * Return whether a path is a graph-wide extractor input. Changes to these
 * manifests can alter package-boundary ontology for many nodes, so consumers
 * must rebuild rather than treating them as an ordinary one-file refresh.
 */
export function isGraphWideInputPath(filePath: string): boolean {
	return MANIFEST_BASENAMES.has(path.basename(filePath));
}

/**
 * Record `dir`'s workspace-relative path into `manifestDirs` when one of its
 * direct file entries is a package manifest. `absoluteRoot` is the scan root
 * used to compute the relative directory; the root itself records as `''`.
 */
function recordManifestDir(
	manifestDirs: Set<string>,
	absoluteRoot: string,
	dir: string,
	entryName: string,
): void {
	if (!MANIFEST_BASENAMES.has(entryName)) return;
	let rel = path.relative(absoluteRoot, dir).split(path.sep).join('/');
	if (rel.startsWith('./')) rel = rel.slice(2);
	manifestDirs.add(rel);
}

function isWalkBudgetExceeded(ctx: WalkContext): boolean {
	if (ctx.abortReason !== undefined) return true;
	if (_internals.now() - ctx.startedAt > ctx.walkBudgetMs) {
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
		excludeDirs?: readonly string[];
	},
): { files: string[]; ctx: WalkContext } {
	const ctx: WalkContext = {
		stats,
		seenRealPaths: new Set<string>(),
		startedAt: _internals.now(),
		walkBudgetMs: options?.walkBudgetMs ?? DEFAULT_WALK_BUDGET_MS,
		maxFiles: options?.maxFiles ?? DEFAULT_WALK_FILE_CAP,
		followSymlinks: options?.followSymlinks ?? false,
		skipDirs: resolveSkipDirectories(options?.excludeDirs),
		manifestDirs: new Set<string>(),
		manifestWitnesses: [],
	};
	const files: string[] = [];
	walkSyncInto(dir, ctx, files);
	if (ctx.abortReason === 'cap' || ctx.abortReason === 'budget') {
		stats.truncated = true;
	}
	return { files, ctx };
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

	// absoluteRoot is the scan root (first call's `dir`). Manifest dirs are
	// recorded relative to it so the pure ontology extractor needs no fs I/O.
	const absoluteRoot = ctx.stats._absoluteRoot;
	for (const entry of entries) {
		if (isWalkBudgetExceeded(ctx) || isFileCapReached(ctx, files.length)) {
			return;
		}
		if (ctx.skipDirs.has(entry.name)) {
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
			if (absoluteRoot !== undefined) {
				recordManifestDir(ctx.manifestDirs, absoluteRoot, dir, entry.name);
			}
			if (absoluteRoot !== undefined && isGraphWideInputPath(fullPath)) {
				try {
					const manifestStats = fsSync.statSync(fullPath);
					pushInputWitness(ctx.manifestWitnesses, {
						file: toModuleName(fullPath, absoluteRoot),
						kind: 'manifest',
						sizeBytes: manifestStats.size,
						mtimeMs: manifestStats.mtimeMs,
					});
				} catch {
					// Build stays fail-open; persistence will refuse certification.
				}
			}
			const ext = path.extname(fullPath).toLowerCase();
			if (SUPPORTED_EXTENSIONS.has(ext)) {
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
export interface RepoGraphInputMetadata {
	absolutePath: string;
	kind: 'source' | 'manifest';
	sizeBytes: number;
	mtimeMs: number;
}

export interface RepoGraphInputWalkResult {
	sourceFiles: string[];
	manifestFiles: string[];
	metadata: RepoGraphInputMetadata[];
	manifestDirs: Set<string>;
	truncated: boolean;
	truncationReason?: 'budget' | 'cap';
	incomplete: boolean;
	unreadableDirectories: string[];
	unreadableFiles: string[];
	probedFiles: number;
	elapsedMs: number;
}

export interface RepoGraphInputWalkOptions {
	walkBudgetMs?: number;
	maxFiles?: number;
	followSymlinks?: boolean;
	excludeDirs?: readonly string[];
	/** Capture size/mtime for every source and manifest during this same walk. */
	captureMetadata?: boolean;
	/** Capture only graph-wide manifest metadata (used by the graph builder). */
	captureManifestMetadata?: boolean;
}

/**
 * Enumerate every input used by repository-graph extraction with the same
 * bounded, deterministic, cycle-safe traversal as the async graph builder.
 * Directory and metadata I/O failures are surfaced through `incomplete` so a
 * caller can refuse removals/certification instead of guessing.
 */
export async function walkRepoGraphInputs(
	dir: string,
	options?: RepoGraphInputWalkOptions,
): Promise<RepoGraphInputWalkResult> {
	const absoluteRoot = path.resolve(dir);
	const stats: ScanStats = {
		filesScanned: 0,
		skippedDirs: 0,
		skippedFiles: 0,
		truncated: false,
		_absoluteRoot: absoluteRoot,
	};
	const ctx: WalkContext = {
		stats,
		seenRealPaths: new Set<string>(),
		startedAt: _internals.now(),
		walkBudgetMs: options?.walkBudgetMs ?? DEFAULT_WALK_BUDGET_MS,
		maxFiles: options?.maxFiles ?? DEFAULT_WALK_FILE_CAP,
		followSymlinks: options?.followSymlinks ?? false,
		skipDirs: resolveSkipDirectories(options?.excludeDirs),
		manifestDirs: new Set<string>(),
		manifestWitnesses: [],
	};
	const files: string[] = [];
	const manifestFiles: string[] = [];
	const metadata: RepoGraphInputMetadata[] = [];
	const unreadableDirectories: string[] = [];
	const unreadableFiles: string[] = [];
	const queue: string[] = [absoluteRoot];
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
		} else {
			unreadableDirectories.push(current);
		}

		let entries: fsSync.Dirent[];
		try {
			entries = await fsPromises.readdir(current, { withFileTypes: true });
		} catch {
			unreadableDirectories.push(current);
			continue;
		}
		entries.sort((a, b) =>
			a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
		);

		const absoluteRoot = ctx.stats._absoluteRoot;
		for (const entry of entries) {
			if (isWalkBudgetExceeded(ctx) || isFileCapReached(ctx, files.length)) {
				break;
			}
			if (ctx.skipDirs.has(entry.name)) {
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
				if (absoluteRoot !== undefined) {
					recordManifestDir(
						ctx.manifestDirs,
						absoluteRoot,
						current,
						entry.name,
					);
				}
				const ext = path.extname(fullPath).toLowerCase();
				const isSource = SUPPORTED_EXTENSIONS.has(ext);
				const isManifest = isGraphWideInputPath(fullPath);
				if (isSource) {
					files.push(fullPath);
				}
				if (isManifest) {
					manifestFiles.push(fullPath);
				}
				if (
					(options?.captureMetadata && (isSource || isManifest)) ||
					(options?.captureManifestMetadata && isManifest)
				) {
					try {
						const fileStats = await fsPromises.stat(fullPath);
						metadata.push({
							absolutePath: fullPath,
							kind: isManifest ? 'manifest' : 'source',
							sizeBytes: fileStats.size,
							mtimeMs: fileStats.mtimeMs,
						});
					} catch {
						unreadableFiles.push(fullPath);
					}
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
	return {
		sourceFiles: files,
		manifestFiles,
		metadata,
		manifestDirs: ctx.manifestDirs,
		truncated: stats.truncated,
		truncationReason: ctx.abortReason,
		incomplete:
			stats.truncated ||
			unreadableDirectories.length > 0 ||
			unreadableFiles.length > 0,
		unreadableDirectories,
		unreadableFiles,
		probedFiles: metadata.length,
		elapsedMs: Math.max(0, _internals.now() - ctx.startedAt),
	};
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
 * @returns Language identifier string (tree-sitter grammarId)
 */
function getLanguage(filePath: string): string {
	const ext = path.extname(filePath).toLowerCase();
	const jsFamilyLanguage = JS_FAMILY_EXTENSION_TO_LANGUAGE[ext];
	if (jsFamilyLanguage) return jsFamilyLanguage;
	return EXTENSION_TO_LANGUAGE[ext] ?? 'unknown';
}

/**
 * Grammars whose `exportRanges` map is populated from *all* defs rather than
 * only exported ones. JVM/.NET members are intentionally never `exported`
 * (they are not file-level module exports), so without this `context_pack`
 * could never return a span for a Java method (issue #1529, RC-7).
 */
const JVM_DOTNET_RANGE_GRAMMARS = new Set(['java', 'kotlin', 'csharp']);

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
 * Result of the async single-file scanner. Extends ScanResult with
 * symbol-level reference edges produced by tree-sitter symbol extraction.
 */
export interface AsyncScanResult {
	node: GraphNode | null;
	edges: GraphEdge[];
	/** Symbol-to-symbol reference edges (schema >= 1.2.0). */
	symbolEdges: SymbolEdge[];
	/** Optional file-level diagnostics collected during async scanning. */
	diagnostics?: RepoGraphDiagnostics;
	/** Build-time witness for a deterministic non-node skip. */
	inputWitness?: GraphExtractorInputWitness;
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
	hasManifest?: (relDir: string) => boolean,
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
	let exportLines: Record<string, number> = {};

	try {
		if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
			const relativePath = path.relative(absoluteRoot, filePath);
			({ exports, exportLines } = collectExports(
				_internals.extractTSSymbols(relativePath, absoluteRoot),
			));
		} else if (ext === '.py' || ext === '.pyw') {
			const relativePath = path.relative(absoluteRoot, filePath);
			({ exports, exportLines } = collectExports(
				_internals.extractPythonSymbols(relativePath, absoluteRoot),
			));
		} else if (ext === '.rs') {
			const relativePath = path.relative(absoluteRoot, filePath);
			({ exports, exportLines } = collectExports(
				_internals.extractRustSymbols(relativePath, absoluteRoot),
			));
		} else if (ext === '.go') {
			const relativePath = path.relative(absoluteRoot, filePath);
			({ exports, exportLines } = collectExports(
				_internals.extractGoSymbols(relativePath, absoluteRoot),
			));
		}

		// Parse imports to get specifiers with types
		const parsedImports = _internals.parseFileImports(
			content,
			filePath,
			absoluteRoot,
		);

		// Comment-stripped content for conservative call-site usage detection.
		// Computed once per file; only needed when there are imports to attribute.
		const strippedForUsage =
			parsedImports.length > 0 ? _internals.stripComments(content) : '';

		const moduleName = toModuleName(filePath, absoluteRoot);
		// Create the graph node
		const node: GraphNode = {
			filePath,
			moduleName,
			exports,
			...(Object.keys(exportLines).length > 0 ? { exportLines } : {}),
			imports: parsedImports.map((p) => p.specifier),
			language: getLanguage(filePath),
			mtime: fileStats.mtime.toISOString(),
			sizeBytes: fileStats.size,
			mtimeMs: fileStats.mtimeMs,
			ontology: _internals.extractFileOntology({
				moduleName,
				filePath,
				content,
				language: getLanguage(filePath),
				exports,
				imports: parsedImports.map((p) => p.specifier),
				hasManifest,
			}),
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
				const usedSymbols = usedSymbolsForImport(parsed, strippedForUsage);
				edges.push({
					source: filePath,
					target: resolvedTarget,
					importSpecifier: parsed.specifier,
					importType: parsed.importType,
					importedSymbols: parsed.importedSymbols,
					...(usedSymbols !== undefined ? { usedSymbols } : {}),
					targetKind: isScannableSourcePath(resolvedTarget) ? 'node' : 'asset',
				});
			}
		}

		return { node, edges };
	} catch {
		// Skip malformed file without aborting incremental update
		return { node: null, edges: [] };
	}
}

/**
 * Async variant of scanFile that uses tree-sitter symbol extraction
 * (extractFileSymbols) to populate exportRanges and symbolEdges.
 *
 * Fail-open: if extractFileSymbols returns null (grammar unavailable,
 * timeout, parse error), falls back to the file-level scanner so imports,
 * exports, and dependency edges are preserved.
 *
 * Oversized, binary, or unreadable files return
 * { node: null, edges: [], symbolEdges: [] } with bounded diagnostics.
 *
 * @param filePath - Absolute path to the file to scan
 * @param absoluteRoot - Absolute path to workspace root
 * @param maxFileSize - Maximum file size in bytes
 * @returns AsyncScanResult with node, edges, and symbolEdges
 */
export async function scanFileAsync(
	filePath: string,
	absoluteRoot: string,
	maxFileSize: number,
	hasManifest?: (relDir: string) => boolean,
): Promise<AsyncScanResult> {
	let content: string;
	let fileStats: fsSync.Stats;

	try {
		fileStats = await fsPromises.stat(filePath);
		if (fileStats.size > maxFileSize) {
			const moduleName = toModuleName(filePath, absoluteRoot);
			return {
				node: null,
				edges: [],
				symbolEdges: [],
				diagnostics: { oversizedFiles: [moduleName] },
				inputWitness: {
					file: moduleName,
					kind: 'stable-skip',
					sizeBytes: fileStats.size,
					mtimeMs: fileStats.mtimeMs,
				},
			};
		}
		content = await fsPromises.readFile(filePath, 'utf-8');
	} catch {
		return {
			node: null,
			edges: [],
			symbolEdges: [],
			diagnostics: { unreadableFiles: [toModuleName(filePath, absoluteRoot)] },
		};
	}

	// Skip binary files
	if (isBinaryContent(content)) {
		const moduleName = toModuleName(filePath, absoluteRoot);
		return {
			node: null,
			edges: [],
			symbolEdges: [],
			diagnostics: { binaryFiles: [moduleName] },
			inputWitness: {
				file: moduleName,
				kind: 'stable-skip',
				sizeBytes: fileStats.size,
				mtimeMs: fileStats.mtimeMs,
			},
		};
	}

	const grammarId = getLanguage(filePath);
	const facts = await _internals.extractFileSymbols(grammarId, content);

	// Fail-open: tree-sitter unavailable or timed out → minimal node
	if (facts === null) {
		const fallback = scanFile(filePath, absoluteRoot, maxFileSize, hasManifest);
		let parsedImports: ParsedImport[] = [];
		try {
			parsedImports = _internals.parseFileImports(
				content,
				filePath,
				absoluteRoot,
			);
		} catch {
			parsedImports = [];
		}
		return {
			...fallback,
			symbolEdges: [],
			diagnostics: {
				extractionFailures: [
					{
						file: toModuleName(filePath, absoluteRoot),
						language: grammarId,
						reason: 'symbol_extraction_failed',
					},
				],
				unresolvedImports: unresolvedRelativeImportsFor(
					parsedImports,
					filePath,
					absoluteRoot,
				),
			},
		};
	}

	// Derive exports, exportLines, exportRanges from tree-sitter defs
	const exportedDefs = facts.defs.filter((d) => d.exported);
	const exports = exportedDefs.map((d) => d.name);
	const exportLines: Record<string, number> = {};
	const exportRanges: Record<string, { startLine: number; endLine: number }> =
		{};
	for (const d of exportedDefs) {
		exportLines[d.name] = d.startLine;
	}
	// `exports` and `exportLines` stay exported-only — the "a JVM/.NET member is
	// not a file-level module export" contract must not change. `exportRanges`
	// is widened to ALL defs for java/kotlin/csharp so `context_pack` can return
	// a real member span instead of the "internal symbol — span unavailable"
	// placeholder (issue #1529, RC-7).
	//
	// The widening is language-scoped because only JVM/.NET members are wanted
	// in `exportRanges`: admitting every non-exported def for other grammars
	// would put private TypeScript/Python/Rust/Go helpers into a persisted,
	// schema-validated graph field for no benefit. Non-widened grammars keep the
	// original exported-only, unconditionally-assigned behavior, so their
	// payloads are unchanged.
	//
	// The duplicate-name policy below is likewise scoped, and mirrors
	// `exportLines` rather than diverging from it: among EXPORTED defs both maps
	// take the last, so they cannot disagree; among non-exported defs (which
	// never reach `exportLines`) the first wins, so a constructor or a later
	// overload cannot displace its enclosing type.
	const isWidenedGrammar = JVM_DOTNET_RANGE_GRAMMARS.has(grammarId);
	// Tracks whether the def currently holding each `exportRanges` slot was
	// exported. Widening admits non-exported members, so without this an
	// unexported member could outrank the exported symbol of the same name.
	const rangeIsExported: Record<string, boolean> = {};
	for (const d of isWidenedGrammar ? facts.defs : exportedDefs) {
		// Only the widened path needs this. validateGraphNode THROWS on a
		// non-positive or inverted range and runs during the scan, so one
		// malformed def would abort a whole graph build now that non-exported
		// defs reach this map. Non-widened grammars deliberately keep the
		// pre-existing throw-on-malformed behavior so their payloads stay
		// byte-identical.
		if (
			isWidenedGrammar &&
			(!Number.isInteger(d.startLine) ||
				!Number.isInteger(d.endLine) ||
				d.startLine < 1 ||
				d.endLine < d.startLine)
		) {
			continue;
		}
		const next = { startLine: d.startLine, endLine: d.endLine };
		const prev = exportRanges[d.name];
		if (isWidenedGrammar && prev !== undefined) {
			const prevExported = rangeIsExported[d.name] === true;
			if (d.exported !== prevExported) {
				// Exported wins outright. `exportLines` is exported-only, so letting
				// a non-exported member hold the slot desyncs the two maps and makes
				// context_pack serve a private member's body under the exported name
				// (a Kotlin `class A { fun process() }` displacing the top-level
				// `fun process()`).
				if (!d.exported) continue;
			} else if (d.exported) {
				// Two exported defs of the same name (a C# partial class, or a
				// re-declared type): fall through and let the LAST one win, exactly
				// as the exported-only `exportLines` above does. Diverging here is
				// what made `exportRanges` point at the first partial while
				// `exportLines` pointed at the second.
			} else {
				// Two non-exported defs: keep the first in document order, so a
				// constructor or a later overload cannot displace its type. These
				// never appear in `exportLines`, so there is nothing to stay in sync
				// with.
				continue;
			}
		}
		exportRanges[d.name] = next;
		rangeIsExported[d.name] = d.exported;
	}
	const exportsSet = new Set(exports);
	const isPythonPackageInit =
		grammarId === 'python' &&
		['__init__.py', '__init__.pyw'].includes(path.basename(filePath));
	for (const imp of facts.imports) {
		const packageInitBindings =
			isPythonPackageInit && imp.bindings.length > 0
				? imp.bindings
						.filter((binding) => !binding.local.startsWith('_'))
						.map((binding) => ({
							imported: binding.imported,
							exported: binding.local,
						}))
				: [];
		const exportedBindings =
			imp.reExport && imp.exportedBindings
				? imp.exportedBindings
				: packageInitBindings;
		if (exportedBindings.length === 0) continue;
		for (const binding of exportedBindings) {
			if (binding.imported === '*') {
				// Include namespace re-export name in exports for dead_exports
				// visibility, but skip per-symbol edge creation (conservative).
				if (!exportsSet.has(binding.exported)) {
					exportsSet.add(binding.exported);
					exports.push(binding.exported);
				}
				if (
					imp.startLine !== undefined &&
					exportLines[binding.exported] === undefined
				) {
					exportLines[binding.exported] = imp.startLine;
				}
				if (
					imp.startLine !== undefined &&
					imp.endLine !== undefined &&
					exportRanges[binding.exported] === undefined
				) {
					exportRanges[binding.exported] = {
						startLine: imp.startLine,
						endLine: imp.endLine,
					};
				}
				continue;
			}
			if (!exportsSet.has(binding.exported)) {
				exportsSet.add(binding.exported);
				exports.push(binding.exported);
			}
			if (
				imp.startLine !== undefined &&
				exportLines[binding.exported] === undefined
			) {
				exportLines[binding.exported] = imp.startLine;
			}
			if (
				imp.startLine !== undefined &&
				imp.endLine !== undefined &&
				exportRanges[binding.exported] === undefined
			) {
				exportRanges[binding.exported] = {
					startLine: imp.startLine,
					endLine: imp.endLine,
				};
			}
		}
	}

	// Derive imports list from tree-sitter facts
	const imports = facts.imports.map((i) => i.specifier);

	const moduleName = toModuleName(filePath, absoluteRoot);
	const language = grammarId;

	const node: GraphNode = {
		filePath,
		moduleName,
		exports,
		...(Object.keys(exportLines).length > 0 ? { exportLines } : {}),
		...(Object.keys(exportRanges).length > 0 ? { exportRanges } : {}),
		imports,
		language,
		mtime: fileStats.mtime.toISOString(),
		sizeBytes: fileStats.size,
		mtimeMs: fileStats.mtimeMs,
		ontology: _internals.extractFileOntology({
			moduleName,
			filePath,
			content,
			language,
			exports,
			imports,
			hasManifest,
		}),
	};

	// Build GraphEdges from imports, using refs to derive usedSymbols
	const edges: GraphEdge[] = [];
	const sortedImports = [...facts.imports].sort((a, b) =>
		a.specifier.localeCompare(b.specifier),
	);

	for (const imp of sortedImports) {
		// Map tree-sitter 'commonjs' to graph-edge 'require' for consistency
		const edgeImportType: GraphEdge['importType'] =
			imp.importType === 'commonjs' ? 'require' : imp.importType;

		const resolvedTarget = resolveModuleSpecifier(
			absoluteRoot,
			filePath,
			imp.specifier,
		);

		if (resolvedTarget !== null) {
			// Re-exports expose the imported symbol to downstream consumers, so
			// named re-export bindings count as used even without a body ref.
			const usedBindings = imp.reExport
				? imp.bindings
				: imp.bindings.filter((b) =>
						facts.refs.some((r) => r.identifier === b.local),
					);
			// Match sync buildWorkspaceGraph semantics: namespace and require
			// imports omit usedSymbols entirely; named/default imports always
			// include the array (possibly empty) so toEqual comparisons are stable.
			const includeUsedSymbols =
				edgeImportType !== 'namespace' &&
				edgeImportType !== 'require' &&
				edgeImportType !== 'sideeffect';
			const usedSymbols = includeUsedSymbols
				? usedBindings.map((b) => b.imported)
				: undefined;

			edges.push({
				source: filePath,
				target: resolvedTarget,
				importSpecifier: imp.specifier,
				importType: edgeImportType,
				importedSymbols: imp.bindings.map((b) => b.imported),
				...(usedSymbols !== undefined ? { usedSymbols } : {}),
				targetKind: isScannableSourcePath(resolvedTarget) ? 'node' : 'asset',
			});
		}
	}
	const unresolvedImports = sortedImports
		.filter((imp) => isRelativeImportSpecifier(imp.specifier))
		.filter(
			(imp) =>
				resolveModuleSpecifier(absoluteRoot, filePath, imp.specifier) === null,
		)
		.map((imp) => ({
			file: moduleName,
			specifier: imp.specifier,
		}));

	// Build SymbolEdges from refs: when a ref's identifier matches a local
	// binding, resolve that binding's specifier to a target file and emit
	// a symbol→symbol edge.
	const symbolEdges: SymbolEdge[] = [];
	const localToImported = new Map<
		string,
		{ specifier: string; imported: string }
	>();
	for (const imp of facts.imports) {
		if (imp.reExport) continue;
		for (const binding of imp.bindings) {
			localToImported.set(binding.local, {
				specifier: imp.specifier,
				imported: binding.imported,
			});
		}
	}

	const seenSymbolEdgeKeys = new Set<string>();
	for (const ref of facts.refs) {
		const mapping = localToImported.get(ref.identifier);
		if (!mapping) continue;

		const resolvedTarget = resolveModuleSpecifier(
			absoluteRoot,
			filePath,
			mapping.specifier,
		);
		if (!resolvedTarget) continue;

		const fromSymbol = ref.enclosingDecl ?? '<module>';
		const key =
			filePath +
			'\u0000' +
			fromSymbol +
			'\u0000' +
			resolvedTarget +
			'\u0000' +
			mapping.imported;
		if (seenSymbolEdgeKeys.has(key)) continue;
		seenSymbolEdgeKeys.add(key);

		symbolEdges.push({
			fromFile: filePath,
			fromSymbol,
			toFile: resolvedTarget,
			toSymbol: mapping.imported,
		});
	}
	for (const imp of facts.imports) {
		const packageInitBindings =
			isPythonPackageInit && imp.bindings.length > 0
				? imp.bindings
						.filter((binding) => !binding.local.startsWith('_'))
						.map((binding) => ({
							imported: binding.imported,
							exported: binding.local,
						}))
				: [];
		const exportedBindings =
			imp.reExport && imp.exportedBindings
				? imp.exportedBindings
				: packageInitBindings;
		if (exportedBindings.length === 0) continue;
		const resolvedTarget = resolveModuleSpecifier(
			absoluteRoot,
			filePath,
			imp.specifier,
		);
		if (!resolvedTarget) continue;
		for (const binding of exportedBindings) {
			if (binding.imported === '*') continue;
			const key =
				filePath +
				'\u0000' +
				binding.exported +
				'\u0000' +
				resolvedTarget +
				'\u0000' +
				binding.imported;
			if (seenSymbolEdgeKeys.has(key)) continue;
			seenSymbolEdgeKeys.add(key);

			symbolEdges.push({
				fromFile: filePath,
				fromSymbol: binding.exported,
				toFile: resolvedTarget,
				toSymbol: binding.imported,
			});
		}
	}

	return {
		node,
		edges,
		symbolEdges,
		diagnostics:
			unresolvedImports.length > 0 ? { unresolvedImports } : undefined,
	};
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
		_absoluteRoot: absoluteRoot,
	};
	const walked = findSourceFiles(absoluteRoot, stats, {
		walkBudgetMs,
		maxFiles,
		followSymlinks,
		excludeDirs: options?.excludeDirs,
	});
	const sourceFiles = walked.files;
	const walkCtx = walked.ctx;

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

	// Manifest-directory closure for the generic package-boundary rule (A8).
	// Built once from the walk context; passed to every ontology extraction.
	const hasManifest = (relDir: string) => walkCtx.manifestDirs.has(relDir);

	// Process each file to extract nodes and edges. Edge dedup is tracked in a
	// loop-local Set (O(1)) instead of addEdge's O(edges) linear scan, and nodes
	// go straight in via appendNodeFast — metadata is computed once below. This
	// keeps construction O(N) on large repos (issue #1144).
	const seenEdges = new Set<string>();
	const syncDiagnostics: FilledDiagnostics = createEmptyDiagnostics();
	for (const witness of walkCtx.manifestWitnesses) {
		pushInputWitness(syncDiagnostics.extractorInputWitnesses, witness);
	}
	for (const filePath of sourceFiles) {
		let content: string;
		let fileStats: fsSync.Stats;

		try {
			fileStats = fsSync.statSync(filePath);
			if (fileStats.size > maxFileSize) {
				stats.skippedFiles++;
				pushCapped(
					syncDiagnostics.oversizedFiles,
					toModuleName(filePath, absoluteRoot),
				);
				pushInputWitness(syncDiagnostics.extractorInputWitnesses, {
					file: toModuleName(filePath, absoluteRoot),
					kind: 'stable-skip',
					sizeBytes: fileStats.size,
					mtimeMs: fileStats.mtimeMs,
				});
				continue;
			}
			content = fsSync.readFileSync(filePath, 'utf-8');
		} catch {
			stats.skippedFiles++;
			pushCapped(
				syncDiagnostics.unreadableFiles,
				toModuleName(filePath, absoluteRoot),
			);
			continue;
		}

		// Skip binary files
		if (isBinaryContent(content)) {
			stats.skippedFiles++;
			pushCapped(
				syncDiagnostics.binaryFiles,
				toModuleName(filePath, absoluteRoot),
			);
			pushInputWitness(syncDiagnostics.extractorInputWitnesses, {
				file: toModuleName(filePath, absoluteRoot),
				kind: 'stable-skip',
				sizeBytes: fileStats.size,
				mtimeMs: fileStats.mtimeMs,
			});
			continue;
		}

		stats.filesScanned++;

		// Extract symbol exports based on file extension. Mirrors scanFile() so
		// the sync and async builders stay byte-for-byte equivalent (issue #1144).
		const ext = path.extname(filePath).toLowerCase();
		let exports: string[] = [];
		let exportLines: Record<string, number> = {};
		let parsedImports: ParsedImport[] = [];

		try {
			if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
				const relativePath = path.relative(absoluteRoot, filePath);
				({ exports, exportLines } = collectExports(
					_internals.extractTSSymbols(relativePath, absoluteRoot),
				));
			} else if (ext === '.py' || ext === '.pyw') {
				const relativePath = path.relative(absoluteRoot, filePath);
				({ exports, exportLines } = collectExports(
					_internals.extractPythonSymbols(relativePath, absoluteRoot),
				));
			} else if (ext === '.rs') {
				const relativePath = path.relative(absoluteRoot, filePath);
				({ exports, exportLines } = collectExports(
					_internals.extractRustSymbols(relativePath, absoluteRoot),
				));
			} else if (ext === '.go') {
				const relativePath = path.relative(absoluteRoot, filePath);
				({ exports, exportLines } = collectExports(
					_internals.extractGoSymbols(relativePath, absoluteRoot),
				));
			}

			parsedImports = _internals.parseFileImports(
				content,
				filePath,
				absoluteRoot,
			);
		} catch {
			// Skip malformed file without aborting entire graph build
			continue;
		}

		const strippedForUsage =
			parsedImports.length > 0 ? _internals.stripComments(content) : '';

		const moduleName = toModuleName(filePath, absoluteRoot);
		const language = getLanguage(filePath);
		const node: GraphNode = {
			filePath,
			moduleName,
			exports,
			...(Object.keys(exportLines).length > 0 ? { exportLines } : {}),
			imports: parsedImports.map((p) => p.specifier),
			language,
			mtime: fileStats.mtime.toISOString(),
			sizeBytes: fileStats.size,
			mtimeMs: fileStats.mtimeMs,
			ontology: _internals.extractFileOntology({
				moduleName,
				filePath,
				content,
				language,
				exports,
				imports: parsedImports.map((p) => p.specifier),
				hasManifest,
			}),
		};

		// A node that fails validation (e.g. control characters in ontology
		// evidence extracted from a minified/generated file) must skip that one
		// file, not abort the whole graph build (issue #1448). Drop it entirely —
		// no node, no edges — and account it as skipped rather than scanned.
		try {
			appendNodeFast(graph, node);
		} catch {
			stats.filesScanned--;
			stats.skippedFiles++;
			pushCapped(syncDiagnostics.validationSkippedFiles, moduleName);
			pushInputWitness(syncDiagnostics.extractorInputWitnesses, {
				file: moduleName,
				kind: 'stable-skip',
				sizeBytes: fileStats.size,
				mtimeMs: fileStats.mtimeMs,
			});
			continue;
		}

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
				const usedSymbols = usedSymbolsForImport(parsed, strippedForUsage);
				const edge: GraphEdge = {
					source: filePath,
					target: resolvedTarget,
					importSpecifier: parsed.specifier,
					importType: parsed.importType,
					importedSymbols: parsed.importedSymbols,
					...(usedSymbols !== undefined ? { usedSymbols } : {}),
					targetKind: isScannableSourcePath(resolvedTarget) ? 'node' : 'asset',
				};
				// The node is already valid; an individual invalid edge (e.g. a
				// control character in an import specifier) drops just that edge
				// rather than aborting the build (issue #1448).
				try {
					appendEdgeFast(graph, edge, seenEdges);
				} catch {
					/* skip malformed edge */
				}
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

	// Surface walk-truncation diagnostics (defect A7) so getGraphHealth can
	// report an INCOMPLETE graph instead of confidently wrong results.
	syncDiagnostics.walkTruncated = stats.truncated;
	syncDiagnostics.walkTruncationReason = walkCtx.abortReason;
	if (diagnosticsHaveEntries(syncDiagnostics)) {
		graph.diagnostics = syncDiagnostics;
	}

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
		_absoluteRoot: absoluteRoot,
	};
	const diagnostics = createEmptyDiagnostics();

	const walked = await walkRepoGraphInputs(absoluteRoot, {
		walkBudgetMs,
		maxFiles,
		followSymlinks,
		excludeDirs: options?.excludeDirs,
		captureManifestMetadata: true,
	});
	const sourceFiles = walked.sourceFiles;
	stats.truncated = walked.truncated;
	for (const input of walked.metadata) {
		if (input.kind !== 'manifest') continue;
		const relative = toModuleName(input.absolutePath, absoluteRoot);
		pushInputWitness(diagnostics.extractorInputWitnesses, {
			file: relative,
			kind: 'manifest',
			sizeBytes: input.sizeBytes,
			mtimeMs: input.mtimeMs,
		});
	}

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

	// Manifest-directory closure for the generic package-boundary rule (A8).
	const hasManifest = (relDir: string) => walked.manifestDirs.has(relDir);

	// Edge dedup tracked in a loop-local Set (O(1)); nodes inserted via
	// appendNodeFast — metadata is computed once below. Keeps construction O(N)
	// on large repos. Async file reads yield naturally, and the smaller explicit
	// scan interval bounds event-loop monopolization even when symbol extraction
	// or its fail-open fallback resolves synchronously (issues #704 and #1144).
	const seenEdges = new Set<string>();
	const seenSymbolEdges = new Set<string>();
	const allSymbolEdges: SymbolEdge[] = [];
	let processedSinceYield = 0;
	for (const filePath of sourceFiles) {
		const result = await scanFileAsync(
			filePath,
			absoluteRoot,
			maxFileSize,
			hasManifest,
		);
		mergeDiagnostics(diagnostics, result.diagnostics);
		if (result.inputWitness) {
			pushInputWitness(
				diagnostics.extractorInputWitnesses,
				result.inputWitness,
			);
		}
		if (result.node) {
			// A node that fails validation (e.g. control characters in ontology
			// evidence from a minified/generated file) must skip that one file,
			// not abort the whole graph build (issue #1448). This is the path the
			// startup hook uses, so it is the one the reported crash hits.
			let appended = false;
			try {
				appendNodeFast(graph, result.node);
				appended = true;
			} catch {
				stats.skippedFiles++;
				pushCapped(diagnostics.validationSkippedFiles, result.node.moduleName);
				pushInputWitness(diagnostics.extractorInputWitnesses, {
					file: result.node.moduleName,
					kind: 'stable-skip',
					sizeBytes: result.node.sizeBytes as number,
					mtimeMs: result.node.mtimeMs as number,
				});
			}
			if (appended) {
				for (const edge of result.edges) {
					// Node already valid; drop only an individual invalid edge.
					try {
						appendEdgeFast(graph, edge, seenEdges);
					} catch {
						/* skip malformed edge */
					}
				}
				// Aggregate symbolEdges across all files (dedup)
				for (const symbolEdge of result.symbolEdges) {
					const key =
						symbolEdge.fromFile +
						'\u0000' +
						symbolEdge.fromSymbol +
						'\u0000' +
						symbolEdge.toFile +
						'\u0000' +
						symbolEdge.toSymbol;
					if (!seenSymbolEdges.has(key)) {
						seenSymbolEdges.add(key);
						allSymbolEdges.push(symbolEdge);
					}
				}
				stats.filesScanned++;
			}
		} else {
			stats.skippedFiles++;
		}
		processedSinceYield++;
		if (processedSinceYield % ASYNC_SCAN_YIELD_INTERVAL === 0) {
			await yieldToEventLoop();
		}
	}

	graph.metadata = {
		generatedAt: new Date().toISOString(),
		generator: 'repo-graph',
		nodeCount: Object.keys(graph.nodes).length,
		edgeCount: graph.edges.length,
	};

	// Attach symbolEdges when present (schema >= 1.2.0); keep additive.
	if (allSymbolEdges.length > 0) {
		graph.symbolEdges = allSymbolEdges;
	}
	// Surface walk-truncation diagnostics (defect A7) — walk-level fields are
	// set once after the walk, NOT merged per-file (extraction diagnostics are).
	diagnostics.walkTruncated = stats.truncated;
	diagnostics.walkTruncationReason = walked.truncationReason;
	graph.diagnostics = diagnosticsHaveEntries(diagnostics)
		? diagnostics
		: createEmptyDiagnostics();

	if (stats.skippedFiles > 0 || stats.skippedDirs > 0 || stats.truncated) {
		logger.log(
			`[repo-graph] Scan stats: ${stats.filesScanned} files scanned, ` +
				`${stats.skippedFiles} files skipped, ${stats.skippedDirs} dirs skipped` +
				(stats.truncated ? ', TRUNCATED' : ''),
		);
	}

	return graph;
}
