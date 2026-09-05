/**
 * Repo Graph Builder Hook
 *
 * Startup hook that builds or refreshes the repo dependency graph when a session starts.
 * Write-trigger hook that incrementally updates the graph when write tools are called.
 * Wrapped in try/catch — failures are logged but never block plugin initialization.
 *
 * Issue #704: the previous implementation called the synchronous
 * `buildWorkspaceGraph` from inside an `async init()`. JS executes async
 * function bodies synchronously up to the first `await`, so calling
 * `init()` blocked the entire event loop on the recursive workspace scan,
 * preventing the plugin host's `await server(...)` from ever resolving and
 * hanging the OpenCode Desktop loading screen indefinitely. The fix wires
 * the async builder, yields to the event loop before doing any work, and
 * exposes the init promise so `toolAfter` can serialize incremental
 * updates after the initial scan completes.
 *
 * Issue #2472 (REPOGRAPH-1): `toolAfter` runs its entire cheap synchronous
 * filter chain (enabled flag, write-tool membership, path extraction and
 * validation, exclude-dir scoping) BEFORE awaiting the init promise, so a
 * non-write tool call settles immediately even while the startup scan is
 * pending — only write tools that will actually mutate the graph wait for
 * the scan. The startup scan itself is bounded by an overall wall-clock
 * budget (STARTUP_SCAN_BUDGET_MS) that resolves fail-open on timeout.
 */

import * as path from 'node:path';
import { WRITE_TOOL_NAMES } from '../config/constants';
import {
	type BuildWorkspaceGraphOptions,
	buildWorkspaceGraphAsync,
	isScannableSourcePath,
	loadGraph,
	type RepoGraph,
	saveGraph,
	updateGraphForFiles,
} from '../tools/repo-graph';
import { isGraphWideInputPath } from '../tools/repo-graph/builder';
import {
	type FreshnessOptions,
	type FreshnessProbe,
	probeFreshness,
	writeFingerprint,
} from '../tools/repo-graph/freshness';
import { safeRealpathSync } from '../tools/repo-graph/safe-realpath';
import * as logger from '../utils/logger';
import { withTimeout, yieldToEventLoop } from '../utils/timeout';

export interface RepoGraphBuilderHook {
	init(): Promise<void>;
	toolAfter(
		input: { tool: string; sessionID: string; args?: unknown },
		output: { output?: unknown; args?: unknown },
	): Promise<void>;
}

/**
 * Overall wall-clock budget for the startup repo-graph scan (issue #2472
 * REPOGRAPH-1 / AC-2). The walker's own per-walk budget (`walkBudgetMs` /
 * DEFAULT_WALK_BUDGET_MS in `src/tools/repo-graph/builder.ts`) bounds a single
 * directory walk, but the full startup scan (load → freshness probe → rebuild
 * or incremental refresh) previously had no overall ceiling: a slow or wedged
 * workspace could leave `initPromise` pending forever. Racing the whole scan
 * against this budget keeps init settlement bounded; on timeout the hook logs
 * a warning and resolves fail-open (no graph saved; incremental write updates
 * proceed; the next session retries the scan).
 */
const STARTUP_SCAN_BUDGET_MS = 30_000;

export interface RepoGraphDeps {
	buildWorkspaceGraph: (
		workspace: string,
		options?: BuildWorkspaceGraphOptions,
	) => Promise<RepoGraph>;
	saveGraph: (
		workspace: string,
		graph: RepoGraph,
		options?: { createAtomic?: boolean },
	) => Promise<void>;
	updateGraphForFiles: (
		workspace: string,
		files: string[],
		options?: {
			forceRebuild?: boolean;
			buildOptions?: BuildWorkspaceGraphOptions;
		},
	) => Promise<RepoGraph>;
	loadGraph: (workspace: string) => Promise<RepoGraph | null>;
	probeFreshness: (
		workspace: string,
		options?: FreshnessOptions,
	) => Promise<FreshnessProbe>;
	writeFingerprint: (
		workspace: string,
		graph: RepoGraph,
		options?: FreshnessOptions,
	) => Promise<boolean>;
	isGraphWideInputPath: (filePath: string) => boolean;
	safeRealpathSync?: typeof safeRealpathSync;
}

export interface RepoGraphBuilderOptions {
	enabled?: boolean;
	initRefresh?: boolean;
	refreshCap?: number;
	maxFiles?: number;
	walkBudgetMs?: number;
	excludeDirs?: readonly string[];
	/**
	 * Overall wall-clock budget (ms) for the startup scan (issue #2472).
	 * Defaults to STARTUP_SCAN_BUDGET_MS. Additive DI/test knob so the
	 * fail-open timeout path can be exercised without waiting 30 s.
	 */
	scanBudgetMs?: number;
}

function extractFilePath(args: unknown): string | null {
	if (!args || typeof args !== 'object') return null;
	const a = args as Record<string, unknown>;
	let filePath = (a.file_path ?? a.path ?? a.filePath) as string | undefined;
	if (!filePath || typeof filePath !== 'string') return null;

	// Decode URL-encoded paths (up to 3 iterations for double-encoded paths)
	for (let i = 0; i < 3; i++) {
		try {
			const decoded = decodeURIComponent(filePath);
			if (decoded === filePath) break;
			filePath = decoded;
		} catch {
			break;
		}
	}

	// Normalize Unicode lookalike characters to ASCII equivalents
	filePath = filePath
		.replace(/．/g, '.')
		.replace(/／/g, '/')
		.replace(/․/g, '.');

	return filePath;
}

/**
 * Whether `filePath` is a scannable source file the graph tracks. Delegates to
 * the single shared {@link isScannableSourcePath} (issue #1985, defect A2) so
 * the write hook's allowlist can never drift from the builder's
 * LANGUAGE_REGISTRY-derived set — picking up `.rs`/`.go`/`.pyw` automatically.
 */
function isSupportedSourceFile(filePath: string): boolean {
	return isScannableSourcePath(filePath);
}

/**
 * Rebase a realpath'd file onto the lexical workspace root so the incremental
 * update keys the same node the walk produced (issue #1985, defect A5). Exported
 * for direct unit testing of the symlink-root rebase logic.
 *
 * The walk keys nodes lexically relative to `workspaceRoot` (realpath is used
 * only as a cycle-break key). When the workspace root itself is a symlink
 * (`workspaceRoot` → `realWorkspace`), a realpath'd file (`realFilePath`) lives
 * under `realWorkspace` and would key a DIFFERENT node than the lexical path the
 * walker would have produced — causing a duplicate node.
 *
 * If `realFilePath` is under `realWorkspace`, rebase its workspace-relative tail
 * onto the lexical `workspaceRoot` (reconstructing the lexical absolute path the
 * walker used). Otherwise (case-insensitive aliasing without a symlinked root,
 * or an unexpected layout) return `realFilePath` so the case-folding benefit of
 * the realpath is preserved.
 */
export function rebaseOntoWorkspace(
	realFilePath: string,
	realWorkspace: string,
	workspaceRoot: string,
): string {
	// Normalize separators for a reliable prefix comparison.
	const normRealFile = realFilePath.replace(/\\/g, '/');
	const normRealWs = realWorkspace.replace(/\\/g, '/');
	if (
		normRealFile !== normRealWs &&
		!normRealFile.startsWith(`${normRealWs}/`)
	) {
		// Not under the real workspace — keep the realpath (best effort).
		return realFilePath;
	}
	// Do not use the physical project-root identity here. A symlink/junction
	// workspace root is intentionally physically equal to `realWorkspace`, but
	// the graph walker stores lexical paths. Only skip rebasing when the two
	// roots are textually the same (apart from separator/case normalization).
	const normalizeLexicalPath = (value: string): string => {
		const normalized = path.resolve(value).replace(/\\/g, '/');
		return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
	};
	if (
		normalizeLexicalPath(workspaceRoot) === normalizeLexicalPath(realWorkspace)
	) {
		return realFilePath;
	}
	// Rebase the workspace-relative tail of the realpath'd file onto the
	// lexical workspace root, reconstructing the path the walker produced.
	const rel = normRealFile.slice(
		normRealWs.length + (normRealFile === normRealWs ? 0 : 1),
	);
	return path.join(workspaceRoot, rel);
}

export function createRepoGraphBuilderHook(
	workspaceRoot: string,
	deps?: Partial<RepoGraphDeps>,
	options?: RepoGraphBuilderOptions,
): RepoGraphBuilderHook {
	const _buildWorkspaceGraph =
		deps?.buildWorkspaceGraph ?? buildWorkspaceGraphAsync;
	const _saveGraph = deps?.saveGraph ?? saveGraph;
	const _updateGraphForFiles = deps?.updateGraphForFiles ?? updateGraphForFiles;
	const _loadGraph = deps?.loadGraph ?? loadGraph;
	const _probeFreshness = deps?.probeFreshness ?? probeFreshness;
	const _writeFingerprint = deps?.writeFingerprint ?? writeFingerprint;
	const _isGraphWideInputPath =
		deps?.isGraphWideInputPath ?? isGraphWideInputPath;
	const _safeRealpathSync = deps?.safeRealpathSync ?? safeRealpathSync;
	const _enabled = options?.enabled ?? true;
	const _initRefresh = options?.initRefresh ?? true;
	const _refreshCap = options?.refreshCap ?? 50;
	const _maxFiles = options?.maxFiles ?? 10_000;
	const _walkBudgetMs = options?.walkBudgetMs ?? 5_000;
	const _scanBudgetMs = options?.scanBudgetMs ?? STARTUP_SCAN_BUDGET_MS;

	// User-configured directory excludes (issue #1448). Empty entries are
	// dropped; the Set is used both to scope the initial scan and to keep
	// incremental write-triggered updates consistent with the scan.
	const _excludeDirs = (options?.excludeDirs ?? []).filter((d) => d.length > 0);
	const _excludeDirSet = new Set<string>(_excludeDirs);
	const _buildOptions: BuildWorkspaceGraphOptions = {
		excludeDirs: _excludeDirs,
		...(options?.maxFiles === undefined ? {} : { maxFiles: _maxFiles }),
		...(options?.walkBudgetMs === undefined
			? {}
			: { walkBudgetMs: _walkBudgetMs }),
	};
	const _hasConfiguredBuildOptions =
		options?.maxFiles !== undefined ||
		options?.walkBudgetMs !== undefined ||
		options?.excludeDirs !== undefined;
	const _freshnessOptions: FreshnessOptions = {
		maxFiles: _maxFiles,
		walkBudgetMs: _walkBudgetMs,
		excludeDirs: _excludeDirs,
	};

	let initStarted = false;
	let initPromise: Promise<void> = Promise.resolve();

	// Per-session incremental-update failure tracking (AGENTS.md invariant 8:
	// session state must be keyed by sessionID, bounded, and decay). A single
	// shared counter (the previous implementation) mixed failures across
	// sessions and, once it crossed the threshold, fired the advisory on every
	// subsequent call forever — even after transient causes (disk full, a brief
	// permission glitch) cleared. This map is keyed by sessionID, FIFO-bounded,
	// time-decayed so an old failure streak resets, and cooldown-gated so the
	// advisory is not spammed.
	const FAILURE_ADVISORY_THRESHOLD = 3;
	const FAILURE_DECAY_MS = 5 * 60 * 1000; // streak resets after 5 min idle
	const ADVISORY_COOLDOWN_MS = 60 * 1000; // at most one advisory per minute/session
	const MAX_TRACKED_SESSIONS = 100;
	interface FailureState {
		failures: number;
		lastFailureAt: number;
		lastAdvisoryAt: number;
	}
	const failuresBySession = new Map<string, FailureState>();

	// PRR-003 / PR #2588 bot finding 4 — stale-overwrite guard: monotonic
	// generation of graph saves for THIS workspace. A full scan captures the
	// current value before its (possibly long) build starts and re-checks it
	// immediately before the persist call; if any newer save landed in
	// between — a successful incremental write update, or the fail-open
	// settle of a timed-out startup scan — the scan's result is stale and its
	// save is skipped (debug-gated log) instead of overwriting the newer
	// on-disk state. Deliberately instance-scoped (not module-level): saves
	// are per-workspace, and a process-wide counter would let one
	// workspace's saves spuriously suppress another workspace's pending
	// full scan.
	let graphSaveGeneration = 0;

	function recordSuccess(sessionID: string): void {
		failuresBySession.delete(sessionID);
	}

	function recordFailure(
		sessionID: string,
		now: number,
	): { count: number; advise: boolean } {
		let state = failuresBySession.get(sessionID);
		// Decay: a failure long after the previous one starts a fresh streak.
		if (state && now - state.lastFailureAt > FAILURE_DECAY_MS) {
			failuresBySession.delete(sessionID);
			state = undefined;
		}
		if (!state) {
			// FIFO eviction keeps the map bounded across many sessions.
			if (failuresBySession.size >= MAX_TRACKED_SESSIONS) {
				const oldest = failuresBySession.keys().next().value;
				if (oldest !== undefined) failuresBySession.delete(oldest);
			}
			state = { failures: 0, lastFailureAt: 0, lastAdvisoryAt: 0 };
			failuresBySession.set(sessionID, state);
		}
		state.failures += 1;
		state.lastFailureAt = now;
		let advise = false;
		if (
			state.failures >= FAILURE_ADVISORY_THRESHOLD &&
			now - state.lastAdvisoryAt >= ADVISORY_COOLDOWN_MS
		) {
			advise = true;
			state.lastAdvisoryAt = now;
		}
		return { count: state.failures, advise };
	}

	async function rebuildGraph(reason: string): Promise<void> {
		// Announce the scan when it STARTS (issue #2472 / AC-2), not only at
		// completion, so a slow or wedged scan is visible from its beginning.
		logger.log(`[repo-graph] Scan start: building workspace graph (${reason})`);
		// Capture the save generation BEFORE the build: the build can
		// outlive the startup budget (a zombie scan whose doInit promise is
		// still running after runBoundedInit settled fail-open), and any
		// save that lands while it runs makes this scan's result stale.
		const generationAtScanStart = graphSaveGeneration;
		const graph = await _buildWorkspaceGraph(workspaceRoot, _buildOptions);
		// Stale-overwrite guard (PRR-003 / bot finding 4): re-check
		// immediately before the persist call. A zombie scan that completes
		// after a newer incremental save (or after its own budget's fail-open
		// settle) must NOT overwrite the newer graph — skip both the save
		// and its freshness fingerprint, which certifies the graph that IS
		// on disk.
		if (graphSaveGeneration !== generationAtScanStart) {
			logger.log(
				`[repo-graph] Skipping graph save (${reason}): a newer graph save superseded this scan`,
			);
			return;
		}
		await _saveGraph(workspaceRoot, graph);
		const fingerprintWritten = await _writeFingerprint(
			workspaceRoot,
			graph,
			_freshnessOptions,
		);
		logger.log(
			`[repo-graph] Built graph (${reason}): ${graph.metadata.nodeCount} nodes, ${graph.metadata.edgeCount} edges`,
		);
		if (!fingerprintWritten) {
			logger.warn(
				'[repo-graph] Graph saved, but its freshness fingerprint could not be certified; the next session will rebuild it safely.',
			);
		}
	}

	function uniqueDriftFiles(probe: FreshnessProbe): string[] {
		return [...new Set([...probe.changed, ...probe.removed])];
	}

	function updateFiles(files: string[]): Promise<RepoGraph> {
		return _hasConfiguredBuildOptions
			? _updateGraphForFiles(workspaceRoot, files, {
					buildOptions: _buildOptions,
				})
			: _updateGraphForFiles(workspaceRoot, files);
	}

	async function doInit(): Promise<void> {
		// Yield once before any scan work so the caller's promise chain has
		// a chance to settle. Combined with the bounded async walker, this
		// guarantees the plugin host's `await server(...)` resolves promptly
		// even if the scan itself takes seconds.
		await yieldToEventLoop();
		try {
			if (!_initRefresh) {
				await rebuildGraph('configured legacy startup rebuild');
				return;
			}

			let graph: RepoGraph | null;
			try {
				graph = await _loadGraph(workspaceRoot);
			} catch (error) {
				if (
					error instanceof Error &&
					'code' in error &&
					(error as NodeJS.ErrnoException).code === 'CORRUPTION'
				) {
					await rebuildGraph('corrupt saved graph');
					return;
				}
				throw error;
			}

			if (!graph) {
				await rebuildGraph('no saved graph');
				return;
			}

			const probe = await _probeFreshness(workspaceRoot, _freshnessOptions);
			if (probe.state === 'clean' || probe.state === 'inconclusive') {
				logger.log(
					`[repo-graph] Startup freshness probe: ${probe.state}; no refresh`,
				);
				return;
			}
			if (probe.state === 'no-fingerprint') {
				await rebuildGraph('no compatible freshness fingerprint');
				return;
			}

			const driftFiles = uniqueDriftFiles(probe);
			if (driftFiles.length === 0) {
				logger.log(
					'[repo-graph] Startup freshness probe reported no drift files',
				);
				return;
			}

			const fullRebuildThreshold = Math.max(
				_refreshCap * 4,
				graph.metadata.nodeCount * 0.4,
			);
			const requiresGraphWideRebuild = driftFiles.some(_isGraphWideInputPath);
			if (
				requiresGraphWideRebuild ||
				driftFiles.length > fullRebuildThreshold
			) {
				await rebuildGraph(
					requiresGraphWideRebuild
						? 'graph-wide input drift'
						: `drift set exceeded ${fullRebuildThreshold} files`,
				);
				return;
			}

			const refreshed = await updateFiles(driftFiles);
			logger.log(
				`[repo-graph] Incrementally refreshed ${driftFiles.length} startup drift files: ${refreshed.metadata.nodeCount} nodes`,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (
				message.includes('does not exist') ||
				message.includes('Refusing to scan')
			) {
				// Workspace not present, or the homedir-refusal guard fired.
				// Both are expected non-fatal outcomes — log once at info
				// level and keep the plugin functional.
				logger.log(`[repo-graph] Skipping scan: ${message}`);
				return;
			}
			logger.error(`[repo-graph] Failed to build graph: ${message}`);
		}
	}

	/**
	 * Run the startup scan under the overall wall-clock budget
	 * (STARTUP_SCAN_BUDGET_MS, overridable via `options.scanBudgetMs`).
	 *
	 * On timeout — or, defensively, any unexpected `doInit` rejection — log a
	 * warning and RESOLVE fail-open: `initPromise` must always settle safely
	 * and never reject (callers await it from `toolAfter` and the detached
	 * post-resolution task queue). A timed-out scan's underlying `doInit`
	 * promise keeps running in the background (JS promises cannot be
	 * cancelled), but the fail-open settle bumps the save generation, so the
	 * zombie scan's eventual completion can never write a graph: its late
	 * `_saveGraph` is skipped, and a graph saved by any newer incremental
	 * write update (each of which also bumps the generation) is never
	 * overwritten by the stale scan result. Incremental write updates proceed
	 * as usual, and the next session retries the scan.
	 */
	async function runBoundedInit(): Promise<void> {
		try {
			await withTimeout(
				doInit(),
				_scanBudgetMs,
				new Error(
					`Startup repo-graph scan exceeded the ${_scanBudgetMs}ms wall-clock budget`,
				),
			);
		} catch (error) {
			// Invalidate any still-running zombie scan for this workspace:
			// its late save must not overwrite state saved after this
			// fail-open settle (PRR-003 / bot finding 4).
			graphSaveGeneration++;
			const message = error instanceof Error ? error.message : String(error);
			logger.warn(
				`[repo-graph] ${message}; giving up fail-open (no graph saved). ` +
					'Incremental write updates continue; the next session retries the scan.',
			);
		}
	}

	return {
		init(): Promise<void> {
			if (!_enabled) return Promise.resolve();
			if (!initStarted) {
				initStarted = true;
				initPromise = runBoundedInit();
			}
			return initPromise;
		},

		async toolAfter(
			input: { tool: string; sessionID: string; args?: unknown },
			_output: { output?: unknown; args?: unknown },
		): Promise<void> {
			// Cheap synchronous filters FIRST, before any repo-graph init await
			// (issue #2472 REPOGRAPH-1 / AC-1). The overwhelming majority of
			// toolAfter invocations are read/non-write calls (or writes to
			// non-source / excluded files) that will never touch the graph;
			// each must settle immediately even while the startup scan is
			// still pending. Awaiting initPromise before these filters
			// withheld every read call on a slow or wedged initial scan.
			if (!_enabled) return;

			if (!(WRITE_TOOL_NAMES as readonly string[]).includes(input.tool)) {
				return;
			}
			const filePath = extractFilePath(input.args);
			if (!filePath) return;
			if (filePath.includes('\0')) return;

			if (!isSupportedSourceFile(filePath)) return;

			// Keep incremental updates consistent with the initial scan: a write
			// to a file under a user-excluded directory must not re-add it to the
			// graph (issue #1448). Match by path segment, mirroring the basename
			// semantics of the scan's skip set.
			if (
				_excludeDirSet.size > 0 &&
				filePath.split(/[/\\]/).some((segment) => _excludeDirSet.has(segment))
			) {
				return;
			}

			// Init gate — reached only by write tools that survived the cheap
			// filters and will actually mutate the graph. Wait for the initial
			// scan before applying incremental updates: without this gate, an
			// early write tool could race the initial scan and stomp the saved
			// graph with a partial update. The `.catch(()=>{})` swallows any
			// init error so a failed initial scan does not poison every
			// subsequent tool call, and initPromise itself is budget-bounded
			// (runBoundedInit above), so this await can never hang forever.
			await initPromise.catch(() => {
				/* init failure is already logged */
			});

			const absoluteFilePath = path.isAbsolute(filePath)
				? filePath
				: path.resolve(workspaceRoot, filePath);

			// SECURITY: Resolve symlinks to get the real path, then verify the
			// real path is still within the workspace boundary. This prevents
			// symlink-based workspace escape attacks (mirrors the approach used
			// in resolveModuleSpecifier in repo-graph.ts).
			const realFilePath = _safeRealpathSync(
				absoluteFilePath,
				absoluteFilePath,
			);
			if (realFilePath === null) {
				return;
			}

			const realWorkspace = _safeRealpathSync(workspaceRoot, workspaceRoot);
			if (realWorkspace === null) {
				return;
			}

			const normalizedAbsolute = realFilePath.replace(/\\/g, '/');
			const normalizedWorkspace = realWorkspace.replace(/\\/g, '/');
			if (
				!normalizedAbsolute.startsWith(`${normalizedWorkspace}/`) &&
				normalizedAbsolute !== normalizedWorkspace
			) {
				return;
			}

			try {
				// Pass a path consistent with how the graph's node keys were
				// originally produced (issue #1985, defect A5). The walk keys
				// nodes lexically relative to `workspaceRoot` (it uses realpath
				// only as a cycle-break key, not for stored paths). To stay
				// consistent on case-insensitive filesystems AND through symlink
				// aliases (including a symlinked workspace root), rebase the
				// realpath'd file back onto the lexical workspace root: this
				// yields the same key the walker would have produced for a file
				// reached via the lexical root, while still resolving any
				// case/symlink aliasing of the file itself.
				const pathForUpdate = rebaseOntoWorkspace(
					realFilePath,
					realWorkspace,
					workspaceRoot,
				);
				await updateFiles([pathForUpdate]);
				// The incremental update just persisted a NEWER graph than any
				// full scan that started earlier — bump the save generation so
				// a still-running zombie scan's late save cannot overwrite it
				// (PRR-003 / bot finding 4).
				graphSaveGeneration++;
				recordSuccess(input.sessionID);
				logger.log(
					`[repo-graph] Incremental update for ${path.basename(filePath)}`,
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const { count, advise } = recordFailure(input.sessionID, Date.now());
				logger.error(`[repo-graph] Incremental update failed: ${message}`);
				if (advise) {
					logger.warn(
						`[repo-graph] ${count} consecutive incremental update failures. ` +
							`The dependency graph may be stale. Consider reloading the workspace.`,
					);
				}
			}
		},
	};
}
