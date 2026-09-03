import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	_test_exports,
	activatePrWorkflow,
	prWorkflowSessionFileStem,
	readPrWorkflowGateState,
	recoverArmedPrWorkflow,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	readPrWorkflowGateStateFromDisk,
	withSessionStateMutation,
	writeStateWhileLocked,
} from '../../../src/pr-review/persistence.js';
import {
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_SESSION_ID,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let directory = '';
const originalResolveCurrentGitHead = _test_exports.resolveCurrentGitHead;
const originalResolveCurrentGitHeadAsync =
	_test_exports.resolveCurrentGitHeadAsync;
const originalResolveWorkingTreeClean = _test_exports.resolveIsWorkingTreeClean;
const originalResolveWorkingTreeCleanAsync =
	_test_exports.resolveIsWorkingTreeCleanAsync;

const ARMED_DIGEST = 'a'.repeat(64);
const ARMED = {
	revisionDigest: ARMED_DIGEST,
	localHead: PR_ARTIFACT_HEAD_SHA,
	remoteName: 'origin',
	remoteBranchRef: 'refs/heads/main',
	remoteRef: 'refs/remotes/origin/main',
	validatedAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
	directory = canonicalMkdtemp('pr-armed-recovery-');
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = () => PR_ARTIFACT_HEAD_SHA;
	_test_exports.resolveCurrentGitHeadAsync = async () => PR_ARTIFACT_HEAD_SHA;
	_test_exports.resolveIsWorkingTreeClean = () => true;
	_test_exports.resolveIsWorkingTreeCleanAsync = async () => true;
});

afterEach(async () => {
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = originalResolveCurrentGitHead;
	_test_exports.resolveCurrentGitHeadAsync = originalResolveCurrentGitHeadAsync;
	_test_exports.resolveIsWorkingTreeClean = originalResolveWorkingTreeClean;
	_test_exports.resolveIsWorkingTreeCleanAsync =
		originalResolveWorkingTreeCleanAsync;
	closeAllProjectDbs();
	await fs.rm(directory, { recursive: true, force: true });
});

const ARMED_BASE_SHA = 'fedcba9876543210fedcba9876543210fedcba98';

async function establishArmed(options: { withBase?: boolean } = {}): Promise<{
	generation: number;
	workflowInstanceId: string;
}> {
	const state = await activatePrWorkflow(
		directory,
		PR_ARTIFACT_SESSION_ID,
		'PR_FEEDBACK',
		{ prHeadSha: PR_ARTIFACT_HEAD_SHA },
	);
	const armed = {
		...state,
		...(options.withBase ? { prReviewBaseSha: ARMED_BASE_SHA } : {}),
		prFeedbackReadyToPublish: ARMED,
	};
	await withSessionStateMutation(
		directory,
		PR_ARTIFACT_SESSION_ID,
		async () => {
			const current = await readPrWorkflowGateStateFromDisk(
				directory,
				PR_ARTIFACT_SESSION_ID,
			);
			expect(current).not.toBeNull();
			await writeStateWhileLocked(directory, armed);
		},
	);
	_test_exports.resetTrackedStateCache();
	return {
		generation: armed.revision + 1,
		workflowInstanceId: armed.workflowInstanceId!,
	};
}

const readEvents = async (): Promise<string> => {
	try {
		return await fs.readFile(`${directory}/.swarm/events.jsonl`, 'utf8');
	} catch {
		return '';
	}
};

describe('recoverArmedPrWorkflow (issue #2383)', () => {
	test('refuses when the workflow is not armed', async () => {
		await activatePrWorkflow(directory, PR_ARTIFACT_SESSION_ID, 'PR_FEEDBACK', {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
		});
		await expect(
			recoverArmedPrWorkflow(directory, PR_ARTIFACT_SESSION_ID, {
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
				revisionDigest: ARMED_DIGEST,
				generation: 0,
				reason: 'publication cannot proceed',
			}),
		).rejects.toThrow('not armed for publication');
	});

	test('refuses a wrong base/head SHA (fail closed)', async () => {
		await establishArmed();
		await expect(
			recoverArmedPrWorkflow(directory, PR_ARTIFACT_SESSION_ID, {
				prHeadSha: 'deadbeef12',
				revisionDigest: ARMED_DIGEST,
				generation: 0,
				reason: 'publication cannot proceed',
			}),
		).rejects.toThrow('head mismatch');
	});

	test('refuses a wrong revision digest (fail closed)', async () => {
		await establishArmed();
		await expect(
			recoverArmedPrWorkflow(directory, PR_ARTIFACT_SESSION_ID, {
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
				revisionDigest: 'f'.repeat(64),
				generation: 0,
				reason: 'publication cannot proceed',
			}),
		).rejects.toThrow('revision digest does not match');
	});

	test('refuses a stale generation (fail closed)', async () => {
		const { generation } = await establishArmed();
		await expect(
			recoverArmedPrWorkflow(directory, PR_ARTIFACT_SESSION_ID, {
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
				revisionDigest: ARMED_DIGEST,
				generation: generation + 7,
				reason: 'publication cannot proceed',
			}),
		).rejects.toThrow('generation mismatch');
	});

	test('refuses a mismatched workflow identity (fail closed)', async () => {
		const { generation } = await establishArmed();
		await expect(
			recoverArmedPrWorkflow(directory, PR_ARTIFACT_SESSION_ID, {
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
				revisionDigest: ARMED_DIGEST,
				generation,
				workflowInstanceId: 'a-different-workflow',
				reason: 'publication cannot proceed',
			}),
		).rejects.toThrow(/workflow identity mismatch/);
	});

	test('a foreign session finds no armed state (fail closed)', async () => {
		await establishArmed();
		await expect(
			recoverArmedPrWorkflow(directory, 'session-that-does-not-exist', {
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
				revisionDigest: ARMED_DIGEST,
				generation: 0,
				reason: 'publication cannot proceed',
			}),
		).rejects.toThrow();
	});

	test('success: settles lanes first, one audit event, invalidates the staged authorization, preserves state', async () => {
		const { generation, workflowInstanceId } = await establishArmed();
		const summary = await recoverArmedPrWorkflow(
			directory,
			PR_ARTIFACT_SESSION_ID,
			{
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
				revisionDigest: ARMED_DIGEST,
				generation,
				workflowInstanceId,
				reason: 'revision diverged after arming',
			},
		);
		expect(summary.mode).toBe('PR_FEEDBACK');
		expect(summary.cancelledDimensions).toEqual([]);
		const state = await readPrWorkflowGateState(
			directory,
			PR_ARTIFACT_SESSION_ID,
		);
		// State PRESERVED (recoverable terminal), armed invalidated, marker set.
		expect(state).not.toBeNull();
		expect(state!.prFeedbackReadyToPublish).toBeUndefined();
		expect(state!.prFeedbackArmedRecovery).toMatchObject({
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
			revisionDigest: ARMED_DIGEST,
			generation,
			reason: 'revision diverged after arming',
		});
		// Exactly ONE bounded audit event.
		const events = await readEvents();
		const matches = events.match(/"pr_workflow_armed_recovery"/g) ?? [];
		expect(matches).toHaveLength(1);
		const eventLine = events
			.split('\n')
			.find((line) => line.includes('pr_workflow_armed_recovery'));
		expect(eventLine).toBeTruthy();
		const event = JSON.parse(eventLine!);
		expect(event).toMatchObject({
			type: 'pr_workflow_armed_recovery',
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
			revisionDigest: ARMED_DIGEST,
			generation,
			reason: 'revision diverged after arming',
		});
		// The audit event carries no lane output or secrets — bounded fields only.
		expect(Object.keys(event).sort()).toEqual(
			[
				'cancelledDimensions',
				'generation',
				'mode',
				'prHeadSha',
				'reason',
				'revisionDigest',
				'sessionID',
				'settledLanes',
				'timestamp',
				'type',
			].sort(),
		);
		// The session file still exists under its canonical name.
		const stem = prWorkflowSessionFileStem(PR_ARTIFACT_SESSION_ID);
		expect(stem).toBeTruthy();
	});

	test('base-bound workflow requires the exact base SHA (fail closed)', async () => {
		const { generation, workflowInstanceId } = await establishArmed({
			withBase: true,
		});
		// Omitted base on a base-bound workflow fails closed.
		await expect(
			recoverArmedPrWorkflow(directory, PR_ARTIFACT_SESSION_ID, {
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
				revisionDigest: ARMED_DIGEST,
				generation,
				workflowInstanceId,
				reason: 'omitted base',
			}),
		).rejects.toThrow(/omitted base_sha/);
		// Wrong base fails closed.
		await expect(
			recoverArmedPrWorkflow(directory, PR_ARTIFACT_SESSION_ID, {
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
				baseSha: 'deadbeef1234',
				revisionDigest: ARMED_DIGEST,
				generation,
				workflowInstanceId,
				reason: 'wrong base',
			}),
		).rejects.toThrow(/merge-base bound to/);
		// Exact base succeeds.
		const summary = await recoverArmedPrWorkflow(
			directory,
			PR_ARTIFACT_SESSION_ID,
			{
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
				baseSha: ARMED_BASE_SHA,
				revisionDigest: ARMED_DIGEST,
				generation,
				workflowInstanceId,
				reason: 'exact base',
			},
		);
		expect(summary.mode).toBe('PR_FEEDBACK');
	});

	test('a base-less workflow rejects a declared base SHA (fail closed)', async () => {
		const { generation } = await establishArmed();
		await expect(
			recoverArmedPrWorkflow(directory, PR_ARTIFACT_SESSION_ID, {
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
				baseSha: ARMED_BASE_SHA,
				revisionDigest: ARMED_DIGEST,
				generation,
				reason: 'unexpected base',
			}),
		).rejects.toThrow(/no merge-base binding but the request declared one/);
	});

	test('recovery is idempotent-hostile: a second recovery finds no armed state', async () => {
		const { generation, workflowInstanceId } = await establishArmed();
		await recoverArmedPrWorkflow(directory, PR_ARTIFACT_SESSION_ID, {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
			revisionDigest: ARMED_DIGEST,
			generation,
			workflowInstanceId,
			reason: 'first recovery',
		});
		await expect(
			recoverArmedPrWorkflow(directory, PR_ARTIFACT_SESSION_ID, {
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
				revisionDigest: ARMED_DIGEST,
				generation,
				reason: 'second attempt',
			}),
		).rejects.toThrow('not armed for publication');
	});

	test('requires a non-empty reason', async () => {
		await establishArmed();
		await expect(
			recoverArmedPrWorkflow(directory, PR_ARTIFACT_SESSION_ID, {
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
				revisionDigest: ARMED_DIGEST,
				generation: 0,
				reason: '   ',
			}),
		).rejects.toThrow('non-empty reason');
	});
});
