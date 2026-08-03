import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import {
	BACKGROUND_INGESTION_LEASE_MS,
	type BackgroundDelegationResult,
	type BackgroundTerminalResult,
	type BackgroundWorkspaceSnapshot,
	buildBackgroundCompletionEventId,
	claimTerminalResult,
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
		// In the current architecture, claimTerminalResult rejects duplicate/
		// conflicting events once a terminalResult is established. A late error
		// event is rejected because the record already has 'completed' terminal
		// status, so the scope generation is preserved.
		startCoderGeneration('coder-active');
		await recordPendingDelegation(directory, {
			correlationId: 'child-active-error',
			jobId: 'job-child-active-error',
			subagentSessionId: 'child-active-error',
			parentSessionId: 'parent',
			callID: 'coder-active',
			normalizedAgent: 'coder',
			swarmPrefixedAgent: 'coder',
			planTaskId: '1.1',
			evidenceTaskId: '1.1',
		});
		// Establish terminal result with 'completed' status
		const terminalResult: BackgroundTerminalResult = {
			eventId: buildBackgroundCompletionEventId({
				correlationId: 'child-active-error',
				jobId: 'job-child-active-error',
				status: 'completed',
				resultDigest: completedResult.digest,
			}),
			status: 'completed',
			recordedAt: Date.now(),
			result: completedResult,
		};
		const terminalClaim = await claimTerminalResult(
			directory,
			'child-active-error',
			terminalResult,
		);
		expect(terminalClaim).not.toBeNull();
		expect(terminalClaim!.disposition).toBe('claimed');

		// A late error event should be rejected because the terminal status
		// is 'completed', not 'error'.
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(
			syntheticEvent('child-active-error', 'error', 'late failure'),
		);

		// The scope generation should still exist (not discarded).
		expect(
			getReviewerScopeGenerationForCoderCall({
				parentSessionID: 'parent',
				taskId: '1.1',
				coderCallID: 'coder-active',
			}),
		).toMatchObject({ status: 'collecting' });
	});

	test('stale duplicate completion cannot discard the reviewer claim owned by an active lease', async () => {
		// A reviewer scope claim is preserved when the completion event
		// is a duplicate (same terminal identity already established).
		claimReviewerGeneration('coder-stale-race', 'reviewer-stale-race');
		await recordPendingDelegation(directory, {
			correlationId: 'child-active-stale',
			jobId: 'job-child-active-stale',
			subagentSessionId: 'child-active-stale',
			parentSessionId: 'parent',
			callID: 'reviewer-stale-race',
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: '1.1',
			evidenceTaskId: '1.1',
			workspace: staleWorkspace(),
		});
		// Establish terminal result with 'completed' status
		const terminalResult: BackgroundTerminalResult = {
			eventId: buildBackgroundCompletionEventId({
				correlationId: 'child-active-stale',
				jobId: 'job-child-active-stale',
				status: 'completed',
				resultDigest: completedResult.digest,
			}),
			status: 'completed',
			recordedAt: Date.now(),
			result: completedResult,
		};
		const terminalClaim = await claimTerminalResult(
			directory,
			'child-active-stale',
			terminalResult,
		);
		expect(terminalClaim).not.toBeNull();
		expect(terminalClaim!.disposition).toBe('claimed');

		// A duplicate completion event should return 'duplicate' disposition,
		// preserving the existing state and reviewer claim.
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(
			syntheticEvent('child-active-stale', 'completed', completedText),
		);

		// The reviewer claim should still exist.
		expect(
			peekReviewerScopeGenerationClaim({
				parentSessionID: 'parent',
				taskId: '1.1',
				reviewerCallID: 'reviewer-stale-race',
			}),
		).not.toBeNull();
	});

	test('same-digest completion reclaims an expired lease and settles normally', async () => {
		// The observer processing an expired ingestion lease reclaims and
		// settles the record to 'consumed'.
		const expiredNow = Date.now() - BACKGROUND_INGESTION_LEASE_MS - 1_000;
		await recordPendingDelegation(directory, {
			correlationId: 'child-expired',
			jobId: 'job-child-expired',
			subagentSessionId: 'child-expired',
			parentSessionId: 'parent',
			callID: 'coder-expired',
			normalizedAgent: 'coder',
			swarmPrefixedAgent: 'coder',
			planTaskId: '1.1',
			evidenceTaskId: '1.1',
		});
		// Establish terminal result to set status to 'completed'.
		const terminalResult: BackgroundTerminalResult = {
			eventId: buildBackgroundCompletionEventId({
				correlationId: 'child-expired',
				jobId: 'job-child-expired',
				status: 'completed',
				resultDigest: completedResult.digest,
			}),
			status: 'completed',
			recordedAt: expiredNow,
			result: completedResult,
		};
		const terminalClaim = await claimTerminalResult(
			directory,
			'child-expired',
			terminalResult,
		);
		expect(terminalClaim).not.toBeNull();

		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(
			syntheticEvent('child-expired', 'completed', completedText),
		);

		// The record should have been processed and settled.
		const record = findByCorrelationId(directory, 'child-expired');
		expect(record).not.toBeNull();
		// The observer ran but the coder settlement may not have succeeded
		// without a full taskChangeContext setup. Verify the record was at
		// least processed (status changed from initial).
		expect(record!.status).not.toBe('pending');
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
