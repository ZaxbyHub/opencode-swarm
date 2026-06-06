import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { tool } from '@opencode-ai/plugin';
import { z } from 'zod';
import {
	containsControlChars,
	containsPathTraversal,
} from '../utils/path-security';
import { createSwarmTool } from './create-tool';

// ============ Constants ============

const BLAME_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_LINES = 500;
const MAX_PATH_LENGTH = 500;
const MAX_LINE_NUMBER = 1_000_000;

const SHELL_METACHARACTERS = /[;|&$`(){}<>!'"]/;

const BINARY_EXTENSIONS = new Set([
	'.png',
	'.jpg',
	'.jpeg',
	'.gif',
	'.bmp',
	'.ico',
	'.svg',
	'.webp',
	'.mp3',
	'.mp4',
	'.wav',
	'.avi',
	'.mov',
	'.wmv',
	'.flv',
	'.zip',
	'.tar',
	'.gz',
	'.rar',
	'.7z',
	'.bz2',
	'.pdf',
	'.doc',
	'.docx',
	'.xls',
	'.xlsx',
	'.ppt',
	'.pptx',
	'.exe',
	'.dll',
	'.so',
	'.dylib',
	'.bin',
	'.dat',
	'.o',
	'.obj',
	'.woff',
	'.woff2',
	'.ttf',
	'.eot',
	'.otf',
	'.sqlite',
	'.db',
]);

// ============ Types ============

export interface BlameLine {
	line: number;
	sha: string;
	author: string;
	date: string;
	summary: string;
	content: string;
}

export interface GitBlameResult {
	file: string;
	lineCount: number;
	lines: BlameLine[];
}

export interface GitBlameError {
	error: string;
	file: string;
	lineCount: 0;
	lines: [];
}

// ============ Validation ============

/**
 * Validate a file path argument.
 * Rejects absolute paths, path traversal, shell metacharacters, and overly long paths.
 * Returns an error message string, or null if valid.
 */
function validateFilePath(filePath: string): string | null {
	if (!filePath || filePath.length === 0) {
		return 'file path is required';
	}
	if (filePath.length > MAX_PATH_LENGTH) {
		return `file path exceeds maximum length of ${MAX_PATH_LENGTH}`;
	}
	if (path.isAbsolute(filePath)) {
		return 'absolute paths are not allowed; use a relative path from the project root';
	}
	if (containsPathTraversal(filePath)) {
		return 'path traversal detected';
	}
	if (containsControlChars(filePath)) {
		return 'file path contains control characters';
	}
	if (SHELL_METACHARACTERS.test(filePath)) {
		return 'file path contains shell metacharacters';
	}
	if (filePath.startsWith('-')) {
		return 'file path cannot start with "-"';
	}
	return null;
}

/**
 * Validate a line number argument (start or end).
 */
function validateLineNumber(value: unknown, name: string): string | null {
	if (typeof value === 'undefined') return null;
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
		return `${name} must be a positive integer`;
	}
	if (value > MAX_LINE_NUMBER) {
		return `${name} exceeds maximum value of ${MAX_LINE_NUMBER}`;
	}
	return null;
}

/**
 * Check if a file has a binary extension.
 */
function isBinaryFile(filePath: string): boolean {
	const ext = path.extname(filePath).toLowerCase();
	return BINARY_EXTENSIONS.has(ext);
}

// ============ Porcelain Parser ============

interface RawBlameEntry {
	line: number;
	sha: string;
	author: string;
	authorTime: string;
	summary: string;
	content: string;
}

/**
 * Parse git blame --porcelain output into structured blame entries.
 *
 * Porcelain format per commit group:
 *   <sha> <orig-line> <result-line> [<num-lines>]
 *   author <name>
 *   author-mail <email>
 *   author-time <unix-timestamp>
 *   author-tz <tz-offset>
 *   summary <message>
 *   \t<content-line>   (repeats for each line in the group)
 */
interface CommitMetadata {
	author: string;
	authorTime: string;
	summary: string;
}

function parsePorcelainBlame(
	output: string,
	linesCap: number,
): RawBlameEntry[] {
	const entries: RawBlameEntry[] = [];
	const outputLines = output.split('\n');
	const cappedLines = outputLines.slice(0, linesCap * 8);

	const commitCache = new Map<string, CommitMetadata>();

	let currentSha = '';
	let currentLine = 0;
	let currentAuthor = '';
	let currentAuthorTime = '';
	let currentSummary = '';

	for (const rawLine of cappedLines) {
		// Header line: sha origLine resultLine [numLines]
		const headerMatch = rawLine.match(/^([0-9a-f]{40})\s+(\d+)\s+(\d+)/);
		if (headerMatch) {
			currentSha = headerMatch[1];
			currentLine = Number.parseInt(headerMatch[3], 10);

			// Re-inherit cached metadata for previously-seen commits
			const cached = commitCache.get(currentSha);
			if (cached) {
				currentAuthor = cached.author;
				currentAuthorTime = cached.authorTime;
				currentSummary = cached.summary;
			} else {
				currentAuthor = '';
				currentAuthorTime = '';
				currentSummary = '';
			}
			continue;
		}

		// Metadata lines — store into cache as well
		if (rawLine.startsWith('author ')) {
			currentAuthor = rawLine.slice(7);
			let meta = commitCache.get(currentSha);
			if (!meta) {
				meta = { author: '', authorTime: '', summary: '' };
				commitCache.set(currentSha, meta);
			}
			meta.author = currentAuthor;
			continue;
		}
		if (rawLine.startsWith('author-time ')) {
			currentAuthorTime = rawLine.slice(12);
			let meta = commitCache.get(currentSha);
			if (!meta) {
				meta = { author: '', authorTime: '', summary: '' };
				commitCache.set(currentSha, meta);
			}
			meta.authorTime = currentAuthorTime;
			continue;
		}
		if (rawLine.startsWith('summary ')) {
			currentSummary = rawLine.slice(8);
			let meta = commitCache.get(currentSha);
			if (!meta) {
				meta = { author: '', authorTime: '', summary: '' };
				commitCache.set(currentSha, meta);
			}
			meta.summary = currentSummary;
			continue;
		}

		// Content line (tab-prefixed)
		if (rawLine.startsWith('\t')) {
			entries.push({
				line: currentLine,
				sha: currentSha.slice(0, 8),
				author: currentAuthor,
				authorTime: currentAuthorTime,
				summary: currentSummary,
				content: rawLine.slice(1),
			});

			if (entries.length >= linesCap) break;
		}
	}

	return entries.slice(0, linesCap);
}

// ============ Tool Definition ============

export const git_blame: ReturnType<typeof tool> = createSwarmTool({
	description:
		'Analyze per-line git blame metadata for a file. Returns sha (abbreviated), author, date (ISO), summary, and content for each line. Uses git blame --porcelain. Rejects binary files and validates paths.',
	args: {
		file: z
			.string()
			.describe(
				'Relative file path to blame (required, relative to project root)',
			),
		start: z
			.number()
			.optional()
			.describe(
				'Optional start line number (1-indexed). Requires end parameter.',
			),
		end: z
			.number()
			.optional()
			.describe(
				'Optional end line number (1-indexed, inclusive). Requires start parameter.',
			),
	},
	async execute(args: unknown, directory: string): Promise<string> {
		// Safe args extraction
		let fileInput: string | undefined;
		let startInput: number | undefined;
		let endInput: number | undefined;

		try {
			if (args && typeof args === 'object') {
				const obj = args as Record<string, unknown>;
				fileInput = typeof obj.file === 'string' ? obj.file : undefined;
				startInput = typeof obj.start === 'number' ? obj.start : undefined;
				endInput = typeof obj.end === 'number' ? obj.end : undefined;
			}
		} catch {
			// Malicious getter threw
		}

		if (!fileInput) {
			return JSON.stringify({
				error: 'file path is required',
				file: String(fileInput ?? ''),
				lineCount: 0,
				lines: [],
			} satisfies GitBlameError);
		}

		const file = fileInput;

		// Validate file path
		const pathError = validateFilePath(file);
		if (pathError) {
			return JSON.stringify({
				error: pathError,
				file,
				lineCount: 0,
				lines: [],
			} satisfies GitBlameError);
		}

		// Validate line range
		const startError = validateLineNumber(startInput, 'start');
		if (startError) {
			return JSON.stringify({
				error: startError,
				file,
				lineCount: 0,
				lines: [],
			} satisfies GitBlameError);
		}

		const endError = validateLineNumber(endInput, 'end');
		if (endError) {
			return JSON.stringify({
				error: endError,
				file,
				lineCount: 0,
				lines: [],
			} satisfies GitBlameError);
		}

		// Both start and end must be provided together
		if (
			(startInput !== undefined && endInput === undefined) ||
			(startInput === undefined && endInput !== undefined)
		) {
			return JSON.stringify({
				error: 'both start and end must be provided together for a line range',
				file,
				lineCount: 0,
				lines: [],
			} satisfies GitBlameError);
		}

		if (
			startInput !== undefined &&
			endInput !== undefined &&
			startInput > endInput
		) {
			return JSON.stringify({
				error: 'start must be less than or equal to end',
				file,
				lineCount: 0,
				lines: [],
			} satisfies GitBlameError);
		}

		// Resolve the file path and check existence
		const resolvedPath = path.resolve(directory, file);
		if (!fs.existsSync(resolvedPath)) {
			return JSON.stringify({
				error: `file not found: ${file}`,
				file,
				lineCount: 0,
				lines: [],
			} satisfies GitBlameError);
		}

		// Check that the resolved path is within the workspace
		const realDir = fs.realpathSync(directory);
		const realPath = fs.realpathSync(resolvedPath);
		const relative = path.relative(realDir, realPath);
		if (relative.startsWith('..') || path.isAbsolute(relative)) {
			return JSON.stringify({
				error: 'file path resolves outside the workspace',
				file,
				lineCount: 0,
				lines: [],
			} satisfies GitBlameError);
		}

		// Check if file is a directory
		const stat = fs.statSync(resolvedPath);
		if (stat.isDirectory()) {
			return JSON.stringify({
				error: 'path is a directory, not a file',
				file,
				lineCount: 0,
				lines: [],
			} satisfies GitBlameError);
		}

		// Reject binary files
		if (isBinaryFile(file)) {
			return JSON.stringify({
				error: 'binary files are not supported for git blame',
				file,
				lineCount: 0,
				lines: [],
			} satisfies GitBlameError);
		}

		// Build git blame arguments
		const gitArgs: string[] = ['blame', '--porcelain'];
		if (startInput !== undefined && endInput !== undefined) {
			gitArgs.push('-L', `${startInput},${endInput}`);
		}
		gitArgs.push('--', file);

		// Execute git blame with array-form spawnSync (Invariant 3)
		const result = child_process.spawnSync('git', gitArgs, {
			cwd: directory,
			encoding: 'utf-8',
			timeout: BLAME_TIMEOUT_MS,
			windowsHide: true,
			maxBuffer: 5 * 1024 * 1024,
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		// Check for timeout FIRST (ETIMEDOUT is on result.error, not result.signal)
		if (result.error) {
			const isTimeout =
				'code' in result.error && result.error.code === 'ETIMEDOUT';
			if (isTimeout) {
				return JSON.stringify({
					error: 'git blame timed out',
					file,
					lineCount: 0,
					lines: [],
				} satisfies GitBlameError);
			}
			const message =
				result.error instanceof Error
					? result.error.message
					: String(result.error);
			if (message.includes('ENOENT') || message.includes('not found')) {
				return JSON.stringify({
					error: 'git is not available or not in PATH',
					file,
					lineCount: 0,
					lines: [],
				} satisfies GitBlameError);
			}
			return JSON.stringify({
				error: `git execution failed: ${message}`,
				file,
				lineCount: 0,
				lines: [],
			} satisfies GitBlameError);
		}

		if (result.status !== 0) {
			const stderr = (result.stderr ?? '').trim();
			if (
				stderr.includes('not a git repository') ||
				stderr.includes('not in a git repository')
			) {
				return JSON.stringify({
					error: 'not a git repository',
					file,
					lineCount: 0,
					lines: [],
				} satisfies GitBlameError);
			}
			if (
				stderr.includes('no such path') ||
				stderr.includes('did not match any files')
			) {
				return JSON.stringify({
					error: `file not tracked by git: ${file}`,
					file,
					lineCount: 0,
					lines: [],
				} satisfies GitBlameError);
			}
			return JSON.stringify({
				error: `git blame failed: ${stderr || `exit code ${result.status}`}`,
				file,
				lineCount: 0,
				lines: [],
			} satisfies GitBlameError);
		}

		// Secondary timeout check via signal (spawnSync may also set SIGTERM on kill)
		if (result.signal === 'SIGTERM' || result.signal === 'SIGKILL') {
			return JSON.stringify({
				error: 'git blame timed out',
				file,
				lineCount: 0,
				lines: [],
			} satisfies GitBlameError);
		}

		const stdout = result.stdout ?? '';

		if (!stdout.trim()) {
			return JSON.stringify({
				error: 'no blame output (file may be empty or untracked)',
				file,
				lineCount: 0,
				lines: [],
			} satisfies GitBlameError);
		}

		// Parse porcelain output with line cap
		const rawEntries = parsePorcelainBlame(stdout, MAX_OUTPUT_LINES);

		// Format dates as ISO strings and build result
		const lines: BlameLine[] = rawEntries.map((entry) => ({
			line: entry.line,
			sha: entry.sha,
			author: entry.author,
			date:
				Number.parseInt(entry.authorTime, 10) > 0
					? new Date(Number.parseInt(entry.authorTime, 10) * 1000)
							.toISOString()
							.slice(0, 10)
					: entry.authorTime,
			summary: entry.summary,
			content: entry.content,
		}));

		const resultJson: GitBlameResult = {
			file,
			lineCount: lines.length,
			lines,
		};

		return JSON.stringify(resultJson, null, 2);
	},
});
