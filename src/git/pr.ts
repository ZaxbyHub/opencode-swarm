/**
 * GitHub/GitLab PR helpers via `gh` / `glab` spawns.
 *
 * Forgejo: no GitHub GraphQL — prefer `repo` / `fj` for forge operations.
 * `ghExec` applies `forge.gh_forgejo` env overrides only when that bridge is
 * explicitly enabled (`on` or matching `auto` remote); default is off.
 */
import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { mergeEnvForChild } from '../utils/bun-compat';
import {
	resolveForgejoGhEnvOverrides,
} from '../utils/forgejo-gh-env.js';
import { resolveGhExecutable } from '../utils/gh-executable.js';
import { resolveGitExecutable } from '../utils/git-executable.js';
import { resolveGlabExecutable } from '../utils/glab-executable.js';
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
import { assertSafeGitRefArg } from './safe-ref';

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
	// second one). Since #2476 AC1 the hardened resolver
	// (`src/utils/gh-executable.ts`) returns the bare `'gh'` literal itself
	// when nothing validates, so a host that resolves `gh` via plain PATH
	// lookup at spawn time never regresses (same
	// "never regress a working host" philosophy as
	// `resolveGitExecutable()`'s bare-`'git'` last-resort fallback).
	// #2476 AC1: the hardened gh resolver never returns null — the bare
	// 'gh' fallback is its own terminal outcome (probe/caching live in
	// src/utils/gh-executable.ts).
	const ghBinary = _internals.resolveGhExecutable();
	const forgejoGhEnv = resolveForgejoGhEnvOverrides(cwd);
	for (let attempt = 0; attempt < MAX_TRANSIENT_RETRIES; attempt++) {
		const result = __spawnSyncSeam.spawnSync(ghBinary, args, {
			cwd,
			encoding: 'utf-8',
			timeout: GIT_TIMEOUT_MS,
			maxBuffer: MAX_OUTPUT_BYTES,
			windowsHide: true,
			stdio: ['ignore', 'pipe', 'pipe'],
			envOverrides: forgejoGhEnv ?? undefined,
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
			const reason =
				(result.stderr as string) ||
				(result.stdout as string) ||
				`gh exited with ${result.status}`;
			throw new Error(reason);
		}
		return result.stdout as string;
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
	// See ghExec() above for the resolver rationale (issue #2236 hardening,
	// lane C1b) — same shared resolver, same bare-`'gh'` fallback.
	return _internals.forgeExecAsync(
		_internals.resolveGhExecutable(),
		args,
		cwd,
		'gh',
	);
}

/**
 * Bounded async spawn shared by the gh and glab (GitLab) fetch paths
 * (issue #2882). Same safety contract as the pre-#2882 ghExecAsync body:
 * array-form argv, explicit cwd, stdin 'ignore', GIT_TIMEOUT_MS timeout,
 * MAX_OUTPUT_BYTES per-stream caps, best-effort proc.kill() on settle.
 *
 * `label` names the CLI in error messages ('gh' / 'glab') so existing
 * GitHub-path error text is unchanged. `opts.env` is an overlay merged onto
 * process.env via mergeEnvForChild ONLY when defined — an absent overlay
 * leaves the spawn options without an `env` key, preserving the inherit-
 * process.env behavior the gh path has always had.
 */
async function forgeExecAsyncImpl(
	binary: string,
	args: string[],
	cwd: string,
	label: string,
	opts?: { env?: Record<string, string> },
): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const spawnOptions: child_process.SpawnOptions = {
			cwd,
			// stdin must be 'ignore' to prevent pipe blocking on Windows (AGENTS.md v7.3.3)
			stdio: ['ignore', 'pipe', 'pipe'],
		};
		if (opts?.env) {
			spawnOptions.env = mergeEnvForChild(undefined, opts.env) as
				| NodeJS.ProcessEnv
				| undefined;
		}
		const proc = child_process.spawn(binary, args, spawnOptions);

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
							`${label} ${args[0]} stdout exceeded ${MAX_OUTPUT_BYTES} bytes`,
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
							`${label} ${args[0]} stderr exceeded ${MAX_OUTPUT_BYTES} bytes`,
						),
					),
				);
				return;
			}
			stderrChunks.push(chunk);
		});

		const timer = setTimeout(() => {
			settle(() =>
				reject(
					new Error(`${label} ${args[0]} timed out after ${GIT_TIMEOUT_MS}ms`),
				),
			);
		}, GIT_TIMEOUT_MS);

		proc.on('error', (err) => {
			settle(() => reject(err));
		});

		proc.on('close', (code) => {
			settle(() => {
				if (code !== 0) {
					const stderr = Buffer.concat(stderrChunks).toString('utf-8');
					reject(new Error(stderr || `${label} exited with ${code}`));
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
	forgeExecAsync: typeof forgeExecAsyncImpl;
	getMRPollSnapshot: typeof getMRPollSnapshot;
	getMRComments: typeof getMRComments;
	spawnSyncWithTransientRetry: typeof spawnSyncWithTransientRetry;
	spawnSync: typeof __spawnSyncSeam.spawnSync;
	readLaneEnvFileFromDiskSync: typeof readLaneEnvFileFromDiskSync;
	getMergeGroupRun: typeof getMergeGroupRun;
	resolveGhExecutable: typeof resolveGhExecutable;
	resolveGitExecutable: typeof resolveGitExecutable;
	resolveGlabExecutable: typeof resolveGlabExecutable;
} = {
	ghExec,
	ghExecAsync,
	forgeExecAsync: forgeExecAsyncImpl,
	getMRPollSnapshot,
	getMRComments,
	spawnSyncWithTransientRetry,
	spawnSync: __spawnSyncSeam.spawnSync,
	readLaneEnvFileFromDiskSync,
	getMergeGroupRun,
	resolveGhExecutable,
	resolveGitExecutable,
	resolveGlabExecutable,
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
	// #2476 AC4: wrapper-hidden bare 'git' literals must route through the
	// shared resolver like every other spawn site.
	const statusResult = spawnSyncWithTransientRetry(
		_internals.resolveGitExecutable(),
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
	// Issue #2476 AC3: branch is repository-derived (getCurrentBranch git
	// output); a hostile repo can advertise a dash-leading branch name, which
	// git would parse as an option in the refspec position (source #2265).
	// `push <remote> -- <refspec>` is semantics-preserving for benign names
	// and fail-closed for hostile ones (R3 probe), plus the validation guard.
	assertSafeGitRefArg(branch, 'commitAndPush push refspec');
	const _pushResult = spawnSyncWithTransientRetry(
		_internals.resolveGitExecutable(),
		['push', '-u', 'origin', '--', branch],
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

// ── consolidated per-PR poll fetch (issues #1660/#2471) ──────────────

/** All per-PR data one poll cycle needs, in two gh spawns. */
export interface PRPollSnapshot {
	status: PRStatusResult;
	comments: PRCommentResult[];
	merge: MergeStateResult;
	review: ReviewStateResult;
}

/**
 * Fetch status, merge state, review state and conversation (issue) comments
 * with ONE `gh pr view --json` call. Previously this was three near-duplicate
 * pr-view spawns (status/merge/review) plus two gh api spawns per PR per poll.
 *
 * `comments[].id` from pr-view is the GraphQL node id, NOT the numeric
 * database id the REST endpoints return. The numeric id is recovered from the
 * comment permalink (`#issuecomment-<id>` suffix, verified equal to the REST
 * id on gh >= 2.92) so `lastCommentId` markers written by earlier versions
 * keep matching; the node id remains the defensive fallback (a warn is
 * logged if it ever fires — fallback ids change the marker space).
 */
export async function getPRPollSnapshot(
	prNumber: number,
	repoFullName: string,
	cwd: string,
): Promise<PRPollSnapshot> {
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
				// `comments` returns the FULL conversation list in one payload
				// (the old gh api calls returned 30/endpoint by REST default).
				// Bounded above by ghExecAsync's MAX_OUTPUT_BYTES, and a
				// strictly better event surface than the old first-30 window.
				'number,state,mergeable,mergeStateStatus,headRefOid,statusCheckRollup,reviewDecision,reviewRequests,comments',
			],
			cwd,
		);
	} catch (err) {
		throw new Error(
			`Failed to fetch PR poll snapshot for ${repoFullName}#${prNumber}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	const parsed = JSON.parse(stdout) as {
		number: number;
		state: string;
		mergeable: string;
		mergeStateStatus: string;
		headRefOid: string;
		statusCheckRollup?: PRStatusResult['statusCheckRollup'];
		reviewDecision?: string;
		reviewRequests?: Array<{ login: string }>;
		comments?: Array<{
			id?: string;
			author?: { login?: string } | null;
			body?: string | null;
			createdAt?: string;
			url?: string;
		}>;
	};
	const permalinkFallbacks: string[] = [];
	const snapshot: PRPollSnapshot = {
		status: {
			number: parsed.number,
			state: parsed.state as PRStatusResult['state'],
			mergeable: parsed.mergeable as PRStatusResult['mergeable'],
			mergeStateStatus: parsed.mergeStateStatus,
			headRefOid: parsed.headRefOid,
			statusCheckRollup: parsed.statusCheckRollup ?? [],
		},
		comments: (parsed.comments ?? []).map((c) => ({
			id: numericIssueCommentId(c.url, c.id, permalinkFallbacks),
			author: String(c.author?.login ?? ''),
			body: neutralizeUntrustedMarkdown(
				String(c.body ?? ''),
				'GitHub issue comment',
			),
			createdAt: String(c.createdAt ?? ''),
			isReviewComment: false,
		})),
		merge: {
			mergeable: parsed.mergeable as MergeStateResult['mergeable'],
			mergeStateStatus: parsed.mergeStateStatus,
			headRefOid: parsed.headRefOid,
		},
		review: {
			reviewDecision: parsed.reviewDecision ?? '',
			reviewRequestCount: parsed.reviewRequests?.length ?? 0,
		},
	};
	if (permalinkFallbacks.length > 0) {
		// Defensive path only: gh currently always emits comment permalinks.
		// Fallback ids (GraphQL node ids) change the lastCommentId marker
		// space, so surface it rather than silently re-baselining dedup.
		warn(
			`[PrMonitorWorker] ${permalinkFallbacks.length} comment(s) missing #issuecomment permalink; using node-id fallback for lastCommentId`,
		);
	}
	return snapshot;
}

/** Recover the REST numeric comment id from a `#issuecomment-<id>` permalink. */
function numericIssueCommentId(
	url: unknown,
	fallbackId: unknown,
	fallbacks: string[],
): string {
	if (typeof url === 'string') {
		const match = url.match(/#issuecomment-(\d+)/);
		if (match) return match[1];
	}
	fallbacks.push(String(fallbackId ?? ''));
	return String(fallbackId ?? '');
}

/**
 * Fetch inline pull-request review comments via gh api — the review half of
 * the old two-endpoint getPRComments (the issue-comment half now rides the
 * pr-view snapshot). Inline review comments have no `gh pr view --json`
 * equivalent, so this stays the second spawn of the poll cycle.
 */
export async function getPRReviewComments(
	prNumber: number,
	repoFullName: string,
	cwd: string,
): Promise<PRCommentResult[]> {
	let stdout: string;
	try {
		stdout = await _internals.ghExecAsync(
			['api', `repos/${repoFullName}/pulls/${prNumber}/comments`],
			cwd,
		);
	} catch (err) {
		throw new Error(
			`Failed to fetch review comments for ${repoFullName}#${prNumber}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	const reviewComments = JSON.parse(stdout) as Array<Record<string, unknown>>;
	return reviewComments.map((c) => ({
		id: String(c.id ?? ''),
		author: String((c.user as Record<string, unknown>)?.login ?? ''),
		body: neutralizeUntrustedMarkdown(
			String(c.body ?? ''),
			'GitHub review comment',
		),
		createdAt: String(c.created_at ?? ''),
		isReviewComment: true,
	}));
}

// ── GitLab MR fetch layer (issue #2882) ──────────────────────────────

/**
 * Honest-unavailable marker for the three GitHub-synthesized fields
 * (statusCheckRollup / reviewDecision / mergeStateStatus). `getProviderCapabilities`
 * is the source of truth: GitLab reports all three unavailable, so the glab-backed
 * snapshot carries explicit markers instead of fabricated equivalents (#2733 AC7).
 */
export const MR_SYNTHESIZED_FIELD_MARKER = 'NOT_AVAILABLE';

/** Input for glab-backed MR fetches. `host` is the resolved forge host. */
export interface MRFetchInput {
	/** Full project path (may be multi-segment: group/subgroup/repo). */
	projectPath: string;
	/** Merge request iid (the subscription's prNumber). */
	iid: number;
	cwd: string;
	/** Forge host; when present and not gitlab.com, spawns get GITLAB_HOST. */
	host?: string;
}

/** Check-shaped entry derived from a real GitLab pipeline (NOT a statusCheckRollup member). */
export interface MRPipelineCheck {
	name: string;
	status: string;
	conclusion: string | null;
	detailsUrl?: string;
}

/** glab-backed MR snapshot: PRPollSnapshot-compatible core plus a pipelines channel. */
export interface MRPollSnapshot {
	status: PRStatusResult;
	comments: PRCommentResult[];
	merge: MergeStateResult;
	review: ReviewStateResult;
	/** Terminal pipeline verdicts for the MR head sha (empty when none terminal yet). */
	pipelines: MRPipelineCheck[];
	/** False when the pipelines fetch failed — caller preserves prior CI state. */
	pipelinesFetchSucceeded: boolean;
}

/** gitlab mr view -F json object (subset actually consumed). */
interface GlabMrView {
	state?: unknown;
	sha?: unknown;
	detailed_merge_status?: unknown;
	has_conflicts?: unknown;
	reviewers?: unknown;
	web_url?: unknown;
}

/** glab api merge_requests/<iid> REST detail (subset consumed). */
interface GlabMrDetail {
	merge_status?: unknown;
}

/** glab api merge_requests/<iid>/pipelines entry (subset consumed). */
interface GlabMrPipeline {
	id?: unknown;
	sha?: unknown;
	status?: unknown;
	web_url?: unknown;
}

/** glab api merge_requests/<iid>/notes entry (subset consumed). */
interface GlabMrNote {
	id?: unknown;
	body?: unknown;
	system?: unknown;
	author?: { username?: unknown } | null;
	created_at?: unknown;
}

function glabSpawnEnv(
	input: MRFetchInput,
): { env: Record<string, string> } | undefined {
	if (!input.host || input.host === 'gitlab.com') return undefined;
	// Documented glab host-selection env (gitlab.com/gitlab-org/cli
	// docs/source/api/_index.md + internal/glrepo): scopes `mr view -R` and
	// `glab api` to the declared self-hosted instance for this spawn only.
	return { env: { GITLAB_HOST: input.host } };
}

/** Map GitLab MR state to the PRStatusResult state vocabulary. */
function mapMrState(state: unknown): 'OPEN' | 'CLOSED' | 'MERGED' {
	if (state === 'merged') return 'MERGED';
	if (state === 'closed') return 'CLOSED';
	// opened + locked (discussion-locked MR is still open) and unknowns map OPEN.
	return 'OPEN';
}

/**
 * Map GitLab merge-state signals to the mergeable vocabulary. Only real
 * signals map; anything unrecognized is UNKNOWN (never fabricated).
 */
function mapMrMergeable(
	mr: GlabMrView,
	detail: GlabMrDetail,
): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
	if (mr.has_conflicts === true) return 'CONFLICTING';
	if (mr.detailed_merge_status === 'conflict') return 'CONFLICTING';
	if (detail.merge_status === 'cannot_be_merged') return 'CONFLICTING';
	if (mr.detailed_merge_status === 'mergeable') return 'MERGEABLE';
	if (detail.merge_status === 'can_be_merged') return 'MERGEABLE';
	return 'UNKNOWN';
}

/** Terminal pipeline statuses map to check conclusions; everything else is non-terminal (no verdict). */
function mapPipelineConclusion(status: unknown): 'success' | 'failure' | null {
	if (status === 'success') return 'success';
	if (status === 'failed') return 'failure';
	return null;
}

/**
 * glab-backed MR snapshot (issue #2882): three bounded spawns.
 *  1. `glab mr view <iid> -R <projectPath> -F json` — MR fields.
 *  2. `glab api projects/<url-encoded-path>/merge_requests/<iid>` — REST
 *     detail (deprecated-but-present merge_status; the issue prescribes this
 *     call for merge state). Approvals on this payload are intentionally NOT
 *     consumed: no existing event vocabulary maps to GitLab approvals without
 *     fabricating the GitHub-synthesized reviewDecision (#2733 AC7 binding).
 *  3. `glab api .../merge_requests/<iid>/pipelines?per_page=20` — pipelines
 *     for the MR, filtered to the head sha, latest by id, terminal-only.
 */
export async function getMRPollSnapshot(
	input: MRFetchInput,
): Promise<MRPollSnapshot> {
	const overlay = glabSpawnEnv(input);
	const glabBinary = _internals.resolveGlabExecutable();

	let viewStdout: string;
	try {
		viewStdout = await _internals.forgeExecAsync(
			glabBinary,
			['mr', 'view', String(input.iid), '-R', input.projectPath, '-F', 'json'],
			input.cwd,
			'glab',
			overlay,
		);
	} catch (err) {
		throw new Error(
			`Failed to fetch MR view for ${input.projectPath}!${input.iid}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	const mr = JSON.parse(viewStdout) as GlabMrView;

	let detailStdout: string;
	try {
		detailStdout = await _internals.forgeExecAsync(
			glabBinary,
			[
				'api',
				`projects/${encodeURIComponent(input.projectPath)}/merge_requests/${input.iid}`,
			],
			input.cwd,
			'glab',
			overlay,
		);
	} catch (err) {
		throw new Error(
			`Failed to fetch MR detail for ${input.projectPath}!${input.iid}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	const detail = JSON.parse(detailStdout) as GlabMrDetail;

	let pipelines: MRPipelineCheck[] = [];
	let pipelinesFetchSucceeded = false;
	try {
		const pipelinesStdout = await _internals.forgeExecAsync(
			glabBinary,
			[
				'api',
				`projects/${encodeURIComponent(input.projectPath)}/merge_requests/${input.iid}/pipelines?per_page=20`,
			],
			input.cwd,
			'glab',
			overlay,
		);
		const rawPipelines = JSON.parse(pipelinesStdout) as GlabMrPipeline[];
		// Ordering is undocumented for this endpoint — sort by id desc and take
		// the latest pipeline whose sha matches the MR head sha.
		const headSha = typeof mr.sha === 'string' ? mr.sha : '';
		const forHead = rawPipelines
			.filter((p) => typeof p.sha === 'string' && p.sha === headSha)
			.sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0));
		const latest = forHead[0];
		const conclusion = mapPipelineConclusion(latest?.status);
		pipelines =
			latest && conclusion
				? [
						{
							name: `pipeline #${String(latest.id ?? '')}`,
							status: 'completed',
							conclusion,
							...(typeof latest.web_url === 'string'
								? { detailsUrl: latest.web_url }
								: {}),
						},
					]
				: [];
		pipelinesFetchSucceeded = true;
	} catch {
		// Pipeline fetch failure is a partial degradation, not a snapshot
		// failure: merge-state fields stand, caller preserves prior CI state.
		pipelines = [];
		pipelinesFetchSucceeded = false;
	}

	const state = mapMrState(mr.state);
	const mergeable = mapMrMergeable(mr, detail);
	const reviewers = Array.isArray(mr.reviewers) ? mr.reviewers.length : 0;

	return {
		status: {
			number: input.iid,
			state,
			mergeable,
			mergeStateStatus: MR_SYNTHESIZED_FIELD_MARKER,
			headRefOid: typeof mr.sha === 'string' ? mr.sha : '',
			// Honest-unavailable marker (capability-gated): never populated from
			// pipeline data — pipelines ride their own channel into the CI events.
			statusCheckRollup: [],
		},
		comments: [],
		merge: {
			mergeable,
			mergeStateStatus: MR_SYNTHESIZED_FIELD_MARKER,
			headRefOid: typeof mr.sha === 'string' ? mr.sha : '',
		},
		review: {
			// Honest-unavailable marker: '' produces no review events (same as
			// GitHub's missing-reviewDecision mapping).
			reviewDecision: '',
			reviewRequestCount: reviewers,
		},
		pipelines,
		pipelinesFetchSucceeded,
	};
}

/**
 * glab-backed MR comments (issue #2882): the MR notes endpoint, ascending by
 * creation time, system notes excluded (automation notes are not user
 * comments). Bounded single page (per_page=100).
 */
export async function getMRComments(
	input: MRFetchInput,
): Promise<PRCommentResult[]> {
	let stdout: string;
	try {
		stdout = await _internals.forgeExecAsync(
			_internals.resolveGlabExecutable(),
			[
				'api',
				`projects/${encodeURIComponent(input.projectPath)}/merge_requests/${input.iid}/notes?per_page=100&sort=asc&order_by=created_at`,
			],
			input.cwd,
			'glab',
			glabSpawnEnv(input),
		);
	} catch (err) {
		throw new Error(
			`Failed to fetch MR comments for ${input.projectPath}!${input.iid}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	const notes = JSON.parse(stdout) as GlabMrNote[];
	return notes
		.filter((note) => note.system !== true)
		.map((note) => ({
			id: String(note.id ?? ''),
			author: String(note.author?.username ?? ''),
			body: neutralizeUntrustedMarkdown(
				String(note.body ?? ''),
				'GitLab MR note',
			),
			createdAt: String(note.created_at ?? ''),
			isReviewComment: false,
		}));
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
