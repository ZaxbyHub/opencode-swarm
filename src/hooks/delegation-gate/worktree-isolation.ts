/**
 * Worktree Isolation Subsystem
 *
 * Manages standard worktree-backed coder dispatches: provisioning worktrees,
 * tracking dispatches, serializing when capacity is exceeded, and merging
 * results back after coder completion.
 *
 * Extracted from delegation-gate.ts (FR-003) for modularity.
 * The _internals seam allows test injection of worktree operations.
 */

import type { PluginConfig, WorktreeIsolationConfig } from '../../config';
import { DEFAULT_WORKTREE_ISOLATION_CONFIG } from '../../config/constants';
import { ensureAgentSession, swarmState } from '../../state';
import type { WorktreeHandle } from '../../worktree';
import {
	attemptMergeBackFromDirty,
	getMergeStrategy,
	postMergeCleanup,
	provisionWorktree,
	removeWorktree,
} from '../../worktree';

export const MAX_TRACKED_STANDARD_WORKTREE_CALLS = 256;

export interface StandardWorktreeDispatch {
	callID: string;
	parentSessionID: string;
	taskId: string;
	planTaskId?: string;
	handle: WorktreeHandle;
	mergeStrategy: 'merge' | 'rebase' | 'cherry-pick';
}

export const standardWorktreeByCallID = new Map<
	string,
	StandardWorktreeDispatch
>();
export const standardWorktreeSerializationSessions = new Set<string>();
let standardWorktreeMergeQueue: Promise<unknown> = Promise.resolve();

function rememberStandardWorktreeDispatch(
	dispatch: StandardWorktreeDispatch,
): void {
	standardWorktreeByCallID.set(dispatch.callID, dispatch);
}

function hasStandardWorktreeDispatchCapacity(): boolean {
	return standardWorktreeByCallID.size < MAX_TRACKED_STANDARD_WORKTREE_CALLS;
}

function serializeStandardWorktreeDispatches(
	sessionID: string,
	message: string,
): void {
	rememberStandardWorktreeSerializationSession(sessionID);
	const session = ensureAgentSession(sessionID);
	session.maxConcurrencyOverride = 1;
	session.pendingAdvisoryMessages ??= [];
	session.pendingAdvisoryMessages.push(
		`${message} Serializing standard coder dispatches for this session.`,
	);
}

export function resetStandardWorktreeIsolationState(): void {
	standardWorktreeByCallID.clear();
	standardWorktreeSerializationSessions.clear();
	standardWorktreeMergeQueue = Promise.resolve();
}

function rememberStandardWorktreeSerializationSession(sessionID: string): void {
	if (
		standardWorktreeSerializationSessions.size >=
		MAX_TRACKED_STANDARD_WORKTREE_CALLS
	) {
		const oldest = standardWorktreeSerializationSessions.values().next()
			.value as string | undefined;
		if (oldest) standardWorktreeSerializationSessions.delete(oldest);
	}
	standardWorktreeSerializationSessions.add(sessionID);
}

export function sanitizeWorktreeTaskId(raw: string): string {
	const sanitized = raw.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64);
	return sanitized || 'task';
}

function resolveWorktreeIsolationConfig(
	config: PluginConfig,
): WorktreeIsolationConfig {
	if (config.worktree) {
		return { ...DEFAULT_WORKTREE_ISOLATION_CONFIG, ...config.worktree };
	}
	const lean =
		config.turbo?.strategy === 'lean' ? config.turbo.lean : undefined;
	if (lean?.worktree_isolation) {
		return {
			...DEFAULT_WORKTREE_ISOLATION_CONFIG,
			policy: 'auto',
			merge_strategy: lean.merge_strategy ?? 'merge',
			worktree_dir: lean.worktree_dir,
		};
	}
	return DEFAULT_WORKTREE_ISOLATION_CONFIG;
}

export async function precreateStandardWorktreeSession(args: {
	config: PluginConfig;
	directory: string;
	parentSessionID: string;
	callID: string;
	taskId: string;
	planTaskId?: string;
	description?: string;
	outputArgs: Record<string, unknown>;
}): Promise<void> {
	const worktreeConfig = resolveWorktreeIsolationConfig(args.config);
	if (worktreeConfig.policy === 'disabled') return;

	if (!hasStandardWorktreeDispatchCapacity()) {
		const message =
			'STANDARD_WORKTREE_TRACKING_CAP_EXCEEDED: too many standard worktree coder dispatches are already awaiting merge-back.';
		if (worktreeConfig.policy === 'required') throw new Error(message);
		serializeStandardWorktreeDispatches(args.parentSessionID, message);
		return;
	}

	const client = swarmState.opencodeClient;
	if (!client) {
		const message =
			'STANDARD_WORKTREE_ISOLATION_UNAVAILABLE: OpenCode SDK client is unavailable; standard parallel coder work cannot be isolated.';
		if (worktreeConfig.policy === 'required') throw new Error(message);
		serializeStandardWorktreeDispatches(args.parentSessionID, message);
		return;
	}

	const provisionResult = await _internals.provisionWorktree(
		args.directory,
		args.taskId,
		args.parentSessionID,
		{
			purpose: 'lane',
			worktreeDir: worktreeConfig.worktree_dir,
			mergeStrategy: worktreeConfig.merge_strategy,
		},
	);
	if ('error' in provisionResult) {
		const message = `STANDARD_WORKTREE_PROVISION_FAILED: ${provisionResult.error}`;
		if (worktreeConfig.policy === 'required') throw new Error(message);
		serializeStandardWorktreeDispatches(args.parentSessionID, `${message}.`);
		return;
	}

	const createResult = await client.session.create({
		body: {
			parentID: args.parentSessionID,
			title: `${args.description ?? args.taskId} (worktree lane)`,
		},
		query: { directory: provisionResult.worktreePath },
	});
	if (!createResult.data?.id) {
		await _internals
			.removeWorktree(provisionResult.worktreePath, args.directory)
			.catch(() => {});
		const createError = (createResult as { error?: unknown }).error;
		const detail =
			typeof createError === 'string'
				? createError
				: JSON.stringify(createError ?? 'missing session id');
		const message = `STANDARD_WORKTREE_SESSION_CREATE_FAILED: ${detail}`;
		if (worktreeConfig.policy === 'required') throw new Error(message);
		serializeStandardWorktreeDispatches(args.parentSessionID, `${message}.`);
		return;
	}

	args.outputArgs.task_id = createResult.data.id;
	rememberStandardWorktreeDispatch({
		callID: args.callID,
		parentSessionID: args.parentSessionID,
		taskId: args.taskId,
		planTaskId: args.planTaskId,
		handle: provisionResult,
		mergeStrategy: worktreeConfig.merge_strategy,
	});
}

export async function finishStandardWorktreeDispatch(
	directory: string,
	dispatch: StandardWorktreeDispatch,
): Promise<void> {
	const run = async () => {
		const mergeResult = await _internals.attemptMergeBackFromDirty(
			dispatch.handle.worktreePath,
			dispatch.handle.branchName,
			directory,
			getMergeStrategy({ merge_strategy: dispatch.mergeStrategy }),
		);
		if ('merged' in mergeResult && mergeResult.merged) {
			await _internals
				.removeWorktree(dispatch.handle.worktreePath, directory)
				.catch(() => {});
			await _internals
				.postMergeCleanup(directory, dispatch.handle.branchName)
				.catch(() => {});
			return;
		}
		if ('partial' in mergeResult) {
			const session = ensureAgentSession(dispatch.parentSessionID);
			session.pendingAdvisoryMessages ??= [];
			session.pendingAdvisoryMessages.push(
				`STANDARD_WORKTREE_MERGE_PARTIAL: task ${dispatch.taskId} preserved at ${dispatch.handle.worktreePath}; stage: ${mergeResult.stage}; ${mergeResult.message}`,
			);
			return;
		}

		if ('failed' in mergeResult) {
			const session = ensureAgentSession(dispatch.parentSessionID);
			session.pendingAdvisoryMessages ??= [];
			session.pendingAdvisoryMessages.push(
				`STANDARD_WORKTREE_MERGE_FAILED: task ${dispatch.taskId} preserved at ${dispatch.handle.worktreePath}; stage: ${mergeResult.stage}; ${mergeResult.message}.`,
			);
		}
	};

	standardWorktreeMergeQueue = standardWorktreeMergeQueue.then(run, run);
	await standardWorktreeMergeQueue;
}

/**
 * _internals seam for test injection of worktree operations.
 * Tests set these entries on delegation-gate's _internals (which proxies
 * here via getters/setters) to mock worktree provisioning, merge-back, etc.
 */
export const _internals = {
	provisionWorktree,
	removeWorktree,
	attemptMergeBackFromDirty,
	postMergeCleanup,
};
