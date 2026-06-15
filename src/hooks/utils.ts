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
	fs: { realpathSync: typeof fs.realpathSync };
} = {
	safeHook,
	composeHandlers,
	validateSwarmPath,
	readSwarmFileAsync,
	fs: { realpathSync: fs.realpathSync },
};

export function safeHook<I, O>(
	fn: (input: I, output: O) => Promise<void>,
): (input: I, output: O) => Promise<void> {
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
	...fns: Array<(input: I, output: O) => Promise<void>>
): (input: I, output: O) => Promise<void> {
	if (fns.length === 0) {
		return async () => {};
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
	...fns: Array<(input: I, output: O) => Promise<void>>
): (input: I, output: O) => Promise<void> {
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

	// Symlink containment check: resolve the real path to detect symlinks
	// that escape the .swarm directory. Nonexistent targets are allowed
	// (write paths may point to files not yet created).
	try {
		const realPath = _internals.fs.realpathSync(resolved);
		if (process.platform === 'win32') {
			if (
				!realPath.toLowerCase().startsWith((baseDir + path.sep).toLowerCase())
			) {
				throw new Error('Invalid filename: path escapes .swarm directory');
			}
		} else {
			if (!realPath.startsWith(baseDir + path.sep)) {
				throw new Error('Invalid filename: path escapes .swarm directory');
			}
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			// Nonexistent target is fine — the path is intended for writing
		} else {
			throw error;
		}
	}

	return resolved;
}

export async function readSwarmFileAsync(
	directory: string,
	filename: string,
): Promise<string | null> {
	try {
		const resolvedPath = _internals.validateSwarmPath(directory, filename);
		const file = bunFile(resolvedPath);
		const content = await file.text();
		return content;
	} catch {
		return null;
	}
}

export function estimateTokens(text: string): number {
	if (!text) {
		return 0;
	}

	return Math.ceil(text.length * 0.33);
}
