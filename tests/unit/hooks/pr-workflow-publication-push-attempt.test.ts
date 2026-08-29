/**
 * Issue #2108 §3 — durable push attempts: attempt-start before execution,
 * one in-flight per generation, restart recovery as `uncertain`, retry with
 * unchanged identity, drift between attempts invalidates, and completion
 * requirements.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	_test_exports,
	completePrWorkflow,
	enforcePrWorkflowToolBefore,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	HEAD_SHA,
	POST_COMMIT_SHA,
	createPublicationFixture,
	type PublicationFixture,
} from './pr-workflow-publication.test-fixtures.js';

const SESSION_ID = 'pub-attempts';
let fixture: PublicationFixture;

beforeEach(async () => {
	fixture = await createPublicationFixture();
});

afterEach(async () => {
	await fixture.teardown();
});

async function readPublication(sessionId = SESSION_ID) {
	const { state, publication, active } = await fixture.readActive(sessionId);
	return {
		state,
		publication,
		active,
		attempts: publication?.attempts ?? [],
	};
}

async function admitPush(callId?: string, sessionId = SESSION_ID): Promise<void> {
	await enforcePrWorkflowToolBefore(
		fixture.directory,
		sessionId,
		'shell',
		{
			command: `git push origin ${POST_COMMIT_SHA}:refs/heads/pr-head`,
		},
		[],
		callId,
	);
}

describe('push attempt lifecycle (issue #2108 §3)', () => {
	test('attempt-start is durable before execution and moves to push_in_flight', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		// Remote NOT yet at the approved head → a real attempt starts.
		fixture.mutators.remoteHead('0'.repeat(40));
		await admitPush('call-1');
		const { active, attempts } = await readPublication();
		expect(active?.state).toBe('push_in_flight');
		expect(attempts.length).toBe(1);
		expect(attempts[0]?.callID).toBe('call-1');
		expect(attempts[0]?.generation).toBe(1);
		expect(attempts[0]?.result).toBeUndefined();
		expect(attempts[0]?.intentDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(attempts[0]?.prePush.observedRemoteHead).toBe('0'.repeat(40));
	});

	test('remote already at the approved head records an observation-backed no-op completion', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		fixture.mutators.remoteHead(POST_COMMIT_SHA);
		await admitPush('call-noop');
		const { active, attempts } = await readPublication();
		expect(active?.state).toBe('armed');
		expect(attempts.length).toBe(1);
		expect(attempts[0]?.result?.outcome).toBe('completed');
		expect(attempts[0]?.result?.diagnostic).toContain('no-op push');
	});

	test('tool.execute.after records the result once the remote is verified', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		fixture.mutators.remoteHead('0'.repeat(40));
		await admitPush('call-2');
		// The push "runs"; the remote now observes the approved head.
		fixture.mutators.remoteHead(POST_COMMIT_SHA);
		await _test_exports.recordPrFeedbackPushAttemptResult(
			fixture.directory,
			{ sessionID: SESSION_ID, callID: 'call-2', tool: 'shell' },
			`git push origin ${POST_COMMIT_SHA}:refs/heads/pr-head`,
			{ output: 'Everything up-to-date' },
		);
		const { active, attempts } = await readPublication();
		expect(active?.state).toBe('armed');
		expect(attempts[0]?.result?.outcome).toBe('completed');
		expect(attempts[0]?.result?.postPush.observedRemoteHead).toBe(
			POST_COMMIT_SHA,
		);
	});

	test('restart recovery: an in-flight attempt is reconciled as uncertain with remote re-verification', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		fixture.mutators.remoteHead('0'.repeat(40));
		await admitPush('call-restart');
		// Simulate the restart: the tool-after recorder never fires. The next
		// completion attempt reaps the foreign in-flight attempt first —
		// reconciling it as `uncertain` with a fresh remote observation —
		// before its own remote verification fails closed.
		await expect(
			completePrWorkflow(fixture.directory, SESSION_ID, 'PR_FEEDBACK', HEAD_SHA),
		).rejects.toThrow('intended remote-tracking ref');
		const { active, attempts } = await readPublication();
		expect(active?.state).toBe('armed');
		expect(attempts[0]?.result?.outcome).toBe('uncertain');
		expect(attempts[0]?.result?.postPush.observedRemoteHead).toBe(
			'0'.repeat(40),
		);
	});

	test('retry with unchanged identity starts a second attempt for the same generation', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		fixture.mutators.remoteHead('0'.repeat(40));
		await admitPush('call-3');
		// First attempt "failed" (non-zero exit, say); the result recorder
		// observes the remote NOT at the approved head → uncertain.
		await _test_exports.recordPrFeedbackPushAttemptResult(
			fixture.directory,
			{ sessionID: SESSION_ID, callID: 'call-3', tool: 'shell' },
			`git push origin ${POST_COMMIT_SHA}:refs/heads/pr-head`,
			{ output: 'error: failed to push' },
		);
		// Identity unchanged → the same generation may retry.
		await admitPush('call-4');
		const { active, attempts } = await readPublication();
		expect(active?.state).toBe('push_in_flight');
		expect(attempts.length).toBe(2);
		expect(attempts.every((a) => a.generation === 1)).toBe(true);
	});

	test('drift between attempts invalidates instead of retrying stale authority', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		fixture.mutators.remoteHead('0'.repeat(40));
		await admitPush('call-5');
		await _test_exports.recordPrFeedbackPushAttemptResult(
			fixture.directory,
			{ sessionID: SESSION_ID, callID: 'call-5', tool: 'shell' },
			`git push origin ${POST_COMMIT_SHA}:refs/heads/pr-head`,
			{ output: 'error: failed to push' },
		);
		// The remote target changes between attempts.
		fixture.mutators.upstream({
			remoteName: 'origin',
			remoteBranchRef: 'refs/heads/other-target',
			remoteTrackingRef: 'refs/remotes/origin/other-target',
		});
		await expect(admitPush('call-6')).rejects.toThrow(
			'was INVALIDATED because approved content identity drifted',
		);
		const { active } = await readPublication();
		expect(active?.state).toBe('invalidated');
		expect(active?.invalidationReason).toBe('drift:upstream');
	});

	test('duplicate/late results cannot double-record or resurrect push_in_flight', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		fixture.mutators.remoteHead(POST_COMMIT_SHA);
		await admitPush('call-7');
		// A late duplicate result for the same callID finds no result-less
		// attempt and is a no-op.
		await _test_exports.recordPrFeedbackPushAttemptResult(
			fixture.directory,
			{ sessionID: SESSION_ID, callID: 'call-7', tool: 'shell' },
			`git push origin ${POST_COMMIT_SHA}:refs/heads/pr-head`,
			{ output: 'late' },
		);
		const { active, attempts } = await readPublication();
		expect(active?.state).toBe('armed');
		expect(attempts.length).toBe(1);
	});

	test('completion publishes only with an observed attempt result and verified remote', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		fixture.mutators.remoteHead(POST_COMMIT_SHA);
		await admitPush('call-8');
		const status = await completePrWorkflow(
			fixture.directory,
			SESSION_ID,
			'PR_FEEDBACK',
			HEAD_SHA,
		);
		expect(status).toBe('completed');
		// Terminal: the gate state is gone.
		await expect(readPublicationState()).resolves.toBeNull();
	});

	test('a non-push tool result never records an attempt result', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		fixture.mutators.remoteHead('0'.repeat(40));
		await admitPush('call-9');
		await _test_exports.recordPrFeedbackPushAttemptResult(
			fixture.directory,
			{ sessionID: SESSION_ID, callID: 'call-9', tool: 'read' },
			`git push origin ${POST_COMMIT_SHA}:refs/heads/pr-head`,
			{},
		);
		const { attempts } = await readPublication();
		expect(attempts[0]?.result).toBeUndefined();
	});
});

async function readPublicationState() {
	return readPrWorkflowGateState(fixture.directory, SESSION_ID);
}

describe('exit status classification (issue #2108 §3, critic #2)', () => {
	async function admitAndRecord(
		metadataExit: number | undefined,
		remoteAtApprovedHead: boolean,
	): Promise<{ outcome: string; exitStatus: number | string }> {
		await fixture.prepareArmedGeneration(SESSION_ID);
		// Admit while the remote is NOT at the approved head so a REAL
		// attempt starts (a remote-at-head admission completes at admission
		// and the recorder never runs); flip the observation afterwards.
		_test_exports.resolveExactRemoteBranchHead = () => '0'.repeat(40);
		_test_exports.resolveExactRemoteBranchHeadAsync = async () =>
			'0'.repeat(40);
		await admitPush('call-exit');
		const remote = remoteAtApprovedHead ? POST_COMMIT_SHA : '0'.repeat(40);
		_test_exports.resolveExactRemoteBranchHead = () => remote;
		_test_exports.resolveExactRemoteBranchHeadAsync = async () => remote;
		await _test_exports.recordPrFeedbackPushAttemptResult(
			fixture.directory,
			{ sessionID: SESSION_ID, callID: 'call-exit', tool: 'shell' },
			`git push origin ${POST_COMMIT_SHA}:refs/heads/pr-head`,
			{ output: 'push output', metadata: { exitCode: metadataExit } },
		);
		const { attempts } = await readPublication();
		const result = attempts[attempts.length - 1]?.result;
		return {
			outcome: result?.outcome ?? 'none',
			exitStatus: result?.exitStatus ?? 'none',
		};
	}

	test('exit 0 + verified remote head -> completed with the exit persisted', async () => {
		const result = await admitAndRecord(0, true);
		expect(result.outcome).toBe('completed');
		expect(result.exitStatus).toBe(0);
	});

	test('known nonzero exit without remote verification -> rejected', async () => {
		const result = await admitAndRecord(128, false);
		expect(result.outcome).toBe('rejected');
		expect(result.exitStatus).toBe(128);
	});

	test('unobserved exit without remote verification -> uncertain', async () => {
		const result = await admitAndRecord(undefined, false);
		expect(result.outcome).toBe('uncertain');
		expect(result.exitStatus).toBe('not-observed');
	});

	test('nonzero exit WITH verified remote head -> completed (remote is the publication truth)', async () => {
		const result = await admitAndRecord(1, true);
		expect(result.outcome).toBe('completed');
		expect(result.exitStatus).toBe(1);
	});
});
