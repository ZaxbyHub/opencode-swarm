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

const ACTIONLINT_TIMEOUT_MS = 15_000;
const ACTIONLINT_MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const ACTIONLINT_MAX_STDERR_BYTES = 128 * 1024;
const DEFAULT_MAX_RESULTS = 200;
const HARD_CAP_RESULTS = 2_000;
const MAX_WORKFLOW_FILES = 500;
const MAX_WORKFLOW_DIRS = 200;
const MAX_WORKFLOW_DEPTH = 20;

interface ActionlintFinding {
	file: string;
	line: number;
	column: number;
	kind: string;
	message: string;
	endColumn?: number;
}

interface ActionlintResult {
	clean: boolean;
	findings: ActionlintFinding[];
	total: number;
	truncated: boolean;
	files: string[];
	command: string[];
	outputTruncated?: boolean;
	note?: string;
}

interface WorkflowDiscoveryResult {
	files: string[];
	truncated: boolean;
}

interface ActionlintError {
	error: true;
	type:
		| 'actionlint-not-found'
		| 'invalid-input'
		| 'path-escape'
		| 'timeout'
		| 'unknown';
	message: string;
}

function resolveActionlintBinary(): string | null {
	return _internals.resolveExecutableFromPath(['actionlint']);
}

function normalizeRelativeWorkflowFile(
	file: string,
	workspace: string,
): string | null {
	if (!file || containsControlChars(file) || containsPathTraversal(file)) {
		return null;
	}
	if (path.isAbsolute(file) || /^[A-Za-z]:[/\\]/.test(file)) {
		return null;
	}
	const normalizedInput = file
		.split(/[\\/]+/)
		.filter(Boolean)
		.join(path.sep);
	if (!/\.(ya?ml)$/i.test(normalizedInput)) {
		return null;
	}
	try {
		const realWorkspace = fs.realpathSync(workspace);
		const resolved = path.resolve(realWorkspace, normalizedInput);
		const realFile = fs.realpathSync(resolved);
		const relative = path.relative(realWorkspace, realFile);
		if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
			return null;
		}
		return relative.split(path.sep).join('/');
	} catch {
		return null;
	}
}

function discoverWorkflowFiles(workspace: string): WorkflowDiscoveryResult {
	const root = path.join(workspace, '.github', 'workflows');
	if (!fs.existsSync(root)) return { files: [], truncated: false };
	const files: string[] = [];
	let dirCount = 0;
	let truncated = false;

	const visit = (dir: string, depth = 0) => {
		if (
			files.length >= MAX_WORKFLOW_FILES ||
			dirCount >= MAX_WORKFLOW_DIRS ||
			depth > MAX_WORKFLOW_DEPTH
		) {
			truncated = true;
			return;
		}
		dirCount++;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (files.length >= MAX_WORKFLOW_FILES || dirCount >= MAX_WORKFLOW_DIRS) {
				truncated = true;
				break;
			}
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				visit(full, depth + 1);
			} else if (entry.isFile() && /\.(ya?ml)$/i.test(entry.name)) {
				const rel = normalizeRelativeWorkflowFile(
					path.relative(workspace, full),
					workspace,
				);
				if (rel) files.push(rel);
			}
		}
	};

	visit(root);
	return { files, truncated };
}

function parseActionlintOutput(
	stdout: string,
	workspace: string,
	maxResults: number,
): { findings: ActionlintFinding[]; total: number } {
	const findings: ActionlintFinding[] = [];
	let total = 0;

	for (const line of stdout.split('\n')) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);
			const file =
				typeof entry.filepath === 'string'
					? normalizeRelativeWorkflowFile(
							path.isAbsolute(entry.filepath)
								? path.relative(workspace, entry.filepath)
								: entry.filepath,
							workspace,
						)
					: null;
			if (!file) continue;
			total++;
			if (findings.length >= maxResults) continue;
			findings.push({
				file,
				line: typeof entry.line === 'number' ? entry.line : 1,
				column: typeof entry.column === 'number' ? entry.column : 1,
				kind: typeof entry.kind === 'string' ? entry.kind : 'unknown',
				message: typeof entry.message === 'string' ? entry.message : '',
				endColumn:
					typeof entry.end_column === 'number' ? entry.end_column : undefined,
			});
		} catch {
			// Ignore malformed lines from mixed stdout.
		}
	}

	return { findings, total };
}

function sanitizeMaxResults(value: unknown): number {
	const numeric =
		typeof value === 'number' && Number.isFinite(value)
			? value
			: DEFAULT_MAX_RESULTS;
	return Math.min(Math.max(0, numeric), HARD_CAP_RESULTS);
}

export const actionlint_scan: ToolDefinition = createSwarmTool({
	description:
		'Run actionlint against GitHub Actions workflow YAML files and return structured findings. Read-only; resolves actionlint lazily.',
	args: {
		files: z
			.array(z.string())
			.optional()
			.describe(
				'Optional workspace-relative workflow YAML files. Defaults to .github/workflows/**/*.yml,yaml.',
			),
		max_results: z
			.number()
			.default(DEFAULT_MAX_RESULTS)
			.describe('Maximum findings to return'),
	},
	execute: async (args: unknown, directory: string) => {
		const obj = (
			typeof args === 'object' && args !== null ? args : {}
		) as Record<string, unknown>;
		const maxResults = sanitizeMaxResults(obj.max_results);
		const requestedFiles = Array.isArray(obj.files) ? obj.files : undefined;
		if (requestedFiles?.some((f) => typeof f !== 'string')) {
			return JSON.stringify(
				{
					error: true,
					type: 'invalid-input',
					message: 'files must be an array of strings',
				} satisfies ActionlintError,
				null,
				2,
			);
		}

		const discovery = requestedFiles
			? {
					files: requestedFiles
						.map((f) => normalizeRelativeWorkflowFile(f, directory))
						.filter((f): f is string => Boolean(f)),
					truncated: false,
				}
			: _internals.discoverWorkflowFiles(directory);
		let files = discovery.files;

		if (requestedFiles && files.length !== requestedFiles.length) {
			return JSON.stringify(
				{
					error: true,
					type: 'path-escape',
					message:
						'files must be existing workspace-relative GitHub Actions YAML files',
				} satisfies ActionlintError,
				null,
				2,
			);
		}
		const uniqueFiles = Array.from(new Set(files));
		const cappedFiles = uniqueFiles.slice(0, MAX_WORKFLOW_FILES);
		const discoveryTruncated =
			discovery.truncated || uniqueFiles.length > cappedFiles.length;
		files = cappedFiles;

		if (files.length === 0) {
			return JSON.stringify(
				{
					clean: !discoveryTruncated,
					findings: [],
					total: 0,
					truncated: discoveryTruncated,
					files: [],
					command: ['actionlint', '-format', '{{json .}}'],
					note: discoveryTruncated
						? `Workflow discovery was truncated at ${MAX_WORKFLOW_FILES} files, ${MAX_WORKFLOW_DIRS} directories, or depth ${MAX_WORKFLOW_DEPTH}; result is incomplete.`
						: 'No GitHub Actions workflow YAML files found',
				} satisfies ActionlintResult,
				null,
				2,
			);
		}

		const executable = _internals.resolveActionlintBinary();
		if (!executable) {
			return JSON.stringify(
				{
					error: true,
					type: 'actionlint-not-found',
					message:
						'actionlint executable not found. Install actionlint and ensure it is on PATH.',
				} satisfies ActionlintError,
				null,
				2,
			);
		}

		const lintArgs = [
			'-format',
			'{{json .}}',
			...files.map((file) => `./${file}`),
		];
		const run = await _internals.runExternalTool({
			executable,
			args: lintArgs,
			cwd: directory,
			timeoutMs: ACTIONLINT_TIMEOUT_MS,
			maxStdoutBytes: ACTIONLINT_MAX_STDOUT_BYTES,
			maxStderrBytes: ACTIONLINT_MAX_STDERR_BYTES,
		});

		if (run.status === 'timeout') {
			return JSON.stringify(
				{
					error: true,
					type: 'timeout',
					message: `actionlint timed out after ${ACTIONLINT_TIMEOUT_MS}ms`,
				} satisfies ActionlintError,
				null,
				2,
			);
		}
		if (run.status === 'spawn-error') {
			return JSON.stringify(
				{
					error: true,
					type: 'unknown',
					message: run.message ?? 'actionlint failed to start',
				} satisfies ActionlintError,
				null,
				2,
			);
		}

		const { findings, total } = parseActionlintOutput(
			run.stdout,
			directory,
			maxResults,
		);
		const hardError = run.exitCode !== 0 && findings.length === 0 && run.stderr;
		if (hardError) {
			return JSON.stringify(
				{
					error: true,
					type: 'unknown',
					message: run.stderr.split('\n')[0],
				} satisfies ActionlintError,
				null,
				2,
			);
		}

		return JSON.stringify(
			{
				findings,
				total,
				truncated:
					discoveryTruncated ||
					total > maxResults ||
					run.stdoutTruncated ||
					run.stderrTruncated,
				files,
				command: ['actionlint', ...lintArgs],
				outputTruncated: run.stdoutTruncated || run.stderrTruncated,
				clean:
					findings.length === 0 &&
					total === 0 &&
					!discoveryTruncated &&
					!run.stdoutTruncated &&
					!run.stderrTruncated,
				note: discoveryTruncated
					? `Workflow discovery was truncated at ${MAX_WORKFLOW_FILES} files, ${MAX_WORKFLOW_DIRS} directories, or depth ${MAX_WORKFLOW_DEPTH}; result is incomplete.`
					: undefined,
			} satisfies ActionlintResult,
			null,
			2,
		);
	},
});

export const _internals: {
	resolveExecutableFromPath: typeof resolveExecutableFromPath;
	resolveActionlintBinary: typeof resolveActionlintBinary;
	runExternalTool: typeof runExternalTool;
	discoverWorkflowFiles: typeof discoverWorkflowFiles;
	parseActionlintOutput: typeof parseActionlintOutput;
} = {
	resolveExecutableFromPath,
	resolveActionlintBinary,
	runExternalTool,
	discoverWorkflowFiles,
	parseActionlintOutput,
};
