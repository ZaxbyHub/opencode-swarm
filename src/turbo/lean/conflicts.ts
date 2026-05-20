/**
 * File Scope Conflict Detection for Lean Turbo.
 *
 * This module provides conflict detection utilities for determining whether
 * tasks can be executed in parallel based on their file scopes.
 *
 * ## Conflict Detection Rules
 *
 * Two tasks conflict if:
 * - They touch the **same file**
 * - One task touches a **parent directory** of a file the other task touches
 *   (e.g., `src/auth/` vs `src/auth/login.ts`)
 * - A task touches a **global file** (affects all coders)
 * - A task touches a **protected path** (security-sensitive areas)
 *
 * ## Path Normalization
 *
 * All paths are normalized to POSIX-style (forward slashes, no trailing slash)
 * before conflict detection. This ensures consistent behavior across platforms.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── Scope File Types ────────────────────────────────────────────────────────

/**
 * A scope file persisted by the `declare_scope` tool.
 * Stored at `.swarm/scopes/scope-{taskId}.json`.
 */
export interface ScopeFile {
	taskId: string;
	files: string[];
	declaredAt: string;
}

// ─── Default Configuration ──────────────────────────────────────────────────

/**
 * Global files that affect all coders when modified.
 * Any task touching these files is automatically degraded.
 */
const DEFAULT_GLOBAL_FILES: readonly string[] = [
	'package.json',
	'package-lock.json',
	'bun.lock',
	'bun.lockb',
	'pnpm-lock.yaml',
	'yarn.lock',
	'Cargo.lock',
	'Gemfile.lock',
	'composer.lock',
	'poetry.lock',
	'go.mod',
	'go.sum',
	'tsconfig.json',
	'bunfig.toml',
	'CHANGELOG.md',
	'.release-please-manifest.json',
	// Barrel files that other tasks may import
	'src/index.ts',
	'src/tools/index.ts',
	'src/agents/index.ts',
	'src/config/index.ts',
	'src/hooks/index.ts',
	// Turborepo / build config
	'turbo.json',
	'nx.json',
	'packageManager',
	'.npmrc',
	'.nvmrc',
	'.node-version',
];

/**
 * Path patterns considered protected/security-sensitive.
 * Tasks touching paths containing these patterns are degraded or serialized.
 */
const DEFAULT_PROTECTED_PATTERNS: readonly string[] = [
	'guardrail',
	'delegation',
	'authority',
	'permission',
	'crypto',
	'secret',
	'security',
	'auth',
	// Common auth-related paths (but not /authentication/ which is different)
	'/auth/',
	'/auth.',
	'auth.',
	// Sensitive config
	'.env',
	'credentials',
	'secrets',
	'private',
	// Security-related directories
	'/security/',
	'/security.',
	'/protect/',
	'/protect.',
];

/**
 * Barrel file patterns that indicate generated/index files.
 * These are treated as global because other tasks may import from them.
 */
export const BARREL_FILE_PATTERNS: readonly RegExp[] = [
	/\/index\.ts$/,
	/\/index\.tsx$/,
	/\/index\.js$/,
	/\/index\.mjs$/,
	/\/exports\.ts$/,
	/\/types\.ts$/,
];

// ─── Helper Functions ────────────────────────────────────────────────────────

/**
 * Normalize a file path to POSIX-style for consistent cross-platform comparison.
 *
 * - Converts backslashes to forward slashes
 * - Removes trailing slashes
 * - Collapses multiple consecutive slashes
 * - Resolves `.` path segments (current directory references)
 * - Does NOT resolve `..` segments or symlinks
 *
 * @param filePath - The path to normalize
 * @returns POSIX-normalized path
 */
export function normalizePath(filePath: string): string {
	// Handle edge case: "." or "./" alone should return "."
	if (filePath === '.' || filePath === './') {
		return '.';
	}

	let result = filePath
		.replace(/\\/g, '/') // Convert Windows backslashes
		.replace(/\/+/g, '/') // Collapse multiple slashes
		// Remove leading ./
		.replace(/^\.\//, '')
		// Replace /. / with / at segment boundaries (handles middle and trailing ./)
		.replace(/(?:^|\/)\.\//g, '/');

	// Remove trailing slash
	result = result.replace(/\/$/, '');

	// Remove trailing /. if present (handles case where ./ was at the end before trailing slash removal)
	result = result.replace(/\/\.$/, '');

	// Normalize case on Windows for consistent comparison
	if (process.platform === 'win32') {
		result = result.toLowerCase();
	}
	return result;
}

/**
 * Check if a path contains directory traversal components.
 * Rejects paths with `..` segments that could escape the project root.
 *
 * @param filePath - The path to validate
 * @returns true if the path is safe (no traversal)
 */
export function isPathSafe(filePath: string): boolean {
	const normalized = normalizePath(filePath);
	// Reject any path containing .. segments
	if (normalized.includes('..')) {
		return false;
	}
	return true;
}

/**
 * Check if two normalized paths conflict.
 *
 * Conflicts occur when:
 * - The paths are identical (same file)
 * - One path is a parent directory of the other
 *
 * IMPORTANT: Parent/child detection is path-segment aware.
 * `src/auth/` contains `src/auth/login.ts` but NOT `src/authentication.ts`.
 *
 * @param path1 - First normalized path
 * @param path2 - Second normalized path
 * @returns true if the paths conflict
 */
export function pathsConflict(path1: string, path2: string): boolean {
	// Normalize case on Windows for consistent comparison
	if (process.platform === 'win32') {
		path1 = path1.toLowerCase();
		path2 = path2.toLowerCase();
	}

	// Same file
	if (path1 === path2) {
		return true;
	}

	// Ensure consistent ordering for parent/child check
	const [shorter, longer] =
		path1.length <= path2.length ? [path1, path2] : [path2, path1];

	// Check if shorter is a directory prefix of longer
	// Must be at a path segment boundary (followed by /)
	if (longer.startsWith(`${shorter}/`)) {
		return true;
	}

	return false;
}

/**
 * Check if a normalized path is a global file.
 * Global files affect all coders and cannot be parallelized safely.
 *
 * @param normalizedPath - POSIX-normalized path
 * @returns true if the file is global
 */
export function isGlobalFile(normalizedPath: string): boolean {
	// Check if path ends with any global file entry
	// This allows matching both full paths (src/index.ts) and basename-only (package.json)
	if (DEFAULT_GLOBAL_FILES.some((gf) => normalizedPath.endsWith(gf))) {
		return true;
	}

	// Check barrel file patterns (e.g., src/foo/index.ts)
	for (const pattern of BARREL_FILE_PATTERNS) {
		if (pattern.test(normalizedPath)) {
			return true;
		}
	}

	return false;
}

/**
 * Check if a normalized path matches a protected path pattern.
 * Protected paths are security-sensitive areas that require special handling.
 *
 * @param normalizedPath - POSIX-normalized path to check
 * @returns true if the path is protected
 */
export function isProtectedPath(normalizedPath: string): boolean {
	const lowerPath = normalizedPath.toLowerCase();

	for (const pattern of DEFAULT_PROTECTED_PATTERNS) {
		// Pattern matching for path segments
		// Handle both exact segment matches and substring matches
		if (lowerPath.includes(pattern.toLowerCase())) {
			// For auth-specific patterns, be more precise
			if (pattern === 'auth' || pattern === '/auth/') {
				// Match /auth/ but NOT /authentication/ or /author/
				if (
					lowerPath === 'auth' ||
					lowerPath.endsWith('/auth') ||
					lowerPath.includes('/auth/')
				) {
					return true;
				}
			} else if (pattern === 'auth.') {
				// Match auth.ts, auth-service.ts but NOT authentication.ts
				// Require word boundary after 'auth' — either end of string or non-word char
				const idx = lowerPath.indexOf('auth.');
				if (idx !== -1) {
					// Check that 'auth' is preceded by start or path separator
					const before = idx === 0 || lowerPath[idx - 1] === '/';
					if (before) {
						return true;
					}
				}
			} else {
				return true;
			}
		}
	}

	return false;
}

/**
 * Read task scope from the scope file for a given task.
 *
 * Scope files are stored at `.swarm/scopes/scope-{taskId}.json`.
 *
 * @param directory - The project root directory
 * @param taskId - The task ID (e.g., "4.1")
 * @returns Array of file paths, or null if scope file doesn't exist
 */
export function readTaskScopes(
	directory: string,
	taskId: string,
): string[] | null {
	const scopePath = path.join(
		directory,
		'.swarm',
		'scopes',
		`scope-${taskId}.json`,
	);

	try {
		if (!fs.existsSync(scopePath)) {
			return null;
		}
		const raw = fs.readFileSync(scopePath, 'utf-8');
		const parsed = JSON.parse(raw) as ScopeFile;

		if (!parsed || !Array.isArray(parsed.files)) {
			return null;
		}

		return parsed.files;
	} catch {
		// Fail-closed: if we can't read the scope file, return null
		// This will cause the task to be serialized
		return null;
	}
}

// ─── Exported Constants for Testing ──────────────────────────────────────────

/** Exported for unit testing */
export const GLOBAL_FILES_LIST = DEFAULT_GLOBAL_FILES;

/** Exported for unit testing */
export const PROTECTED_PATTERNS_LIST = DEFAULT_PROTECTED_PATTERNS;
