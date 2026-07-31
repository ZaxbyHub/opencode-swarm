import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import {
	appendDelegationTransition,
	BACKGROUND_INGESTION_LEASE_MS,
	type BackgroundDelegationResult,
	type BackgroundWorkspaceSnapshot,
	claimDelegationIngestion,
	findByCorrelationId,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import {
	claimReviewerScopeGeneration,
	getReviewerScopeGenerationForCoderCall,
	markReviewerScopeGenerationReady,
	peekReviewerScopeGenerationClaim,
	resetSwarmState,
	startAgentSession,
	startReviewerScopeGeneration,
} from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

let directory = '';
let cleanupDirectory = (): void => {};

const completedText = 'done';
const completedResult: BackgroundDelegationResult = {
	text: completedText,
	chars: completedText.length,
	truncated: false,
	digest: createHash('sha256').update(completedText).digest('hex'),
};

function syntheticEvent(
	correlationId: string,
	state: 'completed' | 'error',
	text: string,
) {
	const body =
		state === 'completed'
			? `<task_result>${text}</task_result>`
			: `<task_error>${text}</task_error>`;
	return {
		event: {
			type: 'message.part.updated',
			properties: {
				part: {
					type: 'text',
					text: `<task id="${correlationId}" state="${state}">\n${body}\n</task>`,
					synthetic: true,
					sessionID: 'parent',
				},
			},
		},
	};
}

async function recordAndLease(input: {
	correlationId: string;
	callID: string;
	role: 'coder' | 'reviewer';
	workspace?: BackgroundWorkspaceSnapshot;
	now?: number;
}) {
	expect(
		await recordPendingDelegation(directory, {
			correlationId: input.correlationId,
			jobId: `job-${input.correlationId}`,
			subagentSessionId: input.correlationId,
			parentSessionId: 'parent',
			callID: input.callID,
			normalizedAgent: input.role,
			swarmPrefixedAgent: input.role,
			planTaskId: '1.1',
			evidenceTaskId: '1.1',
			workspace: input.workspace,
		}),
	).not.toBeNull();
	expect(
		await appendDelegationTransition(directory, input.correlationId, {
			status: 'completed',
			result: completedResult,
		}),
	).toMatchObject({ status: 'completed' });
	const claim = await claimDelegationIngestion(
		directory,
		input.correlationId,
		completedResult.digest,
		input.now === undefined ? {} : { now: input.now },
	);
	if (claim.outcome !== 'claimed') {
		throw new Error(`expected ingestion claim, got ${claim.outcome}`);
	}
	return claim;
}

function startCoderGeneration(callID: string): void {
	expect(
		startReviewerScopeGeneration({
			parentSessionID: 'parent',
			taskId: '1.1',
			coderCallID: callID,
			background: true,
			declaredFiles: ['src/example.ts'],
		}),
	).not.toBeNull();
}

function claimReviewerGeneration(
	coderCallID: string,
	reviewerCallID: string,
): void {
	startCoderGeneration(coderCallID);
	expect(
		markReviewerScopeGenerationReady({
			parentSessionID: 'parent',
			taskId: '1.1',
			coderCallID,
		}),
	).toBe(true);
	expect(
		claimReviewerScopeGeneration({
			parentSessionID: 'parent',
			taskId: '1.1',
			reviewerCallID,
		}),
	).not.toBeNull();
}

function staleWorkspace(): BackgroundWorkspaceSnapshot {
	return {
		directory: path.join(directory, 'different-project'),
		gitHead: null,
		dirtyHash: null,
		changedFiles: null,
		prHeadSha: null,
		scope: '1.1',
	};
}

beforeEach(() => {
	resetSwarmState();
	const safeDirectory = createSafeTestDir('bg-observer-lease-');
	directory = safeDirectory.dir;
	cleanupDirectory = safeDirectory.cleanup;
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	startAgentSession('parent', 'architect', directory);
});

afterEach(() => {
	resetSwarmState();
	cleanupDirectory();
});

describe('background completion observer ingestion lease ownership — regression: non-owner terminal races (F-B3)', () => {
	test('late error cannot discard the coder generation owned by an active lease', async () => {
		// Previous code treated the unchanged ingesting row as a terminal error
		// transition and discarded the real completion owner's coder generation.
		startCoderGeneration('coder-active');
		const lease = await recordAndLease({
			correlationId: 'child-active-error',
			callID: 'coder-active',
			role: 'coder',
		});
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});

		await observer.event(
			syntheticEvent('child-active-error', 'error', 'late failure'),
		);

		expect(findByCorrelationId(directory, 'child-active-error')).toMatchObject({
			status: 'ingesting',
			ingestionId: lease.ingestionId,
		});
		expect(
			getReviewerScopeGenerationForCoderCall({
				parentSessionID: 'parent',
				taskId: '1.1',
				coderCallID: 'coder-active',
			}),
		).toMatchObject({ status: 'collecting' });
	});

	test('stale duplicate completion cannot discard the reviewer claim owned by an active lease', async () => {
		// Previous code saw a truthy unchanged ingesting row after the stale
		// transition CAS and discarded the active owner's reviewer claim.
		claimReviewerGeneration('coder-stale-race', 'reviewer-stale-race');
		const lease = await recordAndLease({
			correlationId: 'child-active-stale',
			callID: 'reviewer-stale-race',
			role: 'reviewer',
			workspace: staleWorkspace(),
		});
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});

		await observer.event(
			syntheticEvent('child-active-stale', 'completed', completedText),
		);

		expect(findByCorrelationId(directory, 'child-active-stale')).toMatchObject({
			status: 'ingesting',
			ingestionId: lease.ingestionId,
		});
		expect(
			peekReviewerScopeGenerationClaim({
				parentSessionID: 'parent',
				taskId: '1.1',
				reviewerCallID: 'reviewer-stale-race',
			}),
		).not.toBeNull();
	});

	test('same-digest completion reclaims an expired lease and settles normally', async () => {
		const expired = await recordAndLease({
			correlationId: 'child-expired',
			callID: 'coder-expired',
			role: 'coder',
			now: Date.now() - BACKGROUND_INGESTION_LEASE_MS - 1_000,
		});
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});

		await observer.event(
			syntheticEvent('child-expired', 'completed', completedText),
		);

		expect(findByCorrelationId(directory, 'child-expired')).toMatchObject({
			status: 'consumed',
		});
		expect(
			findByCorrelationId(directory, 'child-expired')?.ingestionId,
		).not.toBe(expired.ingestionId);
	});

	test('normal pending error and stale transitions still discard their exact scopes', async () => {
		startCoderGeneration('coder-error');
		expect(
			await recordPendingDelegation(directory, {
				correlationId: 'child-error',
				jobId: 'job-error',
				subagentSessionId: 'child-error',
				parentSessionId: 'parent',
				callID: 'coder-error',
				normalizedAgent: 'coder',
				swarmPrefixedAgent: 'coder',
				planTaskId: '1.1',
				evidenceTaskId: '1.1',
			}),
		).not.toBeNull();
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});

		await observer.event(syntheticEvent('child-error', 'error', 'failed'));

		expect(findByCorrelationId(directory, 'child-error')?.status).toBe('error');
		expect(
			getReviewerScopeGenerationForCoderCall({
				parentSessionID: 'parent',
				taskId: '1.1',
				coderCallID: 'coder-error',
			}),
		).toBeNull();

		claimReviewerGeneration('coder-stale', 'reviewer-stale');
		expect(
			await recordPendingDelegation(directory, {
				correlationId: 'child-stale',
				jobId: 'job-stale',
				subagentSessionId: 'child-stale',
				parentSessionId: 'parent',
				callID: 'reviewer-stale',
				normalizedAgent: 'reviewer',
				swarmPrefixedAgent: 'reviewer',
				planTaskId: '1.1',
				evidenceTaskId: '1.1',
				workspace: staleWorkspace(),
			}),
		).not.toBeNull();

		await observer.event(
			syntheticEvent('child-stale', 'completed', completedText),
		);

		expect(findByCorrelationId(directory, 'child-stale')?.status).toBe('stale');
		expect(
			peekReviewerScopeGenerationClaim({
				parentSessionID: 'parent',
				taskId: '1.1',
				reviewerCallID: 'reviewer-stale',
			}),
		).toBeNull();
	});
});
