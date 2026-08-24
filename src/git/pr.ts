import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { resolveGhBinary } from '../tools/gh-evidence.js';
import { mergeEnvForChild } from '../utils/bun-compat';
import { warn } from '../utils/logger.js';
import {
	isTransientSpawnError,
	MAX_TRANSIENT_RETRIES,
	transientBackoff,
} from '../utils/transient-retry.js';
import { neutralizeUntrustedMarkdown } from '../utils/untrusted-markdown.js';
import {
	commitChanges,
	getChangedFiles,
	getCurrentBranch,
	getCurrentSha,
	readLaneEnvFileFromDiskSync,
	stageAll,
} from './branch.js';

export const GIT_TIMEOUT_MS = 30_000;
const EvidencePlanSchema = z
	.object({
		phases: z
			.array(
				z
					.object({
						tasks: z
							.array(
								z
									.object({
										id: z.string(),
										status: z.string().optional(),
									})
									.passthrough(),
							)
							.optional(),
					})
					.passthrough(),
			)
			.optional(),
	})
	.passthrough();

/**
 * Sanitize input string to prevent command injection
 * Removes or escapes shell metacharacters
 */
export function sanitizeInput(input: string): string {
	// Remove newlines and control characters that could be exploited
	// Also escape common shell metacharacters
	return (
		input
			// biome-ignore lint/suspicious/noControlCharactersInRegex: regex built from string to avoid biome false positive on literal control characters
			.replace(/[\u0000-\u001F\u007F]/g, '') // Remove control characters
			.replace(/[`$"\\]/g, '\\$&') // Escape shell metacharacters
			.replace(/\n+/g, ' ') // Replace newlines with spaces
			.trim()
	);
}

/**
 * Execute gh CLI command
 *
 * Follows canonical gitExec safety pattern from branch.ts:
 * - result.error check before result.status
 * - maxBuffer to prevent ERR_CHILD_PROCESS_STDIO_MAXBUFFER on large output
 * - windowsHide: true to prevent console window flash on Windows
 * - Bounded transient retry for ETIMEDOUT per AGENTS.md invariant 9
 */
export function ghExec(args: string[], cwd: string): string {
	// Issue #2236 hardening (lane C1b): resolve the `gh` binary ONCE per call
	// via the shared resolver in `src/tools/gh-evidence.ts` (do not invent a
	// second one). `resolveGhBinary()` returns `null` when no candidate is
	// found; fall back to the bare `'gh'` literal so a host that resolves
	// `gh` via plain PATH lookup at spawn time never regresses (same
	// "never regress a working host" philosophy as
	// `resolveGitExecutable()`'s bare-`'git'` last-resort fallback).
	const ghBinary = _internals.resolveGhBinary() ?? 'gh';
	for (let attempt = 0; attempt < MAX_TRANSIENT_RETRIES; attempt++) {
		const result = child_process.spawnSync(ghBinary, args, {
			cwd,
			encoding: 'utf-8',
			timeout: GIT_TIMEOUT_MS,
			windowsHide: true,
			maxBuffer: MAX_OUTPUT_BYTES,
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		if (result.error) {
			if (
				isTransientSpawnError(result.error) &&
				attempt < MAX_TRANSIENT_RETRIES - 1
			) {
				transientBackoff(attempt);
				continue;
			}

			if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') {
				throw new Error(
					`gh failed to start: ENOENT — gh not installed or not on PATH`,
				);
			}
			throw new Error(
				`gh failed to start: ${(result.error as NodeJS.ErrnoException).code} — ${result.error.message}`,
			);
		}

		if (result.status !== 0) {
			throw new Error(
				result.stderr || result.stdout || `gh exited with ${result.status}`,
			);
		}
		return result.stdout;
	}

	// Should not reach here; loop exits via return or throw
	throw new Error('gh exited with null');
}

const MAX_OUTPUT_BYTES = 5 * 1024 * 1024; // 5MB cap per stream

/**
 * File-scoped indirection seam for spawnSync.
 * Supports envOverrides so lane runtime profiles can inject env.
 */
const __spawnSyncSeam = {
	spawnSync: (
		cmd: string,
		args: string[],
		options?: {
			cwd?: string;
			encoding?: BufferEncoding;
			timeout?: number;
			maxBuffer?: number;
			windowsHide?: boolean;
			stdio?:
				| 'pipe'
				| 'ignore'
				| 'inherit'
				| Array<'pipe' | 'ignore' | 'inherit'>;
			env?: Record<string, string | undefined>;
			envOverrides?: Record<string, string | null>;
		},
	) => {
		const mergedEnv = mergeEnvForChild(options?.env, options?.envOverrides);
		return child_process.spawnSync(cmd, args, {
			...options,
			env: mergedEnv as NodeJS.ProcessEnv | undefined,
		});
	},
};

/**
 * Shared spawnSync wrapper with bounded ETIMEDOUT-only transient retry.
 * Applies envOverrides to options.env before calling spawnSync.
 *
 * Mirrors the retry shape from ghExec (invariant 9):
 * - Up to MAX_TRANSIENT_RETRIES attempts with exponential backoff on ETIMEDOUT
 * - ENOENT and non-zero exit are thrown immediately (not retried)
 * - On success, returns the raw spawnSync result transparently
 */
function spawnSyncWithTransientRetry(
	command: string,
	args: string[],
	options?: {
		cwd?: string;
		encoding?: BufferEncoding;
		timeout?: number;
		maxBuffer?: number;
		windowsHide?: boolean;
		stdio?:
			| 'pipe'
			| 'ignore'
			| 'inherit'
			| Array<'pipe' | 'ignore' | 'inherit'>;
		env?: Record<string, string | undefined>;
		envOverrides?: Record<string, string | null>;
	},
): child_process.SpawnSyncReturns<string> {
	for (let attempt = 0; attempt < MAX_TRANSIENT_RETRIES; attempt++) {
		const result = __spawnSyncSeam.spawnSync(command, args, options);

		if (result.error) {
			if (
				isTransientSpawnError(result.error) &&
				attempt < MAX_TRANSIENT_RETRIES - 1
			) {
				transientBackoff(attempt);
				continue;
			}

			throw new Error(
				`${command} failed: ${(result.error as NodeJS.ErrnoException).code} — ${result.error.message}`,
			);
		}

		if (result.status !== 0) {
			const reason =
				(result.stderr as string) ||
				(result.stdout as string) ||
				`${command} exited with ${result.status}`;
			throw new Error(`${command} failed: ${reason}`);
		}

		return result as child_process.SpawnSyncReturns<string>;
	}

	// Unreachable — loop exits via return or throw
	throw new Error(`${command} exited with null`);
}

/**
 * Execute gh CLI command asynchronously (non-blocking).
 * Used by background workers that must not block the event loop.
 * Follows AGENTS.md Invariant 3: array-form spawn, explicit cwd,
 * stdin: 'ignore', timeout, bounded stdout/stderr, proc.kill() in finally.
 */
export async function ghExecAsync(
	args: string[],
	cwd: string,
): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		// See ghExec() above for the resolver rationale (issue #2236 hardening,
		// lane C1b) — same shared resolver, same bare-`'gh'` fallback.
		const ghBinary = _internals.resolveGhBinary() ?? 'gh';
		const proc = child_process.spawn(ghBinary, args, {
			cwd,
			// stdin must be 'ignore' to prevent pipe blocking on Windows (AGENTS.md v7.3.3)
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let settled = false;

		function cleanup() {
			clearTimeout(timer);
			if (!proc.killed) {
				try {
					proc.kill();
				} catch {
					/* best-effort */
				}
			}
		}

		function settle(fn: () => void) {
			if (settled) return;
			settled = true;
			cleanup();
			fn();
		}

		proc.stdout?.on('data', (chunk: Buffer) => {
			stdoutBytes += chunk.length;
			if (stdoutBytes > MAX_OUTPUT_BYTES) {
				settle(() =>
					reject(
						new Error(
							`gh ${args[0]} stdout exceeded ${MAX_OUTPUT_BYTES} bytes`,
						),
					),
				);
				return;
			}
			stdoutChunks.push(chunk);
		});

		proc.stderr?.on('data', (chunk: Buffer) => {
			stderrBytes += chunk.length;
			if (stderrBytes > MAX_OUTPUT_BYTES) {
				settle(() =>
					reject(
						new Error(
							`gh ${args[0]} stderr exceeded ${MAX_OUTPUT_BYTES} bytes`,
						),
					),
				);
				return;
			}
			stderrChunks.push(chunk);
		});

		const timer = setTimeout(() => {
			settle(() =>
				reject(new Error(`gh ${args[0]} timed out after ${GIT_TIMEOUT_MS}ms`)),
			);
		}, GIT_TIMEOUT_MS);

		proc.on('error', (err) => {
			settle(() => reject(err));
		});

		proc.on('close', (code) => {
			settle(() => {
				if (code !== 0) {
					const stderr = Buffer.concat(stderrChunks).toString('utf-8');
					reject(new Error(stderr || `gh exited with ${code}`));
				} else {
					const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
					resolve(stdout);
				}
			});
		});
	});
}

/**
 * Test-only dependency-injection seam — see `gitignore-warning.ts:_internals`.
 * Production code calls `_internals.ghExec(...)` so tests can replace the
 * function on this object without touching the real `child_process.spawnSync`.
 */
export const _internals: {
	ghExec: typeof ghExec;
	ghExecAsync: typeof ghExecAsync;
	spawnSyncWithTransientRetry: typeof spawnSyncWithTransientRetry;
	spawnSync: typeof __spawnSyncSeam.spawnSync;
	readLaneEnvFileFromDiskSync: typeof readLaneEnvFileFromDiskSync;
	getMergeGroupRun: typeof getMergeGroupRun;
	resolveGhBinary: typeof resolveGhBinary;
} = {
	ghExec,
	ghExecAsync,
	spawnSyncWithTransientRetry,
	spawnSync: __spawnSyncSeam.spawnSync,
	readLaneEnvFileFromDiskSync,
	getMergeGroupRun,
	resolveGhBinary,
};

/**
 * Check if gh CLI is available
 */
export function isGhAvailable(cwd: string): boolean {
	try {
		ghExec(['--version'], cwd);
		return true;
	} catch {
		return false;
	}
}

/**
 * Check if authenticated with gh
 */
export function isAuthenticated(cwd: string): boolean {
	try {
		ghExec(['auth', 'status'], cwd);
		return true;
	} catch {
		return false;
	}
}

/**
 * Create evidence.md summary
 */
export function generateEvidenceMd(cwd: string): string {
	const branch = getCurrentBranch(cwd);
	const sha = getCurrentSha(cwd);
	const files = getChangedFiles(cwd);

	let evidence = `# Evidence Summary\n\n`;
	evidence += `**Branch:** ${branch}\n`;
	evidence += `**SHA:** ${sha}\n`;
	evidence += `**Changed Files:** ${files.length}\n\n`;

	if (files.length > 0) {
		evidence += `## Changed Files\n\n`;
		for (const file of files) {
			evidence += `- ${file}\n`;
		}
	}

	// Add task completion info if available
	try {
		const planPath = path.join(cwd, '.swarm', 'plan.json');
		if (fs.existsSync(planPath)) {
			const plan = EvidencePlanSchema.parse(
				JSON.parse(fs.readFileSync(planPath, 'utf-8')),
			);
			evidence += `\n## Tasks\n\n`;
			for (const phase of plan.phases || []) {
				for (const task of phase.tasks || []) {
					const status = task.status || 'unknown';
					evidence += `- ${task.id}: ${status}\n`;
				}
			}
		}
	} catch (err) {
		warn('Failed to read plan.json for evidence', err);
	}

	return evidence;
}

/**
 * Create a pull request
 */
export async function createPullRequest(
	cwd: string,
	title: string,
	body?: string,
	baseBranch: string = 'main',
): Promise<{ url: string; number: number }> {
	const branch = await getCurrentBranch(cwd);
	const baseBranchResolved = baseBranch || 'main';

	// Generate body from evidence.md if not provided
	// Note: sanitizeInput removed — spawnSync with array args is already safe from injection
	const prBody = body || (await generateEvidenceMd(cwd));

	// Create PR using gh CLI (array-based spawnSync is shell-injection safe)
	const output = ghExec(
		[
			'pr',
			'create',
			'--title',
			title,
			'--body',
			prBody,
			'--base',
			baseBranchResolved,
			'--head',
			branch,
		],
		cwd,
	);

	// Parse PR URL from output
	const urlMatch = output.match(
		/https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/,
	);
	const numberMatch = output.match(/#(\d+)/);

	return {
		url: urlMatch ? urlMatch[0] : output.trim(),
		number: numberMatch ? parseInt(numberMatch[1], 10) : 0,
	};
}

/**
 * Commit and push current changes
 * @param cwd - Working directory
 * @param message - Commit message
 * @param laneEnv - Optional lane env overrides for git spawns
 * @param laneIndex - Optional lane index; if laneEnv not provided, reads env file from disk
 */
export async function commitAndPush(
	cwd: string,
	message: string,
	laneEnv?: Record<string, string>,
	laneIndex?: number,
): Promise<void> {
	// FR-201: fall back to sync disk read if laneEnv not provided but laneIndex is.
	const resolvedLaneEnv =
		laneEnv ??
		(laneIndex !== undefined
			? _internals.readLaneEnvFileFromDiskSync(cwd, laneIndex)
			: undefined);

	// Stage all changes
	stageAll(cwd, laneEnv, laneIndex);

	// Check if there are changes to commit
	const statusResult = spawnSyncWithTransientRetry(
		'git',
		['status', '--porcelain'],
		{
			cwd,
			encoding: 'utf-8',
			timeout: GIT_TIMEOUT_MS,
			windowsHide: true,
			maxBuffer: MAX_OUTPUT_BYTES,
			stdio: ['ignore', 'pipe', 'pipe'],
			envOverrides: resolvedLaneEnv,
		},
	);
	const status = statusResult.stdout;

	if (!status.trim()) {
		throw new Error('No changes to commit');
	}

	// Commit
	await commitChanges(cwd, message, laneEnv, laneIndex);

	// Push
	const branch = await getCurrentBranch(cwd, laneEnv, laneIndex);
	const _pushResult = spawnSyncWithTransientRetry(
		'git',
		['push', '-u', 'origin', branch],
		{
			cwd,
			encoding: 'utf-8',
			timeout: GIT_TIMEOUT_MS,
			windowsHide: true,
			maxBuffer: MAX_OUTPUT_BYTES,
			stdio: ['ignore', 'pipe', 'pipe'],
			envOverrides: resolvedLaneEnv,
		},
	);
	// spawnSyncWithTransientRetry throws on non-zero exit, so no status check needed here
}

// ── gh CLI PR status wrapper types ──────────────────────────────────

export interface PRStatusResult {
	number: number;
	state: 'OPEN' | 'CLOSED' | 'MERGED';
	mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
	mergeStateStatus: string;
	headRefOid: string;
	statusCheckRollup: Array<{
		name: string;
		status: string;
		conclusion: string | null;
		detailsUrl?: string;
	}>;
}

export interface PRCheckResult {
	name: string;
	bucket: string;
	state: string;
	startedAt: string | null;
	completedAt: string | null;
}

export interface PRCommentResult {
	id: string;
	author: string;
	body: string;
	createdAt: string;
	isReviewComment: boolean;
}

export interface MergeStateResult {
	mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
	mergeStateStatus: string;
	headRefOid: string;
}

export interface ReviewStateResult {
	/** Current review decision: APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or empty string. */
	reviewDecision: string;
	/** Number of requesting reviewers (non-zero means reviews are still pending). */
	reviewRequestCount: number;
}

// ── gh CLI PR status wrapper functions ──────────────────────────────

/**
 * Fetch PR status via gh pr view --json
 */
export async function getPRStatus(
	prNumber: number,
	repoFullName: string,
	cwd: string,
): Promise<PRStatusResult> {
	let stdout: string;
	try {
		stdout = await _internals.ghExecAsync(
			[
				'pr',
				'view',
				String(prNumber),
				'--repo',
				repoFullName,
				'--json',
				'number,state,mergeable,mergeStateStatus,headRefOid,statusCheckRollup',
			],
			cwd,
		);
	} catch (err) {
		throw new Error(
			`Failed to fetch PR status for ${repoFullName}#${prNumber}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	return JSON.parse(stdout) as PRStatusResult;
}

/**
 * Fetch CI check results via gh pr checks --json
 */
export async function getPRChecks(
	prNumber: number,
	repoFullName: string,
	cwd: string,
): Promise<PRCheckResult[]> {
	let stdout: string;
	try {
		stdout = await _internals.ghExecAsync(
			[
				'pr',
				'checks',
				String(prNumber),
				'--repo',
				repoFullName,
				'--json',
				'name,bucket,state,startedAt,completedAt',
			],
			cwd,
		);
	} catch (err) {
		throw new Error(
			`Failed to fetch PR checks for ${repoFullName}#${prNumber}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	return JSON.parse(stdout) as PRCheckResult[];
}

/**
 * Fetch PR comments since a given timestamp via gh api
 * Returns both issue comments and pull request review comments, merged together
 */
export async function getPRComments(
	prNumber: number,
	repoFullName: string,
	cwd: string,
	since?: string,
): Promise<PRCommentResult[]> {
	const query = since ? `?since=${since}` : '';
	const issueCommentsPath = `repos/${repoFullName}/issues/${prNumber}/comments${query}`;
	const reviewCommentsPath = `repos/${repoFullName}/pulls/${prNumber}/comments${query}`;

	let issueComments: Array<Record<string, unknown>>;
	let reviewComments: Array<Record<string, unknown>>;

	try {
		const issueRaw = await _internals.ghExecAsync(
			['api', issueCommentsPath],
			cwd,
		);
		issueComments = JSON.parse(issueRaw) as Array<Record<string, unknown>>;
	} catch (err) {
		throw new Error(
			`Failed to fetch issue comments for ${repoFullName}#${prNumber}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	try {
		const reviewRaw = await _internals.ghExecAsync(
			['api', reviewCommentsPath],
			cwd,
		);
		reviewComments = JSON.parse(reviewRaw) as Array<Record<string, unknown>>;
	} catch (err) {
		throw new Error(
			`Failed to fetch review comments for ${repoFullName}#${prNumber}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	const mapIssueComment = (c: Record<string, unknown>): PRCommentResult => ({
		id: String(c.id ?? ''),
		author: String((c.user as Record<string, unknown>)?.login ?? ''),
		body: neutralizeUntrustedMarkdown(
			String(c.body ?? ''),
			'GitHub issue comment',
		),
		createdAt: String(c.created_at ?? ''),
		isReviewComment: false,
	});

	const mapReviewComment = (c: Record<string, unknown>): PRCommentResult => ({
		id: String(c.id ?? ''),
		author: String((c.user as Record<string, unknown>)?.login ?? ''),
		body: neutralizeUntrustedMarkdown(
			String(c.body ?? ''),
			'GitHub review comment',
		),
		createdAt: String(c.created_at ?? ''),
		isReviewComment: true,
	});

	return [
		...issueComments.map(mapIssueComment),
		...reviewComments.map(mapReviewComment),
	];
}

/**
 * Fetch merge state (mergeable + mergeStateStatus) via gh pr view --json
 */
export async function getMergeState(
	prNumber: number,
	repoFullName: string,
	cwd: string,
): Promise<MergeStateResult> {
	let stdout: string;
	try {
		stdout = await _internals.ghExecAsync(
			[
				'pr',
				'view',
				String(prNumber),
				'--repo',
				repoFullName,
				'--json',
				'mergeable,mergeStateStatus,headRefOid',
			],
			cwd,
		);
	} catch (err) {
		throw new Error(
			`Failed to fetch merge state for ${repoFullName}#${prNumber}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	const parsed = JSON.parse(stdout) as {
		mergeable: string;
		mergeStateStatus: string;
		headRefOid: string;
	};
	return {
		mergeable: parsed.mergeable as MergeStateResult['mergeable'],
		mergeStateStatus: parsed.mergeStateStatus,
		headRefOid: parsed.headRefOid,
	};
}

/**
 * Fetch the current review state for a PR using `gh pr view --json reviewDecision,reviewRequests`.
 * Uses async ghExecAsync to avoid blocking the event loop.
 */
export async function getPRReviewState(
	prNumber: number,
	repoFullName: string,
	cwd: string,
): Promise<ReviewStateResult> {
	let stdout: string;
	try {
		stdout = await _internals.ghExecAsync(
			[
				'pr',
				'view',
				String(prNumber),
				'--repo',
				repoFullName,
				'--json',
				'reviewDecision,reviewRequests',
			],
			cwd,
		);
	} catch (err) {
		throw new Error(
			`Failed to fetch review state for ${repoFullName}#${prNumber}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	const parsed = JSON.parse(stdout) as {
		reviewDecision: string;
		reviewRequests: Array<{ login: string }>;
	};
	return {
		reviewDecision: parsed.reviewDecision ?? '',
		reviewRequestCount: parsed.reviewRequests?.length ?? 0,
	};
}

/**
 * Result of fetching a GitHub Actions run for a PR's merge group.
 */
export interface MergeGroupRunResult {
	/** Run status: queued, in_progress, completed. */
	status: string;
	/** Run conclusion: success, failure, cancelled, etc. */
	conclusion: string | null;
	/** HTML URL to the run. */
	htmlUrl: string;
}

/**
 * Fetch the merge group GitHub Actions run for a PR.
 *
 * Searches the PR's statusCheckRollup for the "Merge pull request" check,
 * extracts the run ID from its detailsUrl, and fetches the run details
 * via `gh run view`.
 *
 * Returns null if no merge group check is found (PR not in a merge queue).
 */
export async function getMergeGroupRun(
	statusCheckRollup: PRStatusResult['statusCheckRollup'],
	repoFullName: string,
	cwd: string,
): Promise<MergeGroupRunResult | null> {
	// Find the merge group check run in the status check rollup
	const mergeGroupCheck = statusCheckRollup.find(
		(check) => check.name === 'Merge pull request' && check.detailsUrl,
	);
	if (!mergeGroupCheck?.detailsUrl) {
		return null;
	}

	// Extract run ID from detailsUrl
	// Format: https://github.com/owner/repo/actions/runs/<run_id>
	const runIdMatch = mergeGroupCheck.detailsUrl.match(/\/actions\/runs\/(\d+)/);
	if (!runIdMatch) {
		return null;
	}
	const runId = runIdMatch[1];

	let stdout: string;
	try {
		stdout = await _internals.ghExecAsync(
			[
				'run',
				'view',
				runId,
				'--json',
				'status,conclusion,htmlUrl',
				'--repo',
				repoFullName,
			],
			cwd,
		);
	} catch (err) {
		throw new Error(
			`Failed to fetch merge group run for ${repoFullName}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	const parsed = JSON.parse(stdout) as {
		status: string;
		conclusion: string | null;
		htmlUrl: string;
	};
	return {
		status: parsed.status ?? '',
		conclusion: parsed.conclusion ?? null,
		htmlUrl: parsed.htmlUrl ?? '',
	};
}
