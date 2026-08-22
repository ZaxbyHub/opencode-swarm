/**
 * Canonical scope construction for Stage-B reviewer receipts (v2, issue #2100).
 *
 * The architect-authored reviewer prompt is not authoritative scope: it can
 * omit files that the coder actually changed. Guardrails records every
 * write-tool target on the coder generation, so receipts fingerprint an exact
 * manifest of repository HEAD, the canonical workspace identity, those paths,
 * and their complete current bytes (streamed SHA-256 — no byte caps). A base
 * change therefore invalidates the receipt even when the working-file bytes
 * happen to remain identical.
 *
 * The inline payload budget (`maxBytes`) selects a per-file DELIVERY MODE only
 * — it never decides which files enter the manifest and never changes the
 * manifest digest. Unsafe paths, symlink/reparse points, non-regular files,
 * and concurrent mutation fail toward typed results; transient classes
 * (HEAD timeout/race, capture races, capture deadline) are retryable.
 */

import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadPlanJsonOnly } from '../plan/manager.js';
import { canonicalWorkspaceIdentity } from '../scope/scope-binding.js';
import { peekReviewerScopeGenerationClaim, swarmState } from '../state.js';
import { resolveGitExecutable } from '../utils/git-executable.js';
import { resolveDelegatedPlanTaskId } from './delegation-gate.js';
import { computeScopeFingerprint } from './review-receipt.js';
import {
	captureReviewerScopeFileFingerprint,
	REVIEWER_SCOPE_CAPTURE_BATCH_DEADLINE_MS,
	type ReviewerScopeCaptureFailureCode,
} from './reviewer-scope-file-fingerprint.js';

const MAX_SCOPE_FILES = 256;
const DEFAULT_MAX_SCOPE_BYTES = 256 * 1024;
const MAX_SCOPE_BYTES = 2 * 1024 * 1024;
const HEAD_TIMEOUT_MS = 5_000;
const HEAD_OUTPUT_BYTES = 256;
const HEAD_SHA_PATTERN = /^[0-9a-f]{40,64}$/i;

export const REVIEWER_TASK_SCOPE_DESCRIPTION = 'reviewer-task-files-v2';
export const REVIEWER_TASK_SCOPE_HEADER =
	'opencode-swarm-reviewer-task-scope-v2';

export interface ReviewerTaskScopeDeliveryEntry {
	path: string;
	mode: 'inline' | 'manual';
}

export interface ReviewerTaskScope {
	content: string;
	/** Manifest version discriminator — `reviewer-task-files-v2` for live builds; legacy v1 values only reach us from persisted data. */
	description: string;
	files: string[];
	headSha: string;
	/** Canonical workspace identity the manifest bytes were captured from. */
	workspaceIdentity: string;
	/** Per-file delivery mode — advisory prompt metadata, never part of the digest. */
	delivery: ReviewerTaskScopeDeliveryEntry[];
	taskId?: string;
	coderCallID?: string;
	generation?: number;
	sessionIncarnation?: string;
}

export interface ReviewerTaskScopeProvenance {
	taskId: string;
	coderCallID: string;
	generation: number;
	sessionIncarnation: string;
}

export interface ResolveReviewerTaskScopeOptions {
	/** Consume the completed coder's one-shot scope instead of the live list. */
	consumeHandoff?: boolean;
	/** Exact task expected by the returning reviewer/background record. */
	expectedTaskId?: string;
	/** Exact reviewer Task call that claimed the generation. */
	reviewerCallID?: string;
	/** Injectable clock used only for deterministic expiry tests. */
	now?: number;
}

export type ReviewerScopeBuildFailureCode =
	| 'no_files'
	| 'too_many_files'
	| 'invalid_budget'
	| 'invalid_path'
	| 'workspace_unresolvable'
	| 'head_timeout'
	| 'head_changed'
	| 'outside_workspace'
	| 'symlink_or_reparse'
	| 'non_regular'
	| 'unreadable'
	| 'file_changed_during_capture'
	| 'capture_deadline';

export type ReviewerScopeBuildResult =
	| { ok: true; scope: ReviewerTaskScope }
	| {
			ok: false;
			code: ReviewerScopeBuildFailureCode;
			retryable: boolean;
			file?: string;
			detail?: string;
	  };

/**
 * Resolve the exact known plan task carried by reviewer/coder Task arguments.
 *
 * This deliberately reuses delegation-gate's canonical extractor so lifecycle
 * identity cannot drift from scope authorization. It checks all supported Task
 * text fields, prefers an unambiguous TASK line, rejects ambiguity, and filters
 * numeric-dot tokens against the current plan.
 */
export async function resolveReviewerScopeTaskId(
	directory: string,
	args: unknown,
): Promise<string | null> {
	if (!args || typeof args !== 'object') return null;
	const record = args as Record<string, unknown>;
	try {
		const plan = await loadPlanJsonOnly(directory);
		if (!plan) return null;
		const knownPlanTaskIds = new Set<string>();
		for (const phase of plan.phases) {
			for (const task of phase.tasks) knownPlanTaskIds.add(task.id);
		}
		if (knownPlanTaskIds.size === 0) return null;
		return resolveDelegatedPlanTaskId(record, knownPlanTaskIds);
	} catch {
		return null;
	}
}

/**
 * Test-only dependency-injection seam. Keeping the spawn binding local avoids
 * process-global `mock.module()` pollution while allowing tests to prove that
 * the production call really creates a child with ignored stdin.
 */
export const _internals: {
	spawn: typeof child_process.spawn;
	realpath: typeof fs.promises.realpath;
	/**
	 * Issue #2236 hardening (F1/F4/F5) — resolves the absolute git executable
	 * path instead of spawning the bare `'git'` name. Exposed for test
	 * injection following the `src/worktree/core.ts` convention.
	 */
	resolveGitExecutable: typeof resolveGitExecutable;
} = {
	spawn: child_process.spawn,
	realpath: fs.promises.realpath,
	resolveGitExecutable,
};

function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

function isContained(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return (
		relative.length > 0 &&
		relative !== '..' &&
		!relative.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relative)
	);
}

function canonicalPath(relativePath: string): string {
	return relativePath.split(path.sep).join('/');
}

function pathKey(relativePath: string): string {
	return process.platform === 'win32'
		? relativePath.toLowerCase()
		: relativePath;
}

async function resolveHeadSha(directory: string): Promise<string | null> {
	let child: child_process.ChildProcess | undefined;
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	try {
		child = _internals.spawn(
			_internals.resolveGitExecutable(),
			['rev-parse', '--verify', 'HEAD'],
			{
				cwd: directory,
				stdio: ['ignore', 'pipe', 'ignore'],
				timeout: HEAD_TIMEOUT_MS,
				windowsHide: true,
			},
		);

		return await new Promise<string | null>((resolve) => {
			let settled = false;
			let stdoutBytes = 0;
			const stdoutChunks: Buffer[] = [];
			const finish = (value: string | null): void => {
				if (settled) return;
				settled = true;
				if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
				resolve(value);
			};
			const killAndFail = (): void => {
				try {
					child?.kill();
				} catch {
					// Best-effort cleanup; the child may already have exited.
				}
				finish(null);
			};

			timeoutHandle = setTimeout(killAndFail, HEAD_TIMEOUT_MS);
			timeoutHandle.unref?.();
			child?.once('error', killAndFail);
			child?.stdout?.on('data', (chunk: Buffer | string) => {
				const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				stdoutBytes += bytes.byteLength;
				if (stdoutBytes > HEAD_OUTPUT_BYTES) {
					killAndFail();
					return;
				}
				stdoutChunks.push(bytes);
			});
			child?.once('close', (exitCode) => {
				if (exitCode !== 0 || stdoutBytes > HEAD_OUTPUT_BYTES) {
					finish(null);
					return;
				}
				const sha = Buffer.concat(stdoutChunks).toString('utf-8').trim();
				finish(HEAD_SHA_PATTERN.test(sha) ? sha : null);
			});
		});
	} catch {
		return null;
	} finally {
		if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
		try {
			child?.kill();
		} catch {
			// Best-effort cleanup; the child may already have exited.
		}
	}
}

function buildFailureFromCapture(
	file: string,
	code: ReviewerScopeCaptureFailureCode,
): Extract<ReviewerScopeBuildResult, { ok: false }> {
	switch (code) {
		case 'file_changed_during_capture':
		case 'capture_deadline':
			return { ok: false, code, retryable: true, file };
		case 'outside_workspace':
			return { ok: false, code: 'outside_workspace', retryable: false, file };
		case 'symlink_or_reparse':
			return { ok: false, code: 'symlink_or_reparse', retryable: false, file };
		case 'non_regular':
			return { ok: false, code: 'non_regular', retryable: false, file };
		default:
			return { ok: false, code: 'unreadable', retryable: false, file };
	}
}

/**
 * Build the exact reviewer-task manifest for a guardrails-observed file list.
 *
 * Every regular file contributes its COMPLETE byte count and SHA-256 (streamed
 * capture); the payload budget only selects per-file delivery mode. Transient
 * failures return typed retryable results; the caller owns bounded retry.
 */
export async function buildReviewerTaskScope(
	directory: string,
	modifiedFiles: readonly string[],
	maxBytes = DEFAULT_MAX_SCOPE_BYTES,
	provenance?: ReviewerTaskScopeProvenance,
	options: { deadlineAt?: number } = {},
): Promise<ReviewerScopeBuildResult> {
	if (modifiedFiles.length === 0) {
		return { ok: false, code: 'no_files', retryable: false };
	}
	if (modifiedFiles.length > MAX_SCOPE_FILES) {
		return { ok: false, code: 'too_many_files', retryable: false };
	}
	if (
		!Number.isSafeInteger(maxBytes) ||
		maxBytes <= 0 ||
		maxBytes > MAX_SCOPE_BYTES
	) {
		return { ok: false, code: 'invalid_budget', retryable: false };
	}

	let lexicalRoot: string;
	let realRoot: string;
	try {
		lexicalRoot = path.resolve(directory);
		realRoot = await _internals.realpath(lexicalRoot);
	} catch {
		return { ok: false, code: 'workspace_unresolvable', retryable: false };
	}
	const workspaceIdentity = canonicalWorkspaceIdentity(realRoot);
	if (!workspaceIdentity) {
		return { ok: false, code: 'workspace_unresolvable', retryable: false };
	}
	const headSha = await resolveHeadSha(realRoot);
	if (!headSha) {
		return { ok: false, code: 'head_timeout', retryable: true };
	}

	const candidates = new Map<
		string,
		{ absolutePath: string; relativePath: string }
	>();
	for (const rawPath of modifiedFiles) {
		if (typeof rawPath !== 'string') {
			return { ok: false, code: 'invalid_path', retryable: false };
		}
		if (rawPath.length === 0 || hasControlCharacter(rawPath)) {
			return {
				ok: false,
				code: 'invalid_path',
				retryable: false,
				file: rawPath,
			};
		}
		const absolutePath = path.resolve(lexicalRoot, rawPath);
		if (!isContained(lexicalRoot, absolutePath)) {
			return {
				ok: false,
				code: 'outside_workspace',
				retryable: false,
				file: rawPath,
			};
		}
		const relativePath = canonicalPath(
			path.relative(lexicalRoot, absolutePath),
		);
		if (relativePath.length === 0 || relativePath.startsWith('-')) {
			return {
				ok: false,
				code: 'invalid_path',
				retryable: false,
				file: rawPath,
			};
		}
		candidates.set(pathKey(relativePath), { absolutePath, relativePath });
	}
	const ordered = [...candidates.values()].sort((left, right) =>
		left.relativePath.localeCompare(right.relativePath, 'en'),
	);

	// An outer deadline (bounded retry loop) caps this build's own budget so
	// per-attempt budgets cannot stack past the caller's wall-clock claim.
	const deadlineAt = Math.min(
		options.deadlineAt ?? Number.POSITIVE_INFINITY,
		Date.now() + REVIEWER_SCOPE_CAPTURE_BATCH_DEADLINE_MS,
	);
	const records: string[] = [
		REVIEWER_TASK_SCOPE_HEADER,
		JSON.stringify({
			manifest: REVIEWER_TASK_SCOPE_DESCRIPTION,
			head: headSha,
			workspace: workspaceIdentity,
		}),
	];
	if (provenance) {
		records.push(
			JSON.stringify({
				task_id: provenance.taskId,
				coder_call_id: provenance.coderCallID,
				generation: provenance.generation,
				session_incarnation: provenance.sessionIncarnation,
			}),
		);
	}
	const delivery: ReviewerTaskScopeDeliveryEntry[] = [];
	let deliveryBudget = maxBytes;
	for (const candidate of ordered) {
		const captured = captureReviewerScopeFileFingerprint(
			lexicalRoot,
			candidate.relativePath,
			{ deadlineAt },
		);
		if (captured.kind === 'capture_failed') {
			return buildFailureFromCapture(captured.file, captured.code);
		}
		if (captured.kind === 'captured_deleted') {
			records.push(
				JSON.stringify({
					path: candidate.relativePath,
					state: 'deleted',
				}),
			);
			delivery.push({ path: candidate.relativePath, mode: 'manual' });
			continue;
		}
		records.push(
			JSON.stringify({
				path: candidate.relativePath,
				state: 'file',
				bytes: captured.size,
				sha256: captured.hash,
			}),
		);
		if (captured.size <= deliveryBudget) {
			deliveryBudget -= captured.size;
			delivery.push({ path: candidate.relativePath, mode: 'inline' });
		} else {
			delivery.push({ path: candidate.relativePath, mode: 'manual' });
		}
	}

	const finalHeadSha = await resolveHeadSha(realRoot);
	if (finalHeadSha !== headSha) {
		return { ok: false, code: 'head_changed', retryable: true };
	}

	return {
		ok: true,
		scope: {
			content: `${records.join('\n')}\n`,
			description: REVIEWER_TASK_SCOPE_DESCRIPTION,
			files: ordered.map((candidate) => candidate.relativePath),
			headSha,
			workspaceIdentity,
			delivery,
			...(provenance
				? {
						taskId: provenance.taskId,
						coderCallID: provenance.coderCallID,
						generation: provenance.generation,
						sessionIncarnation: provenance.sessionIncarnation,
					}
				: {}),
		},
	};
}

/**
 * Resolve scope only from the architect session's guardrails-owned task state.
 * Receipt collection consumes the completed coder handoff exactly once; direct
 * callers retain the legacy live-list view for diagnostics and drift probes.
 */
export async function resolveReviewerTaskScope(
	directory: string,
	sessionID: string,
	maxBytes = DEFAULT_MAX_SCOPE_BYTES,
	options: ResolveReviewerTaskScopeOptions = {},
): Promise<ReviewerTaskScope | null> {
	const session = swarmState.agentSessions.get(sessionID);
	if (!session) return null;
	if (options.consumeHandoff) {
		const expectedTaskId = options.expectedTaskId;
		const reviewerCallID = options.reviewerCallID;
		if (!expectedTaskId || !reviewerCallID) return null;
		const handoff = peekReviewerScopeGenerationClaim({
			parentSessionID: sessionID,
			taskId: expectedTaskId,
			reviewerCallID,
			now: options.now,
		});
		if (!handoff) return null;
		const snapshot = handoff.reviewerDispatchScope;
		if (!snapshot) return null;
		// Rebuild from the same ambient (primary) root the dispatch snapshot was
		// built from: lane generations are only claimable after merge-back
		// verification, and the lane itself may already be cleaned up.
		const current = await buildReviewerTaskScope(
			directory,
			handoff.modifiedFiles,
			maxBytes,
			{
				taskId: handoff.taskId,
				coderCallID: handoff.coderCallID,
				generation: handoff.generation,
				sessionIncarnation: handoff.sessionIncarnation,
			},
		);
		if (
			!current.ok ||
			computeScopeFingerprint(current.scope.content, current.scope.description)
				.hash !== snapshot.hash ||
			current.scope.description !== snapshot.description ||
			current.scope.headSha !== snapshot.headSha ||
			JSON.stringify(current.scope.files) !== JSON.stringify(snapshot.files)
		) {
			return null;
		}
		return current.scope;
	}
	const live = await buildReviewerTaskScope(
		directory,
		session.modifiedFilesThisCoderTask,
		maxBytes,
	);
	return live.ok ? live.scope : null;
}
