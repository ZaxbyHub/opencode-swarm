import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import {
	resolveExecutableFromPath,
	runExternalTool,
} from '../utils/external-tool-runner';
import { containsControlChars } from '../utils/path-security';
import { neutralizeUntrustedMarkdown } from '../utils/untrusted-markdown';
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

const DEFAULT_RUN_FIELDS = [
	'status',
	'conclusion',
	'htmlUrl',
	'headBranch',
	'headSha',
] as const;

const RUN_FIELD_ALLOWLIST = new Set([
	...DEFAULT_RUN_FIELDS,
	'name',
	'workflowId',
	'runNumber',
	'event',
	'runStartedAt',
	'createdAt',
	'updatedAt',
]);

interface GhEvidenceResult {
	target: 'pr' | 'issue' | 'run';
	number: number;
	repo?: string;
	fields: string[];
	command: string[];
	data: unknown;
	outputTruncated?: boolean;
	/** Present when target is 'run' */
	runStatus?: string;
	runConclusion?: string | null;
	runHtmlUrl?: string;
	runHeadBranch?: string;
	runHeadSha?: string;
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
	target: 'pr' | 'issue' | 'run',
	value: unknown,
): string[] | GhEvidenceError {
	const defaults =
		target === 'pr'
			? Array.from(DEFAULT_PR_FIELDS)
			: target === 'issue'
				? Array.from(DEFAULT_ISSUE_FIELDS)
				: Array.from(DEFAULT_RUN_FIELDS);
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
		target === 'pr'
			? PR_FIELD_ALLOWLIST
			: target === 'issue'
				? ISSUE_FIELD_ALLOWLIST
				: RUN_FIELD_ALLOWLIST;
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
			if (typeof entry === 'string') {
				const bounded =
					entry.length > 20_000
						? `${entry.slice(0, 20_000)}... [truncated]`
						: entry;
				out[key] =
					key === 'body'
						? neutralizeUntrustedMarkdown(bounded, 'GitHub body')
						: bounded;
				continue;
			}
			out[key] = sanitizeParsedJson(entry);
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
			.enum(['pr', 'issue', 'run'])
			.default('pr')
			.describe('GitHub object type to view: pr, issue, or run'),
		number: z.number().describe('Pull request, issue, or run number'),
		repo: z
			.string()
			.optional()
			.describe('Optional owner/repo. If omitted, gh uses the current repo.'),
		fields: z
			.union([z.string(), z.array(z.string())])
			.optional()
			.describe(
				'Optional JSON fields. Defaults to high-signal bounded PR or issue fields. Ignored for run with log_failed.',
			),
		log_failed: z
			.boolean()
			.optional()
			.default(false)
			.describe(
				'When true with target=run, fetches failed job logs instead of JSON',
			),
	},
	execute: async (args: unknown, directory: string) => {
		const obj = (
			typeof args === 'object' && args !== null ? args : {}
		) as Record<string, unknown>;
		const rawTarget = obj.target;
		const target: 'pr' | 'issue' | 'run' =
			rawTarget === 'issue' ? 'issue' : rawTarget === 'run' ? 'run' : 'pr';
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
		const logFailed: boolean = obj.log_failed === true;
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

		// Build gh arguments based on target and log_failed flag
		const ghArgs: string[] = [target, 'view', String(number)];
		// log_failed is only valid with target=run; when set, skip --json and get raw log output
		const isLogFailedMode = target === 'run' && logFailed;
		if (!isLogFailedMode) {
			ghArgs.push('--json', fields.join(','));
		}
		if (repo) {
			ghArgs.push('--repo', repo);
		}
		if (isLogFailedMode) {
			ghArgs.push('--log-failed');
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
		let runStatus: string | undefined;
		let runConclusion: string | null | undefined;
		let runHtmlUrl: string | undefined;
		let runHeadBranch: string | undefined;
		let runHeadSha: string | undefined;

		if (isLogFailedMode) {
			// For --log-failed, output is raw text (not JSON)
			data = run.stdout;
		} else {
			// Parse JSON output and extract run-specific metadata
			let parsed: unknown;
			try {
				parsed = JSON.parse(run.stdout);
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
			data = sanitizeParsedJson(parsed);
			// Extract run metadata if available
			if (
				target === 'run' &&
				parsed !== null &&
				(Array.isArray(parsed) || typeof parsed !== 'object')
			) {
				// Non-object JSON (array, primitive) is not valid run metadata — return error
				return JSON.stringify(
					{
						error: true,
						type: 'invalid-input',
						message:
							'gh run view --json returned an array or primitive instead of a run object',
					} satisfies GhEvidenceError,
					null,
					2,
				);
			}
			if (target === 'run' && parsed && typeof parsed === 'object') {
				const runData = parsed as Record<string, unknown>;
				runStatus =
					typeof runData.status === 'string' ? runData.status : undefined;
				runConclusion =
					runData.conclusion === null
						? null
						: typeof runData.conclusion === 'string'
							? runData.conclusion
							: undefined;
				runHtmlUrl =
					typeof runData.htmlUrl === 'string' ? runData.htmlUrl : undefined;
				runHeadBranch =
					typeof runData.headBranch === 'string'
						? runData.headBranch
						: undefined;
				runHeadSha =
					typeof runData.headSha === 'string' ? runData.headSha : undefined;
			}
		}

		return JSON.stringify(
			{
				target,
				number,
				repo,
				fields: isLogFailedMode ? [] : fields,
				command: ['gh', ...ghArgs],
				data,
				outputTruncated: run.stdoutTruncated || run.stderrTruncated,
				...(target === 'run' && {
					runStatus,
					runConclusion,
					runHtmlUrl,
					runHeadBranch,
					runHeadSha,
				}),
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
