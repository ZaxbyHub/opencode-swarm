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

export function composeHandlers<I, O>(
	...fns: Array<(input: I, output: O) => Promise<void>>
): (input: I, output: O) => Promise<void> {
	if (fns.length === 0) {
		return async () => {};
	}

	return async (input: I, output: O) => {
		for (const fn of fns) {
			const safeFn = safeHook(fn);
			await safeFn(input, output);
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
	try {
		const resolvedPath = validateSwarmPath(directory, filename);
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
