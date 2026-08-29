/**
 * Shared hook utilities for OpenCode Swarm
 *
 * This module provides common utilities for working with hooks,
 * including error handling, handler composition, file I/O, and
 * token estimation for swarm-related operations.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { SwarmError, warn } from '../utils';
import { bunFile } from '../utils/bun-compat';
import { readCachedTextFile } from '../utils/swarm-artifact-cache';

/**
 * Test-only dependency-injection seam. Production code calls
 * `_internals.<fn>(...)` so tests can replace the function on this object
 * without touching the real module — `mock.module` from `bun:test` leaks
 * across files in Bun's shared test-runner process, which would corrupt
 * unrelated suites. Mutating this local object is file-scoped and
 * trivially restorable via `afterEach`.
 */
export const _internals: {
	safeHook: typeof safeHook;
	composeHandlers: typeof composeHandlers;
	validateSwarmPath: typeof validateSwarmPath;
	readSwarmFileAsync: typeof readSwarmFileAsync;
	readCachedTextFile: typeof readCachedTextFile;
} = {
	safeHook,
	composeHandlers,
	validateSwarmPath,
	readSwarmFileAsync,
	readCachedTextFile,
};

type HookHandler<I, O> = (input: I, output: O) => Promise<void>;

export function markFailClosed<I, O>(
	fn: HookHandler<I, O>,
): HookHandler<I, O> & { __failClosed?: true } {
	return Object.assign(fn, { __failClosed: true }) as HookHandler<I, O> & {
		__failClosed?: true;
	};
}

function isFailClosedHandler(value: unknown): boolean {
	return (
		typeof value === 'function' &&
		Object.hasOwn(value, '__failClosed') &&
		(value as { __failClosed?: boolean }).__failClosed === true
	);
}

export function safeHook<I, O>(fn: HookHandler<I, O>): HookHandler<I, O> {
	return async (input: I, output: O) => {
		try {
			await fn(input, output);
		} catch (_error) {
			const functionName = fn.name || 'unknown';
			if (_error instanceof SwarmError) {
				warn(
					`Hook '${functionName}' failed: ${_error.message}\n  → ${_error.guidance}`,
				);
			} else {
				warn(`Hook function '${functionName}' failed:`, _error);
			}
		}
	};
}

/**
 * `composeHandlers` runs handlers sequentially, wrapping EACH handler in
 * `safeHook` so any thrown error is downgraded to a warning. Use this for
 * advisory / telemetry / observer hooks where a failure must not block
 * tool execution.
 *
 * **DO NOT use this for fail-closed security or policy hooks.** A fail-closed
 * hook MUST propagate its throws to the host so the tool call is rejected;
 * wrapping it in `safeHook` silently disables the policy. For fail-closed
 * hooks, use `composeBlockingHandlers` (or, as the existing
 * `tool.execute.before` chain in `src/index.ts` does, call them directly
 * with raw `await`).
 *
 * Reference: AGENTS.md invariant 11 + Full-Auto v2 fail-closed contract.
 */
export function composeHandlers<I, O>(
	...fns: Array<HookHandler<I, O>>
): HookHandler<I, O> {
	if (fns.length === 0) {
		return async () => {};
	}

	for (const fn of fns) {
		if (isFailClosedHandler(fn)) {
			throw new Error(
				'composeHandlers cannot wrap fail-closed handlers; use composeBlockingHandlers or await them directly',
			);
		}
	}

	return async (input: I, output: O) => {
		for (const fn of fns) {
			const safeFn = _internals.safeHook(fn);
			await safeFn(input, output);
		}
	};
}

/**
 * `composeBlockingHandlers` runs handlers sequentially WITHOUT `safeHook`,
 * so any thrown error propagates to the caller and stops the chain.
 *
 * Use this for fail-closed security / policy hooks at `tool.execute.before`,
 * including:
 *   - guardrails authority enforcement
 *   - scope-guard
 *   - delegation-gate (reviewer gate)
 *   - Full-Auto v2 outbound delegation guard (`createFullAutoDelegationHook`)
 *   - Full-Auto v2 permission policy (`createFullAutoPermissionHook`)
 *
 * Semantic contract:
 *   - Handlers run in registration order.
 *   - The first thrown error stops execution and propagates unchanged.
 *   - Later handlers are NOT called after a throw.
 *   - The host (OpenCode) interprets the propagated throw as a tool
 *     rejection and surfaces it to the calling agent.
 *
 * Companion regression tests live at
 * `tests/unit/hooks/hook-composition.test.ts` to lock this semantics in
 * place — silently swallowing a Full-Auto denial would be a runtime
 * fail-open and is a critical regression.
 */
export function composeBlockingHandlers<I, O>(
	...fns: Array<HookHandler<I, O>>
): HookHandler<I, O> {
	if (fns.length === 0) {
		return async () => {};
	}
	return async (input: I, output: O) => {
		for (const fn of fns) {
			// Intentionally raw `await` — no safeHook wrapper. Errors must
			// propagate so the host rejects the tool call.
			await fn(input, output);
		}
	};
}

/**
 * Validates that a filename is safe to use within the .swarm directory
 *
 * @param directory - The base directory containing the .swarm folder
 * @param filename - The filename to validate
 * @returns The resolved absolute path if validation passes
 * @throws Error if the filename is invalid or attempts path traversal
 */
export function validateSwarmPath(directory: string, filename: string): string {
	// Reject null bytes
	if (/[\0]/.test(filename)) {
		throw new Error('Invalid filename: contains null bytes');
	}

	// Reject path traversal attempts
	if (/\.\.[/\\]/.test(filename)) {
		throw new Error('Invalid filename: path traversal detected');
	}

	// Reject Windows absolute paths on all platforms
	// On POSIX, path.resolve treats C:\foo as relative, which can bypass
	// escape checks unless explicitly blocked.
	if (/^[A-Za-z]:[\\/]/.test(filename)) {
		throw new Error('Invalid filename: path escapes .swarm directory');
	}

	// Reject POSIX absolute paths
	if (filename.startsWith('/')) {
		throw new Error('Invalid filename: path escapes .swarm directory');
	}

	// Resolve the base directory and the requested file
	const baseDir = path.normalize(path.resolve(directory, '.swarm'));
	const resolved = path.normalize(path.resolve(baseDir, filename));

	// Check that the resolved path is within the .swarm directory
	if (process.platform === 'win32') {
		// On Windows, do case-insensitive comparison
		if (
			!resolved.toLowerCase().startsWith((baseDir + path.sep).toLowerCase())
		) {
			throw new Error('Invalid filename: path escapes .swarm directory');
		}
	} else {
		// On other platforms, do case-sensitive comparison
		if (!resolved.startsWith(baseDir + path.sep)) {
			throw new Error('Invalid filename: path escapes .swarm directory');
		}
	}

	let realBaseDir: string;
	try {
		if (fs.lstatSync(baseDir).isSymbolicLink()) {
			throw new Error('Invalid filename: path escapes .swarm directory');
		}
		realBaseDir = fs.realpathSync(baseDir);
	} catch (error) {
		if (
			error instanceof Error &&
			error.message === 'Invalid filename: path escapes .swarm directory'
		) {
			throw error;
		}
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return resolved;
		}
		throw new Error('Invalid filename: failed to resolve .swarm directory');
	}

	let existingPath = resolved;
	while (!fs.existsSync(existingPath)) {
		const parent = path.dirname(existingPath);
		if (parent === existingPath || !isPathWithin(parent, baseDir)) {
			existingPath = baseDir;
			break;
		}
		existingPath = parent;
	}

	let realExistingPath: string;
	try {
		realExistingPath = fs.realpathSync(existingPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			realExistingPath = realBaseDir;
		} else {
			throw new Error('Invalid filename: failed to resolve path');
		}
	}

	if (!isPathWithin(realExistingPath, realBaseDir)) {
		throw new Error('Invalid filename: path escapes .swarm directory');
	}

	return resolved;
}

function isPathWithin(candidate: string, base: string): boolean {
	const normalizedCandidate = path.normalize(candidate);
	const normalizedBase = path.normalize(base);
	if (process.platform === 'win32') {
		const candidateLower = normalizedCandidate.toLowerCase();
		const baseLower = normalizedBase.toLowerCase();
		return (
			candidateLower === baseLower ||
			candidateLower.startsWith(`${baseLower}${path.sep}`)
		);
	}
	return (
		normalizedCandidate === normalizedBase ||
		normalizedCandidate.startsWith(`${normalizedBase}${path.sep}`)
	);
}

export async function readSwarmFileAsync(
	directory: string,
	filename: string,
	cache?: Map<string, Promise<string | null>>,
): Promise<string | null> {
	if (cache !== undefined) {
		const key = `${directory}::${filename}`;
		const cached = cache.get(key);
		if (cached !== undefined) {
			// Return the cached promise directly — concurrent awaits share the
			// same in-flight request, and null results are cached too.
			return cached;
		}
		// Store the promise BEFORE awaiting so any concurrent call for the same
		// key picks up the in-flight promise instead of starting a second read.
		const promise = readSwarmFileAsync(directory, filename);
		cache.set(key, promise);
		return promise;
	}
	// SPLIT retry budget constants — see comment below for rationale.
	// ENOENT (macOS/APFS rename race): cheap, short window. Preserves the
	// pre-#1782 hot-path latency for missing files (system-enhancer reads
	// context.md/plan.md per message; loadPlanJsonOnly reads plan.json per
	// evidence attribution).
	const ENOENT_MAX_ATTEMPTS = 5;
	const ENOENT_RETRY_DELAY_MS = 10;
	// EBUSY/EPERM/EACCES (Windows AV scan): longer window. Sized for real
	// Windows Defender scan windows (commonly 100–500ms).
	const maxAttempts = 6;
	// Retry loop to handle macOS/APFS rename-visibility race AND transient
	// Windows FS errors from AV/indexing of a freshly-written file.
	//
	// After an atomic rename, the filesystem can take a few ms to update the
	// directory entry; immediately-following reads may see ENOENT.
	//
	// On Windows, antivirus / Windows Defender / Search Indexer can briefly
	// hold an exclusive handle on a file that was just written, surfacing as
	// EBUSY / EPERM / EACCES on the first read attempt. The same Windows AV
	// class was previously hardened at a higher layer in `getEvidenceTaskId`
	// (src/hooks/delegation-gate.ts:1742-1747, v6.33.7) by swallowing the
	// error and returning null; this is the source-level retry that prevents
	// the swallow from being reached. Retry-set precedent: `RENAME_RETRY_CODES`
	// at src/evidence/documents-retention.ts:67-70 (deliberately omits
	// `ENOTEMPTY`, which is a rename-specific code not applicable to reads).
	//
	// SPLIT POLICY (issue #1782 final-critic finding): the two error classes
	// have fundamentally different latency budgets.
	//
	//   - ENOENT (macOS/APFS rename race): short window — the prior flat
	//     10ms × 4 sleeps = 40ms budget was sized for this. PRESERVED to avoid
	//     a hot-path regression: `system-enhancer.ts` reads `context.md` and
	//     `plan.md` per message transform, and `loadPlanJsonOnly` reads
	//     `plan.json` per evidence attribution. On projects without those
	//     files, `bunFile(...).text()` throws ENOENT — a 310ms miss path
	//     would be unacceptable on the per-message path.
	//   - EBUSY/EPERM/EACCES (Windows AV scan): commonly 100–500ms. Use
	//     exponential backoff 10/20/40/80/160ms across 6 attempts (310ms total
	//     worst-case) — sized for real Defender scan windows. The prior flat
	//     10ms × 4 = 40ms budget was observed insufficient when both
	//     unit-test-level retries of
	//     `tests/unit/hooks/delegation-gate-resolve-task-id.test.ts` failed in
	//     merge-group run 29854486821 (2026-07-21).
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		try {
			const resolvedPath = _internals.validateSwarmPath(directory, filename);
			return await _internals.readCachedTextFile(resolvedPath, async () => {
				const file = bunFile(resolvedPath);
				return await file.text();
			});
		} catch (err) {
			const code = (err as NodeJS.ErrnoException)?.code;
			if (code === 'ENOENT') {
				// Short-window rename-visibility race. Cheap flat backoff.
				// Preserves the pre-#1782 hot-path latency for missing files.
				if (attempt >= ENOENT_MAX_ATTEMPTS - 1) return null;
				await new Promise((resolve) =>
					setTimeout(resolve, ENOENT_RETRY_DELAY_MS),
				);
				continue;
			}
			const isAvRetryable =
				code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
			if (!isAvRetryable || attempt === maxAttempts - 1) {
				return null;
			}
			// Exponential backoff for Windows AV class: 10/20/40/80/160ms.
			const retryDelayMs = 10 * 2 ** attempt;
			await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
		}
	}
	return null;
}

/**
 * Canonical chars→tokens heuristic ratio for the whole plugin (issue #1616/#2107).
 *
 * This is a length-based HEURISTIC, not a tokenizer: provider-reported token usage is
 * authoritative whenever it is available; every char-derived estimate is a fallback.
 * This is the ONLY production site of a char/token conversion constant — all other
 * modules must import these helpers. Enforced by the inline-token-formula check in
 * scripts/check-invariants.ts.
 */
const TOKENS_PER_CHAR = 0.33;

/**
 * Estimate tokens from a character count using the canonical heuristic.
 * This is the single sanctioned numeric form (issue #2107 §1).
 */
export function estimateTokensFromCharCount(chars: number): number {
	if (chars <= 0) {
		return 0;
	}
	return Math.ceil(chars * TOKENS_PER_CHAR);
}

/**
 * Inverse of the canonical estimator: the character budget that corresponds to a
 * token budget. Floor, so the result never overruns the token budget when converted
 * back with `estimateTokensFromCharCount`.
 */
export function estimateCharsForTokens(tokens: number): number {
	if (tokens <= 0) {
		return 0;
	}
	return Math.floor(tokens / TOKENS_PER_CHAR);
}

export function estimateTokens(text: string): number {
	// Falsy guard preserved from the pre-#2107 signature: callers (and
	// utils.test.ts) rely on null/undefined returning 0 rather than throwing
	// on `.length`.
	if (!text) {
		return 0;
	}
	return estimateTokensFromCharCount(text.length);
}
