import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import {
	resolveExecutableFromPath,
	runExternalTool,
} from '../utils/external-tool-runner';
import { containsControlChars } from '../utils/path-security';
import { createSwarmTool } from './create-tool';

const GH_TIMEOUT_MS = 20_000;
const GH_MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const GH_MAX_STDERR_BYTES = 128 * 1024;

const DEFAULT_PR_FIELDS = [
	'number',
	'title',
	'state',
	'isDraft',
	'author',
	'headRefName',
	'headRefOid',
	'baseRefName',
	'baseRefOid',
	'mergeable',
	'mergeStateStatus',
	'reviewDecision',
	'statusCheckRollup',
	'url',
] as const;

const DEFAULT_ISSUE_FIELDS = [
	'number',
	'title',
	'state',
	'author',
	'labels',
	'assignees',
	'url',
] as const;

const PR_FIELD_ALLOWLIST = new Set([
	...DEFAULT_PR_FIELDS,
	'additions',
	'body',
	'changedFiles',
	'commits',
	'deletions',
	'files',
	'latestReviews',
	'reviews',
]);

const ISSUE_FIELD_ALLOWLIST = new Set([
	...DEFAULT_ISSUE_FIELDS,
	'body',
	'comments',
	'closed',
	'closedAt',
	'createdAt',
	'milestone',
	'updatedAt',
]);

interface GhEvidenceResult {
	target: 'pr' | 'issue';
	number: number;
	repo?: string;
	fields: string[];
	command: string[];
	data: unknown;
	outputTruncated?: boolean;
}

interface GhEvidenceError {
	error: true;
	type: 'gh-not-found' | 'invalid-input' | 'timeout' | 'unknown';
	message: string;
}

function resolveGhBinary(): string | null {
	return _internals.resolveExecutableFromPath(['gh']);
}

function normalizeRepo(value: unknown): string | undefined | GhEvidenceError {
	if (value === undefined || value === null || value === '') return undefined;
	if (typeof value !== 'string' || containsControlChars(value)) {
		return {
			error: true,
			type: 'invalid-input',
			message: 'repo must be an owner/name string',
		};
	}
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
		return {
			error: true,
			type: 'invalid-input',
			message: 'repo must match owner/name',
		};
	}
	return value;
}

function normalizeFields(
	target: 'pr' | 'issue',
	value: unknown,
): string[] | GhEvidenceError {
	const defaults =
		target === 'pr'
			? Array.from(DEFAULT_PR_FIELDS)
			: Array.from(DEFAULT_ISSUE_FIELDS);
	if (value === undefined || value === null || value === '') return defaults;
	const raw = Array.isArray(value)
		? value
		: typeof value === 'string'
			? value.split(',')
			: null;
	if (!raw || raw.some((f) => typeof f !== 'string')) {
		return {
			error: true,
			type: 'invalid-input',
			message: 'fields must be a comma-separated string or string array',
		};
	}
	const allowlist =
		target === 'pr' ? PR_FIELD_ALLOWLIST : ISSUE_FIELD_ALLOWLIST;
	const fields = Array.from(new Set(raw.map((f) => f.trim()).filter(Boolean)));
	if (
		fields.length === 0 ||
		fields.some((f) => containsControlChars(f) || !allowlist.has(f))
	) {
		return {
			error: true,
			type: 'invalid-input',
			message: `fields must be selected from the ${target} allowlist`,
		};
	}
	return fields;
}

function sanitizeParsedJson(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sanitizeParsedJson);
	}
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			if (
				typeof entry === 'string' &&
				(entry.length > 20_000 || key === 'body')
			) {
				out[key] = `${entry.slice(0, 20_000)}... [truncated]`;
			} else {
				out[key] = sanitizeParsedJson(entry);
			}
		}
		return out;
	}
	return value;
}

export const gh_evidence: ToolDefinition = createSwarmTool({
	description:
		'Fetch bounded GitHub pull request or issue metadata via gh for review evidence. Read-only; resolves gh lazily.',
	args: {
		target: z
			.enum(['pr', 'issue'])
			.default('pr')
			.describe('GitHub object type to view: pr or issue'),
		number: z.number().describe('Pull request or issue number'),
		repo: z
			.string()
			.optional()
			.describe('Optional owner/repo. If omitted, gh uses the current repo.'),
		fields: z
			.union([z.string(), z.array(z.string())])
			.optional()
			.describe(
				'Optional JSON fields. Defaults to high-signal bounded PR or issue fields.',
			),
	},
	execute: async (args: unknown, directory: string) => {
		const obj = (
			typeof args === 'object' && args !== null ? args : {}
		) as Record<string, unknown>;
		const target = obj.target === 'issue' ? 'issue' : 'pr';
		const number = typeof obj.number === 'number' ? obj.number : NaN;
		if (!Number.isInteger(number) || number <= 0) {
			return JSON.stringify(
				{
					error: true,
					type: 'invalid-input',
					message: 'number must be a positive integer',
				} satisfies GhEvidenceError,
				null,
				2,
			);
		}
		const repo = normalizeRepo(obj.repo);
		if (repo && typeof repo === 'object') {
			return JSON.stringify(repo, null, 2);
		}
		const fields = normalizeFields(target, obj.fields);
		if (!Array.isArray(fields)) {
			return JSON.stringify(fields, null, 2);
		}

		const executable = _internals.resolveGhBinary();
		if (!executable) {
			return JSON.stringify(
				{
					error: true,
					type: 'gh-not-found',
					message:
						'GitHub CLI executable not found. Install gh and ensure it is on PATH.',
				} satisfies GhEvidenceError,
				null,
				2,
			);
		}

		const ghArgs = [target, 'view', String(number), '--json', fields.join(',')];
		if (repo) {
			ghArgs.push('--repo', repo);
		}
		const run = await _internals.runExternalTool({
			executable,
			args: ghArgs,
			cwd: directory,
			timeoutMs: GH_TIMEOUT_MS,
			maxStdoutBytes: GH_MAX_STDOUT_BYTES,
			maxStderrBytes: GH_MAX_STDERR_BYTES,
		});

		if (run.status === 'timeout') {
			return JSON.stringify(
				{
					error: true,
					type: 'timeout',
					message: `gh ${target} view timed out after ${GH_TIMEOUT_MS}ms`,
				} satisfies GhEvidenceError,
				null,
				2,
			);
		}
		if (run.status === 'spawn-error') {
			return JSON.stringify(
				{
					error: true,
					type: 'unknown',
					message: run.message ?? 'gh failed to start',
				} satisfies GhEvidenceError,
				null,
				2,
			);
		}
		if (run.exitCode !== 0) {
			return JSON.stringify(
				{
					error: true,
					type: 'unknown',
					message: run.stderr.split('\n')[0] || `gh exited ${run.exitCode}`,
				} satisfies GhEvidenceError,
				null,
				2,
			);
		}

		let data: unknown;
		try {
			data = sanitizeParsedJson(JSON.parse(run.stdout));
		} catch {
			return JSON.stringify(
				{
					error: true,
					type: 'unknown',
					message: 'gh output was not valid JSON',
				} satisfies GhEvidenceError,
				null,
				2,
			);
		}

		return JSON.stringify(
			{
				target,
				number,
				repo,
				fields,
				command: ['gh', ...ghArgs],
				data,
				outputTruncated: run.stdoutTruncated || run.stderrTruncated,
			} satisfies GhEvidenceResult,
			null,
			2,
		);
	},
});

export const _internals: {
	resolveExecutableFromPath: typeof resolveExecutableFromPath;
	resolveGhBinary: typeof resolveGhBinary;
	runExternalTool: typeof runExternalTool;
} = {
	resolveExecutableFromPath,
	resolveGhBinary,
	runExternalTool,
};
