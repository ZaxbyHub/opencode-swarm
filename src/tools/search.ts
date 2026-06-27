// Structured workspace search tool — workspace-scoped ripgrep-style search with structured JSON output

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import {
	resolveExecutableFromPath,
	runExternalTool,
} from '../utils/external-tool-runner';
import {
	containsControlChars,
	containsPathTraversal,
} from '../utils/path-security';
import { createSwarmTool } from './create-tool';

const require = createRequire(import.meta.url);

// ============ Types ============

export interface SearchMatch {
	file: string;
	lineNumber: number;
	lineText: string;
	context?: string[];
}

export interface SearchResult {
	matches: SearchMatch[];
	truncated: boolean;
	total: number;
	query: string;
	mode: 'literal' | 'regex';
	maxResults: number;
	engine: 'ripgrep' | 'fallback';
	outputTruncated?: boolean;
	warning?: string;
}

export interface SearchError {
	error: true;
	type:
		| 'rg-not-found'
		| 'regex-timeout'
		| 'path-escape'
		| 'invalid-query'
		| 'unknown';
	message: string;
}

export interface SearchArgs {
	query: string;
	mode?: 'literal' | 'regex';
	include?: string; // glob pattern for files to include
	exclude?: string; // glob pattern for files to exclude
	max_results?: number;
	max_lines?: number;
}

// ============ Constants ============

const DEFAULT_MAX_RESULTS = 100;
const DEFAULT_MAX_LINES = 200;
const REGEX_TIMEOUT_MS = 5000;
const MAX_FILE_SIZE_BYTES = 1024 * 1024; // 1MB per file
const HARD_CAP_RESULTS = 10000;
const HARD_CAP_LINES = 10000;
const MAX_QUERY_LENGTH = 20_000;
const MAX_RG_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_RG_STDERR_BYTES = 64 * 1024;
const FALLBACK_MAX_FILES = 20_000;
const FALLBACK_MAX_DIRS = 5_000;
const FALLBACK_MAX_DEPTH = 40;
const FALLBACK_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const DEFAULT_SKIP_DIRS = new Set([
	'.git',
	'.swarm',
	'node_modules',
	'dist',
	'build',
	'out',
	'coverage',
	'.next',
	'.turbo',
	'.cache',
]);

// ============ Glob Pattern Matching (Fallback) ============

/**
 * Simple glob pattern matcher for file filtering.
 * Supports: ** (any subdirectory), * (any characters except path sep), ? (single char)
 */
function globMatch(pattern: string, filePath: string): boolean {
	// Normalize path separators in pattern and filepath
	const normalizedPattern = pattern.replace(/\\/g, '/');
	const normalizedPath = filePath.replace(/\\/g, '/');

	// Convert glob pattern to regex
	const regexPattern = normalizedPattern
		.replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape special regex chars except * and ?
		.replace(/\*\*/g, '{{DOUBLESTAR}}') // Placeholder for **
		.replace(/\*/g, '[^/]*') // * matches anything except /
		.replace(/\?/g, '.') // ? matches single char
		.replace(/\{\{DOUBLESTAR\}\}/g, '.*'); // ** matches anything including /

	try {
		const regex = new RegExp(`^${regexPattern}$`);
		return regex.test(normalizedPath);
	} catch {
		return false;
	}
}

/**
 * Check if a file path matches any of the glob patterns.
 */
function matchesGlobs(filePath: string, globs: string[]): boolean {
	if (globs.length === 0) return true;
	return globs.some((glob) => globMatch(glob, filePath));
}

// ============ Path Validation ============

const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|:|$)/i;

/**
 * Check for Windows-specific path attacks.
 */
function containsWindowsAttacks(str: string): boolean {
	if (/:[^\\/]/.test(str)) return true;
	const parts = str.split(/[/\\]/);
	for (const part of parts) {
		if (WINDOWS_RESERVED_NAMES.test(part)) return true;
	}
	return false;
}

/**
 * Validate that a path is within the workspace boundary.
 */
function isPathInWorkspace(filePath: string, workspace: string): boolean {
	try {
		const resolvedPath = path.resolve(workspace, filePath);
		const realWorkspace = fs.realpathSync(workspace);
		const realResolvedPath = fs.realpathSync(resolvedPath);
		const relativePath = path.relative(realWorkspace, realResolvedPath);
		if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
			return false;
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Re-validate path is still within workspace immediately before file access.
 */
function validatePathForRead(filePath: string, workspace: string): boolean {
	return isPathInWorkspace(filePath, workspace);
}

// ============ Helpers ============

function splitGlobPatterns(value?: string): string[] {
	return value
		? value
				.split(',')
				.map((p) => p.trim())
				.filter(Boolean)
		: [];
}

function toWorkspaceRelativePath(
	filePath: string,
	workspace: string,
): string | null {
	try {
		const resolved = path.resolve(workspace, filePath);
		const realWorkspace = fs.realpathSync(workspace);
		const realResolved = fs.realpathSync(resolved);
		const relative = path.relative(realWorkspace, realResolved);
		if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
			return null;
		}
		return relative.split(path.sep).join('/');
	} catch {
		return null;
	}
}

function truncateLine(line: string, maxLines: number): string {
	const trimmed = line.trimEnd();
	if (trimmed.length > maxLines) {
		return `${trimmed.substring(0, maxLines)}...`;
	}
	return trimmed;
}

// ============ Ripgrep Detection ============

function resolvePackagedRipgrep(): string | null {
	try {
		const mod = require('@vscode/ripgrep') as { rgPath?: unknown };
		return typeof mod.rgPath === 'string' && mod.rgPath ? mod.rgPath : null;
	} catch {
		return null;
	}
}

function resolveRipgrepBinary(): string | null {
	return (
		_internals.resolvePackagedRipgrep() ??
		_internals.resolveExecutableFromPath(['rg'])
	);
}

// ============ Ripgrep Search ============

interface RipgrepSearchOptions {
	query: string;
	mode: 'literal' | 'regex';
	include?: string;
	exclude?: string;
	maxResults: number;
	maxLines: number;
	workspace: string;
}

/**
 * Execute search using ripgrep.
 */
async function ripgrepSearch(
	opts: RipgrepSearchOptions,
): Promise<SearchResult | SearchError> {
	const rgPath = _internals.resolveRipgrepBinary();
	if (!rgPath) {
		return {
			error: true,
			type: 'rg-not-found',
			message: 'ripgrep (rg) not found; using fallback search was not possible',
		};
	}

	const args: string[] = [
		'--json',
		'--no-config',
		'-n', // line numbers
	];

	// Add glob patterns for include/exclude
	for (const pattern of splitGlobPatterns(opts.include)) {
		args.push('--glob', pattern);
	}
	for (const pattern of splitGlobPatterns(opts.exclude)) {
		args.push('--glob', `!${pattern}`); // ! negates glob in ripgrep
	}

	// Set search mode
	if (opts.mode !== 'regex') {
		args.push('--fixed-strings');
	}

	// Keep all options before `--`; query and path operands cannot be flags.
	args.push('--', opts.query, '.');

	const run = await _internals.runExternalTool({
		executable: rgPath,
		args,
		cwd: opts.workspace,
		timeoutMs: REGEX_TIMEOUT_MS,
		maxStdoutBytes: MAX_RG_STDOUT_BYTES,
		maxStderrBytes: MAX_RG_STDERR_BYTES,
	});

	try {
		if (run.status === 'timeout') {
			return {
				error: true,
				type: 'regex-timeout',
				message: `Search timed out after ${REGEX_TIMEOUT_MS}ms`,
			};
		}

		if (run.status === 'spawn-error') {
			return {
				error: true,
				type: 'unknown',
				message: run.message ?? 'ripgrep failed to start',
			};
		}

		// If ripgrep exited with non-zero and has stderr, it might be an invalid regex
		if (run.exitCode !== 0 && run.stderr) {
			if (
				run.stderr.includes('Invalid regex') ||
				run.stderr.includes('regex parse error') ||
				run.stderr.includes('SyntaxError')
			) {
				return {
					error: true,
					type: 'invalid-query',
					message: `Invalid query: ${run.stderr.split('\n')[0]}`,
				};
			}
		}

		const matches: SearchMatch[] = [];
		let total = 0;

		// Parse ripgrep JSON output (line per match)
		for (const line of run.stdout.split('\n')) {
			if (!line.trim()) continue;

			try {
				const entry = JSON.parse(line);

				// ripgrep outputs different message types; we only care about matches
				if (entry.type === 'match') {
					const rawPath = entry.data?.path?.text ?? entry.data?.path;
					const relativePath =
						typeof rawPath === 'string'
							? toWorkspaceRelativePath(rawPath, opts.workspace)
							: null;
					if (!relativePath) continue;

					total++;
					if (matches.length < opts.maxResults) {
						const match: SearchMatch = {
							file: relativePath,
							lineNumber: entry.data.line_number,
							lineText: truncateLine(entry.data.lines.text, opts.maxLines),
						};
						matches.push(match);
					}
				}
			} catch {
				// Skip malformed JSON lines
			}
		}

		return {
			matches,
			truncated:
				total > opts.maxResults || run.stdoutTruncated || run.stderrTruncated,
			total,
			query: opts.query,
			mode: opts.mode,
			maxResults: opts.maxResults,
			engine: 'ripgrep',
			outputTruncated: run.stdoutTruncated || run.stderrTruncated,
		};
	} catch (err) {
		return {
			error: true,
			type: 'unknown',
			message: err instanceof Error ? err.message : String(err),
		};
	}
}

// ============ Fallback Search (Node.js) ============

interface FallbackSearchOptions {
	query: string;
	mode: 'literal' | 'regex';
	include?: string;
	exclude?: string;
	maxResults: number;
	maxLines: number;
	workspace: string;
}

interface CollectFilesState {
	files: string[];
	seenRealPaths: Set<string>;
	dirCount: number;
	truncated: boolean;
}

/**
 * Escape regex special characters for literal search.
 */
function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Recursively collect all files in workspace, respecting glob patterns.
 */
function collectFiles(
	dir: string,
	workspace: string,
	includeGlobs: string[],
	excludeGlobs: string[],
	state: CollectFilesState,
	depth = 0,
): string[] {
	if (
		depth > FALLBACK_MAX_DEPTH ||
		state.files.length >= FALLBACK_MAX_FILES ||
		state.dirCount >= FALLBACK_MAX_DIRS
	) {
		state.truncated = true;
		return state.files;
	}

	try {
		const realDir = fs.realpathSync(dir);
		if (state.seenRealPaths.has(realDir)) {
			return state.files;
		}
		state.seenRealPaths.add(realDir);
		state.dirCount++;
	} catch {
		return state.files;
	}

	if (!validatePathForRead(dir, workspace)) {
		return state.files;
	}

	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			if (
				state.files.length >= FALLBACK_MAX_FILES ||
				state.dirCount >= FALLBACK_MAX_DIRS
			) {
				state.truncated = true;
				break;
			}

			const fullPath = path.join(dir, entry.name);
			const relativePath = path.relative(workspace, fullPath);

			if (!validatePathForRead(fullPath, workspace)) {
				continue;
			}

			if (entry.isDirectory()) {
				if (DEFAULT_SKIP_DIRS.has(entry.name)) {
					continue;
				}
				collectFiles(
					fullPath,
					workspace,
					includeGlobs,
					excludeGlobs,
					state,
					depth + 1,
				);
			} else if (entry.isFile()) {
				// Check against glob patterns
				if (
					includeGlobs.length > 0 &&
					!matchesGlobs(relativePath, includeGlobs)
				) {
					continue;
				}
				if (
					excludeGlobs.length > 0 &&
					matchesGlobs(relativePath, excludeGlobs)
				) {
					continue;
				}
				const normalized = toWorkspaceRelativePath(fullPath, workspace);
				if (!normalized) continue;
				state.files.push(normalized);
			}
		}
	} catch {
		// Skip directories we can't read
	}

	return state.files;
}

/**
 * Execute search using Node.js fallback (when ripgrep not available).
 */
async function fallbackSearch(
	opts: FallbackSearchOptions,
): Promise<SearchResult | SearchError> {
	// Parse include/exclude glob patterns
	const includeGlobs = opts.include
		? opts.include
				.split(',')
				.map((p) => p.trim())
				.filter(Boolean)
		: [];
	const excludeGlobs = opts.exclude
		? opts.exclude
				.split(',')
				.map((p) => p.trim())
				.filter(Boolean)
		: [];

	const collectState: CollectFilesState = {
		files: [],
		seenRealPaths: new Set(),
		dirCount: 0,
		truncated: false,
	};

	// Collect all matching files
	const files = collectFiles(
		opts.workspace,
		opts.workspace,
		includeGlobs,
		excludeGlobs,
		collectState,
	);

	// Compile regex based on mode
	let regex: RegExp;
	try {
		if (opts.mode === 'regex') {
			regex = new RegExp(opts.query);
		} else {
			regex = new RegExp(escapeRegex(opts.query));
		}
	} catch (err) {
		return {
			error: true,
			type: 'invalid-query',
			message: err instanceof Error ? err.message : 'Invalid regex pattern',
		};
	}

	const matches: SearchMatch[] = [];
	let total = 0;
	let totalBytesRead = 0;
	let truncated = collectState.truncated;

	for (const file of files) {
		const fullPath = path.join(opts.workspace, file);

		// Validate path
		if (!validatePathForRead(fullPath, opts.workspace)) {
			continue;
		}

		// Check file size
		let stats: fs.Stats;
		try {
			stats = fs.statSync(fullPath);
			if (stats.size > MAX_FILE_SIZE_BYTES) {
				continue;
			}
			if (totalBytesRead + stats.size > FALLBACK_MAX_TOTAL_BYTES) {
				truncated = true;
				break;
			}
			totalBytesRead += stats.size;
		} catch {
			continue;
		}

		// Read and search file
		let content: string;
		try {
			content = fs.readFileSync(fullPath, 'utf-8');
		} catch {
			continue;
		}

		const lines = content.split('\n');

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];

			if (regex.test(line)) {
				total++;

				if (matches.length < opts.maxResults) {
					// Truncate line if too long
					matches.push({
						file,
						lineNumber: i + 1,
						lineText: truncateLine(line, opts.maxLines),
					});
				}

				// Reset lastIndex for global regex
				regex.lastIndex = 0;
			}
		}
	}

	return {
		matches,
		truncated: truncated || total > opts.maxResults,
		total,
		query: opts.query,
		mode: opts.mode,
		maxResults: opts.maxResults,
		engine: 'fallback',
		warning:
			'Fallback search uses bounded filesystem traversal and does not fully emulate ripgrep gitignore behavior.',
	};
}

// ============ Tool Definition ============

export const search: ToolDefinition = createSwarmTool({
	description:
		'Search for text within workspace files using ripgrep-style interface. ' +
		'Supports literal and regex search modes with glob include/exclude filtering. ' +
		'Returns structured JSON output with file paths, line numbers, and line content.',
	args: {
		query: z
			.string()
			.describe('Search query string (literal or regex depending on mode)'),
		mode: z
			.enum(['literal', 'regex'])
			.default('literal')
			.describe(
				'Search mode: literal for exact string match, regex for regular expression',
			),
		include: z
			.string()
			.optional()
			.describe(
				'Glob pattern for files to include (e.g., "*.ts", "src/**/*.js")',
			),
		exclude: z
			.string()
			.optional()
			.describe(
				'Glob pattern for files to exclude (e.g., "node_modules/**", "*.test.ts")',
			),
		max_results: z
			.number()
			.default(DEFAULT_MAX_RESULTS)
			.describe('Maximum number of matches to return'),
		max_lines: z
			.number()
			.default(DEFAULT_MAX_LINES)
			.describe('Maximum characters per line in results'),
	},
	execute: async (args: unknown, directory: string) => {
		// Safe args extraction
		let query: string;
		let mode: 'literal' | 'regex' = 'literal';
		let include: string | undefined;
		let exclude: string | undefined;
		let maxResults = DEFAULT_MAX_RESULTS;
		let maxLines = DEFAULT_MAX_LINES;

		try {
			const obj = args as Record<string, unknown>;
			query = String(obj.query ?? '');
			mode = obj.mode === 'regex' ? 'regex' : 'literal';
			include = typeof obj.include === 'string' ? obj.include : undefined;
			exclude = typeof obj.exclude === 'string' ? obj.exclude : undefined;
			const rawMaxResults =
				typeof obj.max_results === 'number'
					? obj.max_results
					: DEFAULT_MAX_RESULTS;
			const sanitizedMaxResults = Number.isNaN(rawMaxResults)
				? DEFAULT_MAX_RESULTS
				: rawMaxResults;
			maxResults = Math.min(Math.max(0, sanitizedMaxResults), HARD_CAP_RESULTS);

			const rawMaxLines =
				typeof obj.max_lines === 'number' ? obj.max_lines : DEFAULT_MAX_LINES;
			const sanitizedMaxLines = Number.isNaN(rawMaxLines)
				? DEFAULT_MAX_LINES
				: rawMaxLines;
			maxLines = Math.min(Math.max(0, sanitizedMaxLines), HARD_CAP_LINES);
		} catch {
			return JSON.stringify(
				{
					error: true,
					type: 'invalid-query',
					message: 'Could not parse search arguments',
				} satisfies SearchError,
				null,
				2,
			);
		}

		// Validate query
		if (!query || query.trim() === '') {
			return JSON.stringify(
				{
					error: true,
					type: 'invalid-query',
					message: 'Query cannot be empty',
				} satisfies SearchError,
				null,
				2,
			);
		}

		if (query.length > MAX_QUERY_LENGTH) {
			return JSON.stringify(
				{
					error: true,
					type: 'invalid-query',
					message: `Query exceeds maximum length of ${MAX_QUERY_LENGTH} characters`,
				} satisfies SearchError,
				null,
				2,
			);
		}

		// Validate query doesn't contain control characters
		if (containsControlChars(query)) {
			return JSON.stringify(
				{
					error: true,
					type: 'invalid-query',
					message: 'Query contains invalid control characters',
				} satisfies SearchError,
				null,
				2,
			);
		}

		// Validate path traversal in include/exclude patterns
		if (include && containsPathTraversal(include)) {
			return JSON.stringify(
				{
					error: true,
					type: 'path-escape',
					message: 'Include pattern contains path traversal sequence',
				} satisfies SearchError,
				null,
				2,
			);
		}

		if (exclude && containsPathTraversal(exclude)) {
			return JSON.stringify(
				{
					error: true,
					type: 'path-escape',
					message: 'Exclude pattern contains path traversal sequence',
				} satisfies SearchError,
				null,
				2,
			);
		}

		// Validate include/exclude don't have Windows attacks
		if (include && containsWindowsAttacks(include)) {
			return JSON.stringify(
				{
					error: true,
					type: 'path-escape',
					message: 'Include pattern contains invalid Windows-specific sequence',
				} satisfies SearchError,
				null,
				2,
			);
		}

		if (exclude && containsWindowsAttacks(exclude)) {
			return JSON.stringify(
				{
					error: true,
					type: 'path-escape',
					message: 'Exclude pattern contains invalid Windows-specific sequence',
				} satisfies SearchError,
				null,
				2,
			);
		}

		// Validate workspace directory
		if (!fs.existsSync(directory)) {
			return JSON.stringify(
				{
					error: true,
					type: 'unknown',
					message: 'Workspace directory does not exist',
				} satisfies SearchError,
				null,
				2,
			);
		}

		let result: SearchResult | SearchError;

		if (_internals.resolveRipgrepBinary()) {
			result = await ripgrepSearch({
				query,
				mode,
				include,
				exclude,
				maxResults,
				maxLines,
				workspace: directory,
			});
		} else {
			result = await fallbackSearch({
				query,
				mode,
				include,
				exclude,
				maxResults,
				maxLines,
				workspace: directory,
			});
		}

		// Handle error responses
		if ('error' in result && result.error) {
			return JSON.stringify(result, null, 2);
		}

		return JSON.stringify(result, null, 2);
	},
});

export const _internals: {
	resolvePackagedRipgrep: typeof resolvePackagedRipgrep;
	resolveExecutableFromPath: typeof resolveExecutableFromPath;
	resolveRipgrepBinary: typeof resolveRipgrepBinary;
	runExternalTool: typeof runExternalTool;
	fallbackSearch: typeof fallbackSearch;
} = {
	resolvePackagedRipgrep,
	resolveExecutableFromPath,
	resolveRipgrepBinary,
	runExternalTool,
	fallbackSearch,
};
