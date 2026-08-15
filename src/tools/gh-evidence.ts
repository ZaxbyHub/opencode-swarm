import path from 'node:path';
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
	'assignees',
	'body',
	'changedFiles',
	'closedAt',
	'comments',
	'commits',
	'createdAt',
	'deletions',
	'files',
	'labels',
	'latestReviews',
	'mergedAt',
	'milestone',
	'reviews',
	'updatedAt',
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

const PR_FIELD_ALIASES = new Map<string, string>([
	['changed_files', 'changedFiles'],
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

interface GhBinaryCandidateOptions {
	env?: Pick<
		NodeJS.ProcessEnv,
		'ProgramFiles' | 'ProgramFiles(x86)' | 'LOCALAPPDATA'
	>;
	platform?: NodeJS.Platform;
}

export function resolveGhBinaryCandidates(
	options: GhBinaryCandidateOptions = {},
): string[] {
	const platform = options.platform ?? process.platform;
	if (platform !== 'win32') return ['gh'];

	const env = options.env ?? process.env;
	const candidates = ['gh'];
	const pushCandidate = (...parts: string[]): void => {
		const candidate = path.join(...parts);
		if (!candidates.includes(candidate)) candidates.push(candidate);
	};

	if (env.ProgramFiles) {
		pushCandidate(env.ProgramFiles, 'GitHub CLI', 'gh.exe');
	}
	if (env['ProgramFiles(x86)']) {
		pushCandidate(env['ProgramFiles(x86)'], 'GitHub CLI', 'gh.exe');
	}
	if (env.LOCALAPPDATA) {
		pushCandidate(env.LOCALAPPDATA, 'GitHub CLI', 'gh.exe');
		pushCandidate(env.LOCALAPPDATA, 'Programs', 'GitHub CLI', 'gh.exe');
	}

	return candidates;
}

function resolveGhBinary(): string | null {
	return _internals.resolveExecutableFromPath(resolveGhBinaryCandidates());
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
	const canonicalizeField = (field: string): string =>
		target === 'pr' ? (PR_FIELD_ALIASES.get(field) ?? field) : field;
	const allowlist =
		target === 'pr'
			? PR_FIELD_ALLOWLIST
			: target === 'issue'
				? ISSUE_FIELD_ALLOWLIST
				: RUN_FIELD_ALLOWLIST;
	const fields = Array.from(
		new Set(raw.map((f) => canonicalizeField(f.trim())).filter(Boolean)),
	);
	const allowedList = Array.from(allowlist).sort().join(', ');
	if (fields.length === 0) {
		return {
			error: true,
			type: 'invalid-input',
			message: `no ${target} fields provided. Allowed ${target} fields: ${allowedList}.`,
		};
	}
	// A field is rejected when it is unknown OR carries control characters. Names
	// bearing control chars are never echoed back (they could smuggle escape
	// sequences into logs/messages), so they are dropped from the printed list
	// while still forcing the rejection.
	const rejected = fields.filter(
		(f) => containsControlChars(f) || !allowlist.has(f),
	);
	if (rejected.length > 0) {
		const printable = rejected
			.filter((f) => !containsControlChars(f))
			.map((f) => (f.length > 60 ? `${f.slice(0, 60)}...` : f))
			.slice(0, 12);
		const rejectedText =
			printable.length > 0
				? printable.join(', ')
				: '(names omitted: contain control characters)';
		return {
			error: true,
			type: 'invalid-input',
			message: `unsupported ${target} field(s): ${rejectedText}. Allowed ${target} fields: ${allowedList}.`,
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

/**
 * Actionable guidance emitted when the gh CLI is not on PATH.
 *
 * There is DELIBERATELY no hidden REST fallback wired in. Two reasons make a
 * silent transport swap unsafe: (1) the in-repo web_fetch tool pins a public IP,
 * blocks loopback, and ignores HTTPS_PROXY, so it cannot be a general REST
 * client from inside the plugin; (2) field-shape divergence — `gh --json`
 * returns camelCase keys plus gh-only synthesized fields (statusCheckRollup,
 * reviewDecision, mergeStateStatus) absent from the snake_case api.github.com
 * REST payload, so auto-swapping transports would return a differently-shaped
 * object under the same contract and mislead readers. Instead we hand the caller
 * the exact REST URL and the gate-allowed degraded read path.
 */
function ghNotFoundGuidance(
	target: 'pr' | 'issue' | 'run',
	number: number,
	repo: string | undefined,
	logFailed: boolean,
): string {
	const repoSlug = repo ?? '<owner>/<name>';
	const restPath =
		target === 'pr'
			? `pulls/${number}`
			: target === 'issue'
				? `issues/${number}`
				: `actions/runs/${number}`;
	const restUrl = `https://api.github.com/repos/${repoSlug}/${restPath}`;
	const lines = [
		'GitHub CLI (gh) not found on PATH. Install gh for full evidence.',
		`Degraded read-only path: fetch ${restUrl} with the web fetch tool (a gate-allowed observation).`,
	];
	if (!repo) {
		lines.push(
			'No repo argument was provided, so the URL uses an <owner>/<name> placeholder; pass repo as "owner/name" to make it fetchable.',
		);
	}
	lines.push(
		'Caveats: REST returns snake_case keys and omits gh-only fields (statusCheckRollup, reviewDecision, mergeStateStatus). Public repos work unauthenticated; private repos need gh or an authenticated client.',
	);
	if (target === 'run' && logFailed) {
		lines.push(
			'Note: log_failed job logs are gh-only and have no REST-URL equivalent.',
		);
	}
	return lines.join(' ');
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
					message: ghNotFoundGuidance(target, number, repo, logFailed),
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
			data = neutralizeUntrustedMarkdown(
				run.stdout,
				'GitHub Actions failed-job log',
			);
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
	resolveGhBinaryCandidates: typeof resolveGhBinaryCandidates;
	resolveExecutableFromPath: typeof resolveExecutableFromPath;
	resolveGhBinary: typeof resolveGhBinary;
	runExternalTool: typeof runExternalTool;
} = {
	resolveGhBinaryCandidates,
	resolveExecutableFromPath,
	resolveGhBinary,
	runExternalTool,
};
