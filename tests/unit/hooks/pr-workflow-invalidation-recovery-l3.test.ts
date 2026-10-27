/**
 * Issue #3316 AC12 (L3 acceptance, PRESERVING): once HEAD is returned to the
 * bound intake head, the PR_FEEDBACK ladder must resume in order — head
 * assertion, verification re-declaration, and Stage A re-record are all
 * reachable at base AND after the fix. The sanctioned-reset step itself is
 * captured WITHOUT an assertion (its admission is the discriminating AC10
 * contract; this file pins only the recovery premises that must hold on both
 * sides of it).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { storeLaneOutput } from '../../../src/background/lane-output-store.js';
import {
	appendDelegationTransition,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	assertCurrentCheckoutHead,
	enforcePrFeedbackVerificationOwnership,
	enforcePrWorkflowToolBefore,
	invalidatePrFeedbackPublication,
	recordPrFeedbackStageA,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	createPublicationFixture,
	HEAD_SHA,
	type PublicationFixture,
	REVISION,
} from './pr-workflow-publication.test-fixtures.js';

const SESSION_ID = 'l3-invalidation-recovery';

let fixture: PublicationFixture;

beforeEach(async () => {
	fixture = await createPublicationFixture();
});

afterEach(async () => {
	await fixture.teardown();
});

/** Arm, invalidate for rework, attempt the reset, and park HEAD at the intake. */
async function returnedToIntakeHead(): Promise<void> {
	await fixture.prepareArmedGeneration(SESSION_ID);
	await invalidatePrFeedbackPublication(
		fixture.directory,
		SESSION_ID,
		'rework',
	);
	const admitted = await enforcePrWorkflowToolBefore(
		fixture.directory,
		SESSION_ID,
		'shell',
		{ command: `git reset --soft ${HEAD_SHA}` },
		[],
		'call-recovery-reset',
	).then(
		() => true,
		() => false,
	);
	// Outcome deliberately not asserted here (AC10 owns that contract).
	expect(typeof admitted).toBe('boolean');
	fixture.mutators.head(HEAD_SHA);
}

describe('PR_FEEDBACK invalidation recovery premises (AC12)', () => {
	test('with HEAD back at the intake, the head assertion and verification re-declaration both resolve', async () => {
		await returnedToIntakeHead();

		await expect(
			assertCurrentCheckoutHead(fixture.directory, HEAD_SHA, 'PR_FEEDBACK'),
		).resolves.toBe(HEAD_SHA);

		await expect(
			enforcePrFeedbackVerificationOwnership(
				fixture.directory,
				SESSION_ID,
				[{ laneId: 'verify-restart', ownedItemIds: ['FB-001'] }],
				{ batchId: 'verify-restart', prHeadSha: HEAD_SHA },
			),
		).resolves.toBeDefined();
	});

	test('with HEAD back at the intake and verification re-settled, Stage A re-records', async () => {
		await returnedToIntakeHead();

		await enforcePrFeedbackVerificationOwnership(
			fixture.directory,
			SESSION_ID,
			[{ laneId: 'verify-restart', ownedItemIds: ['FB-001'] }],
			{ batchId: 'verify-restart', prHeadSha: HEAD_SHA },
		);
		const text = '[FEEDBACK-VERIFIED] | FB-001 | CONFIRMED | evidence';
		await recordPendingDelegation(fixture.directory, {
			correlationId: 'verify-restart',
			jobId: null,
			subagentSessionId: 'verify-restart',
			parentSessionId: SESSION_ID,
			callID: 'call-verify-restart',
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: null,
			evidenceTaskId: null,
			batchId: 'verify-restart',
			laneId: 'verify-restart',
			mode: 'swarm-pr-feedback:verification',
			workflowLane: 'verify-restart',
			workspace: {
				directory: fixture.directory,
				gitHead: HEAD_SHA,
				dirtyHash: REVISION,
				prHeadSha: HEAD_SHA,
				scope: null,
			},
		});
		const stored = storeLaneOutput(fixture.directory, {
			batchId: 'verify-restart',
			laneId: 'verify-restart',
			agent: 'reviewer',
			role: 'reviewer',
			sessionId: 'verify-restart',
			parentSessionId: SESSION_ID,
			mode: 'swarm-pr-feedback:verification',
			workflowLane: 'verify-restart',
			prHeadSha: HEAD_SHA,
			gitHead: HEAD_SHA,
			revisionDigest: REVISION,
			source: 'collect_lane_results',
			text,
		});
		await appendDelegationTransition(fixture.directory, 'verify-restart', {
			status: 'completed',
			result: {
				text,
				chars: stored.chars,
				truncated: false,
				digest: stored.digest,
				outputRef: stored.ref,
			},
		});

		await expect(
			recordPrFeedbackStageA(fixture.directory, SESSION_ID, REVISION, [
				{ category: 'build', command: ['build'], durationMs: 1 },
				{ category: 'typecheck', command: ['typecheck'], durationMs: 1 },
				{ category: 'lint', command: ['lint'], durationMs: 1 },
				{
					category: 'diff-check',
					command: ['git', 'diff', '--check'],
					durationMs: 1,
				},
				{
					category: 'reproduction',
					command: ['test', 'regression'],
					targets: ['regression'],
					feedbackTargets: [
						{
							feedbackItemId: 'FB-001',
							target: 'regression',
							expectedBehavior: 'regression remains fixed',
						},
					],
					durationMs: 1,
				},
			]),
		).resolves.toBeDefined();
	});
});
