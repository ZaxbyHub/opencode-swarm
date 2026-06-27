import * as fs from 'node:fs';
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

const AST_GREP_TIMEOUT_MS = 10_000;
const AST_GREP_MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const AST_GREP_MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_MAX_RESULTS = 100;
const HARD_CAP_RESULTS = 10_000;
const MAX_PATTERN_LENGTH = 20_000;

interface AstGrepMatch {
	file: string;
	lineNumber: number;
	column: number;
	endLineNumber: number;
	endColumn: number;
	text: string;
	lines: string;
	language?: string;
	metaVariables?: unknown;
}

interface AstGrepResult {
	matches: AstGrepMatch[];
	truncated: boolean;
	total: number;
	pattern: string;
	language?: string;
	maxResults: number;
	outputTruncated?: boolean;
}

interface AstGrepError {
	error: true;
	type:
		| 'ast-grep-not-found'
		| 'invalid-pattern'
		| 'path-escape'
		| 'timeout'
		| 'unknown';
	message: string;
}

function splitGlobPatterns(value?: string): string[] {
	return value
		? value
				.split(',')
				.map((p) => p.trim())
				.filter(Boolean)
		: [];
}

function resolveAstGrepBinary(): string | null {
	return _internals.resolveExecutableFromPath(['ast-grep', 'sg']);
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

function parseAstGrepStream(
	stdout: string,
	workspace: string,
	maxResults: number,
): { matches: AstGrepMatch[]; total: number } {
	const matches: AstGrepMatch[] = [];
	let total = 0;

	for (const line of stdout.split('\n')) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);
			const relativePath =
				typeof entry.file === 'string'
					? toWorkspaceRelativePath(entry.file, workspace)
					: null;
			if (!relativePath) continue;

			total++;
			if (matches.length >= maxResults) continue;

			const start = entry.range?.start ?? {};
			const end = entry.range?.end ?? {};
			matches.push({
				file: relativePath,
				lineNumber: typeof start.line === 'number' ? start.line + 1 : 1,
				column: typeof start.column === 'number' ? start.column + 1 : 1,
				endLineNumber: typeof end.line === 'number' ? end.line + 1 : 1,
				endColumn: typeof end.column === 'number' ? end.column + 1 : 1,
				text: typeof entry.text === 'string' ? entry.text : '',
				lines: typeof entry.lines === 'string' ? entry.lines.trimEnd() : '',
				language:
					typeof entry.language === 'string' ? entry.language : undefined,
				metaVariables:
					entry.metaVariables && typeof entry.metaVariables === 'object'
						? entry.metaVariables
						: undefined,
			});
		} catch {
			// Ignore malformed lines. ast-grep --json=stream emits one object per line.
		}
	}

	return { matches, total };
}

function validateGlobArg(
	kind: 'Include' | 'Exclude',
	value?: string,
): AstGrepError | null {
	if (!value) return null;
	if (containsControlChars(value)) {
		return {
			error: true,
			type: 'path-escape',
			message: `${kind} pattern contains invalid control characters`,
		};
	}
	if (containsPathTraversal(value)) {
		return {
			error: true,
			type: 'path-escape',
			message: `${kind} pattern contains path traversal sequence`,
		};
	}
	return null;
}

export const ast_grep: ToolDefinition = createSwarmTool({
	description:
		'Read-only structural AST search using ast-grep. Searches code patterns with optional language and glob filters; does not rewrite files.',
	args: {
		pattern: z.string().describe('ast-grep pattern to search for'),
		language: z
			.string()
			.optional()
			.describe('Optional ast-grep language, e.g. ts, tsx, js, py, rust'),
		include: z
			.string()
			.optional()
			.describe('Comma-separated include globs, passed to ast-grep --globs'),
		exclude: z
			.string()
			.optional()
			.describe('Comma-separated exclude globs, passed to ast-grep as !glob'),
		max_results: z
			.number()
			.default(DEFAULT_MAX_RESULTS)
			.describe('Maximum number of matches to return'),
	},
	execute: async (args: unknown, directory: string) => {
		let pattern: string;
		let language: string | undefined;
		let include: string | undefined;
		let exclude: string | undefined;
		let maxResults = DEFAULT_MAX_RESULTS;

		try {
			const obj = args as Record<string, unknown>;
			pattern = typeof obj.pattern === 'string' ? obj.pattern : '';
			language = typeof obj.language === 'string' ? obj.language : undefined;
			include = typeof obj.include === 'string' ? obj.include : undefined;
			exclude = typeof obj.exclude === 'string' ? obj.exclude : undefined;
			const rawMaxResults =
				typeof obj.max_results === 'number'
					? obj.max_results
					: DEFAULT_MAX_RESULTS;
			const sanitizedMaxResults = Number.isFinite(rawMaxResults)
				? rawMaxResults
				: DEFAULT_MAX_RESULTS;
			maxResults = Math.min(Math.max(0, sanitizedMaxResults), HARD_CAP_RESULTS);
		} catch {
			return JSON.stringify(
				{
					error: true,
					type: 'invalid-pattern',
					message: 'Could not parse ast_grep arguments',
				} satisfies AstGrepError,
				null,
				2,
			);
		}

		if (!pattern || pattern.trim() === '') {
			return JSON.stringify(
				{
					error: true,
					type: 'invalid-pattern',
					message: 'Pattern cannot be empty',
				} satisfies AstGrepError,
				null,
				2,
			);
		}
		if (pattern.length > MAX_PATTERN_LENGTH || containsControlChars(pattern)) {
			return JSON.stringify(
				{
					error: true,
					type: 'invalid-pattern',
					message: `Pattern is invalid or exceeds ${MAX_PATTERN_LENGTH} characters`,
				} satisfies AstGrepError,
				null,
				2,
			);
		}
		if (language && !/^[A-Za-z0-9_-]+$/.test(language)) {
			return JSON.stringify(
				{
					error: true,
					type: 'invalid-pattern',
					message: 'Language must contain only letters, numbers, _ or -',
				} satisfies AstGrepError,
				null,
				2,
			);
		}

		const includeError = validateGlobArg('Include', include);
		if (includeError) return JSON.stringify(includeError, null, 2);
		const excludeError = validateGlobArg('Exclude', exclude);
		if (excludeError) return JSON.stringify(excludeError, null, 2);

		if (!fs.existsSync(directory)) {
			return JSON.stringify(
				{
					error: true,
					type: 'unknown',
					message: 'Workspace directory does not exist',
				} satisfies AstGrepError,
				null,
				2,
			);
		}

		const executable = _internals.resolveAstGrepBinary();
		if (!executable) {
			return JSON.stringify(
				{
					error: true,
					type: 'ast-grep-not-found',
					message:
						'ast-grep executable not found. Install ast-grep and ensure ast-grep or sg is on PATH.',
				} satisfies AstGrepError,
				null,
				2,
			);
		}

		const sgArgs = [
			'run',
			'--pattern',
			pattern,
			'--json=stream',
			'--color',
			'never',
		];
		if (language) {
			sgArgs.push('--lang', language);
		}
		for (const glob of splitGlobPatterns(include)) {
			sgArgs.push('--globs', glob);
		}
		for (const glob of splitGlobPatterns(exclude)) {
			sgArgs.push('--globs', `!${glob}`);
		}
		sgArgs.push('.');

		const run = await _internals.runExternalTool({
			executable,
			args: sgArgs,
			cwd: directory,
			timeoutMs: AST_GREP_TIMEOUT_MS,
			maxStdoutBytes: AST_GREP_MAX_STDOUT_BYTES,
			maxStderrBytes: AST_GREP_MAX_STDERR_BYTES,
		});

		if (run.status === 'timeout') {
			return JSON.stringify(
				{
					error: true,
					type: 'timeout',
					message: `ast-grep timed out after ${AST_GREP_TIMEOUT_MS}ms`,
				} satisfies AstGrepError,
				null,
				2,
			);
		}
		if (run.status === 'spawn-error') {
			return JSON.stringify(
				{
					error: true,
					type: 'unknown',
					message: run.message ?? 'ast-grep failed to start',
				} satisfies AstGrepError,
				null,
				2,
			);
		}
		if (run.exitCode !== 0 && run.stderr) {
			return JSON.stringify(
				{
					error: true,
					type: 'invalid-pattern',
					message: run.stderr.split('\n')[0],
				} satisfies AstGrepError,
				null,
				2,
			);
		}

		const { matches, total } = parseAstGrepStream(
			run.stdout,
			directory,
			maxResults,
		);
		return JSON.stringify(
			{
				matches,
				truncated:
					total > maxResults || run.stdoutTruncated || run.stderrTruncated,
				total,
				pattern,
				language,
				maxResults,
				outputTruncated: run.stdoutTruncated || run.stderrTruncated,
			} satisfies AstGrepResult,
			null,
			2,
		);
	},
});

export const _internals: {
	resolveExecutableFromPath: typeof resolveExecutableFromPath;
	resolveAstGrepBinary: typeof resolveAstGrepBinary;
	runExternalTool: typeof runExternalTool;
	parseAstGrepStream: typeof parseAstGrepStream;
} = {
	resolveExecutableFromPath,
	resolveAstGrepBinary,
	runExternalTool,
	parseAstGrepStream,
};
