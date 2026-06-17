/**
 * Shared hook utilities for OpenCode Swarm
 *
 * This module provides common utilities for working with hooks,
 * including error handling, handler composition, file I/O, and
 * token estimation for swarm-related operations.
 */

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
} = { safeHook, composeHandlers, validateSwarmPath, readSwarmFileAsync };

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

	return resolved;
}

export async function readSwarmFileAsync(
	directory: string,
	filename: string,
): Promise<string | null> {
	// Retry loop to handle macOS/APFS rename-visibility race.
	// After an atomic rename, the filesystem can take a few ms to update
	// the directory entry. Immediately-following reads may see ENOENT.
	// Retry up to 5 times with 10ms delay before giving up.
	const maxAttempts = 5;
	const retryDelayMs = 10;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		try {
			const resolvedPath = _internals.validateSwarmPath(directory, filename);
			return await readCachedTextFile(resolvedPath, async () => {
				const file = bunFile(resolvedPath);
				return await file.text();
			});
		} catch (err) {
			// Only retry on ENOENT (file not found) — other errors should fail fast
			const isNotFound = (err as NodeJS.ErrnoException)?.code === 'ENOENT';
			if (!isNotFound || attempt === maxAttempts - 1) {
				return null;
			}
			// Wait before retrying
			await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
		}
	}
	return null;
}

export function estimateTokens(text: string): number {
	if (!text) {
		return 0;
	}

	return Math.ceil(text.length * 0.33);
}
