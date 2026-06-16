import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { warn } from '../utils/logger.js';
import {
	commitChanges,
	getChangedFiles,
	getCurrentBranch,
	getCurrentSha,
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
 */
export function ghExec(args: string[], cwd: string): string {
	const result = child_process.spawnSync('gh', args, {
		cwd,
		encoding: 'utf-8',
		timeout: GIT_TIMEOUT_MS,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || `gh exited with ${result.status}`);
	}
	return result.stdout;
}

const MAX_OUTPUT_BYTES = 5 * 1024 * 1024; // 5MB cap per stream

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
		const proc = child_process.spawn('gh', args, {
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
} = { ghExec, ghExecAsync };

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
	const branch = getCurrentBranch(cwd);
	const baseBranchResolved = baseBranch || 'main';

	// Generate body from evidence.md if not provided
	// Note: sanitizeInput removed — spawnSync with array args is already safe from injection
	const prBody = body || generateEvidenceMd(cwd);

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
 */
export function commitAndPush(cwd: string, message: string): void {
	// Stage all changes
	stageAll(cwd);

	// Check if there are changes to commit
	const status = child_process.spawnSync('git', ['status', '--porcelain'], {
		cwd,
		encoding: 'utf-8',
	}).stdout;

	if (!status.trim()) {
		throw new Error('No changes to commit');
	}

	// Commit
	commitChanges(cwd, message);

	// Push
	const branch = getCurrentBranch(cwd);
	const pushResult = child_process.spawnSync(
		'git',
		['push', '-u', 'origin', branch],
		{
			cwd,
			encoding: 'utf-8',
			timeout: GIT_TIMEOUT_MS,
			stdio: ['ignore', 'pipe', 'pipe'],
		},
	);
	if (pushResult.status !== 0) {
		throw new Error(pushResult.stderr || 'Push failed');
	}
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
		body: String(c.body ?? ''),
		createdAt: String(c.created_at ?? ''),
		isReviewComment: false,
	});

	const mapReviewComment = (c: Record<string, unknown>): PRCommentResult => ({
		id: String(c.id ?? ''),
		author: String((c.user as Record<string, unknown>)?.login ?? ''),
		body: String(c.body ?? ''),
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
