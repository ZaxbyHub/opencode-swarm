/**
 * Shared utility for resolving working_directory across swarm tools.
 *
 * Tools that read .swarm/ state (plan.json, evidence/) must resolve paths
 * relative to the actual project root, not process.cwd(). When the MCP host's
 * CWD differs from the project root (e.g. CWD=RAGAPPv2, project=RAGAPPv3),
 * tools that lack a working_directory parameter silently read stale data from
 * the wrong directory.
 *
 * This helper provides consistent validation and resolution, matching the
 * pattern already used by save_plan and update_task_status.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ResolveResult {
	success: true;
	directory: string;
}

export interface ResolveError {
	success: false;
	message: string;
}

/**
 * Resolves and validates a working directory against a fallback (injected project root).
 *
 * NOTE: This function intentionally does NOT use realpathSync for the resolved path
 * to avoid Windows 8.3 short filename issues. Symlink-based subdirectory bypasses
 * through this coarse filter are caught by the write-time validateProjectRoot guard
 * in evidence/manager.ts, which DOES use realpathSync. These two functions form a
 * defense-in-depth pair: resolveWorkingDirectory is the fast entry filter,
 * validateProjectRoot is the authoritative canonical check at write time.
 *
 * Priority: explicit working_directory param > injected directory (from createSwarmTool).
 *
 * When working_directory is provided, it is validated for:
 * - Null-byte injection
 * - Path traversal sequences (..)
 * - Windows device paths
 * - Existence on disk
 *
 * @param workingDirectory - Explicit working_directory from tool args (caller-controlled)
 * @param fallbackDirectory - Injected directory from createSwarmTool (ctx.directory ?? process.cwd())
 */
export function resolveWorkingDirectory(
	workingDirectory: string | undefined | null,
	fallbackDirectory?: string | null,
): ResolveResult | ResolveError {
	if (workingDirectory == null || workingDirectory === '') {
		if (typeof fallbackDirectory !== 'string' || fallbackDirectory === '') {
			return {
				success: false,
				message:
					'Invalid working_directory: no explicit working_directory was provided and fallbackDirectory is missing or not a string',
			};
		}
		// No explicit override — use the injected directory from createSwarmTool
		return { success: true, directory: fallbackDirectory };
	}

	if (typeof workingDirectory !== 'string') {
		return {
			success: false,
			message: 'Invalid working_directory: path must be a string',
		};
	}

	// Null-byte injection check
	if (workingDirectory.includes('\0')) {
		return {
			success: false,
			message: 'Invalid working_directory: null bytes are not allowed',
		};
	}

	// Windows device path check
	if (process.platform === 'win32') {
		const devicePathPattern = /^\\\\|^(NUL|CON|AUX|COM[1-9]|LPT[1-9])(\..*)?$/i;
		if (devicePathPattern.test(workingDirectory)) {
			return {
				success: false,
				message:
					'Invalid working_directory: Windows device paths are not allowed',
			};
		}
	}

	// Normalize and check for traversal
	const normalizedDir = path.normalize(workingDirectory);
	const pathParts = normalizedDir.split(path.sep);
	if (pathParts.includes('..')) {
		return {
			success: false,
			message:
				'Invalid working_directory: path traversal sequences (..) are not allowed',
		};
	}

	// Resolve and verify existence
	const resolvedDir = path.resolve(normalizedDir);
	// Use statSync instead of realpathSync to preserve original path casing.
	// realpathSync on Windows returns short 8.3 filenames which break path lookups
	// when the file was created using the long filename.
	let statResult: fs.Stats;
	try {
		statResult = fs.statSync(resolvedDir);
	} catch {
		return {
			success: false,
			message: `Invalid working_directory: path "${resolvedDir}" does not exist or is inaccessible`,
		};
	}
	if (!statResult.isDirectory()) {
		return {
			success: false,
			message: `Invalid working_directory: path "${resolvedDir}" is not a directory`,
		};
	}

	// Check if fallbackDirectory exists (used to detect CWD mismatch scenario).
	// When no fallback root is provided the containment check below cannot run.
	// This is intentional: containment is enforced at write-time by validateProjectRoot
	// in evidence/manager.ts, which is the authoritative canonical guard.
	if (typeof fallbackDirectory !== 'string' || fallbackDirectory === '') {
		return { success: true, directory: resolvedDir };
	}

	const resolvedFallback = path.resolve(fallbackDirectory);
	let fallbackExists = false;
	try {
		fs.statSync(resolvedFallback);
		fallbackExists = true;
	} catch {
		fallbackExists = false;
	}

	// Project root anchor: when working_directory is explicitly provided and differs from
	// fallback_directory, reject only if working_directory is a subdirectory of fallback_directory.
	// If fallback doesn't exist (CWD mismatch), trust the explicit working_directory.
	// This allows valid explicit overrides while preventing .swarm creation in subdirectories.
	if (fallbackExists) {
		// Reject only if working_directory is a subdirectory of fallback.
		// Example: workingDir=/project/src, fallback=/project → src is a subdirectory of /project → REJECT
		// Example: workingDir=/project, fallback=/tmp/wrong → /project is NOT a subdirectory of /tmp/wrong → TRUST
		const isSubdirectory = resolvedDir.startsWith(
			resolvedFallback + path.sep,
		);
		if (isSubdirectory) {
			return {
				success: false,
				message:
					`Invalid working_directory: "${workingDirectory}" resolves to "${resolvedDir}" ` +
					`which is a subdirectory of fallback "${resolvedFallback}". ` +
					`Pass the project root path or omit working_directory entirely.`,
			};
		}
	}

	// Trust explicit working_directory (either fallback doesn't exist, or it's not a subdirectory)
	return { success: true, directory: resolvedDir };
}
