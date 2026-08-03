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
 */

import * as path from 'node:path';
import { WRITE_TOOL_NAMES } from '../config/constants';
import {
	buildWorkspaceGraphAsync,
	isScannableSourcePath,
	type RepoGraph,
	saveGraph,
	updateGraphForFiles,
} from '../tools/repo-graph';
import { safeRealpathSync } from '../tools/repo-graph/safe-realpath';
import * as logger from '../utils/logger';
import { yieldToEventLoop } from '../utils/timeout';

export interface RepoGraphBuilderHook {
	init(): Promise<void>;
	toolAfter(
		input: { tool: string; sessionID: string; args?: unknown },
		output: { output?: unknown; args?: unknown },
	): Promise<void>;
}

export interface RepoGraphDeps {
	buildWorkspaceGraph: (
		workspace: string,
		options?: {
			maxFileSizeBytes?: number;
			maxFiles?: number;
			walkBudgetMs?: number;
			followSymlinks?: boolean;
			excludeDirs?: readonly string[];
		},
	) => Promise<RepoGraph>;
	saveGraph: (
		workspace: string,
		graph: RepoGraph,
		options?: { createAtomic?: boolean },
	) => Promise<void>;
	updateGraphForFiles: (
		workspace: string,
		files: string[],
		options?: { forceRebuild?: boolean },
	) => Promise<RepoGraph>;
	safeRealpathSync?: typeof safeRealpathSync;
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
	// Same lexical and real workspace root? Nothing to rebase; the realpath
	// already matches the walker's keys (modulo case, which realpath fixes).
	if (path.resolve(workspaceRoot) === path.resolve(realWorkspace)) {
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
	options?: { excludeDirs?: readonly string[] },
): RepoGraphBuilderHook {
	const _buildWorkspaceGraph =
		deps?.buildWorkspaceGraph ?? buildWorkspaceGraphAsync;
	const _saveGraph = deps?.saveGraph ?? saveGraph;
	const _updateGraphForFiles = deps?.updateGraphForFiles ?? updateGraphForFiles;
	const _safeRealpathSync = deps?.safeRealpathSync ?? safeRealpathSync;

	// User-configured directory excludes (issue #1448). Empty entries are
	// dropped; the Set is used both to scope the initial scan and to keep
	// incremental write-triggered updates consistent with the scan.
	const _excludeDirs = (options?.excludeDirs ?? []).filter((d) => d.length > 0);
	const _excludeDirSet = new Set<string>(_excludeDirs);

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

	async function doInit(): Promise<void> {
		// Yield once before any scan work so the caller's promise chain has
		// a chance to settle. Combined with the bounded async walker, this
		// guarantees the plugin host's `await server(...)` resolves promptly
		// even if the scan itself takes seconds.
		await yieldToEventLoop();
		try {
			const graph = await _buildWorkspaceGraph(workspaceRoot, {
				excludeDirs: _excludeDirs,
			});
			await _saveGraph(workspaceRoot, graph);
			logger.log(
				`[repo-graph] Built graph: ${graph.metadata.nodeCount} nodes, ${graph.metadata.edgeCount} edges`,
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

	return {
		init(): Promise<void> {
			if (!initStarted) {
				initStarted = true;
				initPromise = doInit();
			}
			return initPromise;
		},

		async toolAfter(
			input: { tool: string; sessionID: string; args?: unknown },
			_output: { output?: unknown; args?: unknown },
		): Promise<void> {
			// Wait for the initial scan before applying incremental updates.
			// Without this gate, an early write tool could race the initial
			// scan and stomp the saved graph with a partial update. The
			// `.catch(()=>{})` swallows any init error so a failed initial
			// scan does not poison every subsequent tool call.
			await initPromise.catch(() => {
				/* init failure is already logged */
			});

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
				await _updateGraphForFiles(workspaceRoot, [pathForUpdate]);
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
