import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	_test_exports,
	activatePrWorkflow,
} from '../../../src/hooks/pr-workflow-gate.js';
import { executeAbortPrWorkflow } from '../../../src/tools/abort-pr-workflow.js';
import {
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_SESSION_ID,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let directory = '';
const originalResolveCurrentGitHeadAsync =
	_test_exports.resolveCurrentGitHeadAsync;
const originalResolveWorkingTreeCleanAsync =
	_test_exports.resolveIsWorkingTreeCleanAsync;

const ARMED_DIGEST = 'b'.repeat(64);

beforeEach(() => {
	directory = canonicalMkdtemp('abort-armed-tool-');
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHeadAsync = async () => PR_ARTIFACT_HEAD_SHA;
	_test_exports.resolveIsWorkingTreeCleanAsync = async () => true;
});

afterEach(async () => {
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHeadAsync = originalResolveCurrentGitHeadAsync;
	_test_exports.resolveIsWorkingTreeCleanAsync =
		originalResolveWorkingTreeCleanAsync;
	await fs.rm(directory, { recursive: true, force: true });
});

async function armWorkflow(options: { withBase?: boolean } = {}): Promise<{
	generation: number;
	id: string;
}> {
	const state = await activatePrWorkflow(
		directory,
		PR_ARTIFACT_SESSION_ID,
		'PR_FEEDBACK',
		{ prHeadSha: PR_ARTIFACT_HEAD_SHA },
	);
	const armed = {
		...state,
		...(options.withBase
			? { prReviewBaseSha: 'fedcba9876543210fedcba9876543210fedcba98' }
			: {}),
		prFeedbackReadyToPublish: {
			revisionDigest: ARMED_DIGEST,
			localHead: PR_ARTIFACT_HEAD_SHA,
			remoteName: 'origin',
			remoteBranchRef: 'refs/heads/main',
			remoteRef: 'refs/remotes/origin/main',
			validatedAt: '2026-01-01T00:00:00.000Z',
		},
	};
	const statePath = path.join(
		directory,
		'.swarm',
		_test_exports.workflowGateStateRelativePath(PR_ARTIFACT_SESSION_ID),
	);
	await fs.mkdir(path.dirname(statePath), { recursive: true });
	await fs.writeFile(statePath, JSON.stringify(armed), 'utf8');
	_test_exports.resetTrackedStateCache();
	return {
		generation: armed.revision,
		id: armed.workflowInstanceId ?? '',
	};
}

const armedRecoveryArgs = (
	generation: number,
	workflowInstanceId?: string,
) => ({
	kind: 'armed_recovery' as const,
	reason: 'revision diverged after arming',
	armed_recovery: {
		pr_head_sha: PR_ARTIFACT_HEAD_SHA,
		revision_digest: ARMED_DIGEST,
		generation,
		...(workflowInstanceId ? { workflow_instance_id: workflowInstanceId } : {}),
	},
});

describe('abort_pr_workflow tool kind armed_recovery (issue #2383)', () => {
	test('recovers an armed workflow, preserves the gate, and reports the outcome', async () => {
		const { generation, id } = await armWorkflow();
		const raw = await executeAbortPrWorkflow(
			armedRecoveryArgs(generation, id),
			directory,
			{ sessionID: PR_ARTIFACT_SESSION_ID },
		);
		expect(JSON.parse(raw)).toMatchObject({
			success: true,
			armed_recovery: true,
			publication_authorization_invalidated: true,
			gate_preserved: true,
			mode: 'PR_FEEDBACK',
		});
		// The gate state file still exists (recoverable terminal, not cleared).
		const statePath = path.join(
			directory,
			'.swarm',
			_test_exports.workflowGateStateRelativePath(PR_ARTIFACT_SESSION_ID),
		);
		const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
		expect(state.prFeedbackReadyToPublish).toBeUndefined();
		expect(state.prFeedbackArmedRecovery).toMatchObject({
			generation,
		});
	});

	test('an identity mismatch fails closed with the BLOCKED message', async () => {
		const { generation } = await armWorkflow();
		const raw = await executeAbortPrWorkflow(
			{
				...armedRecoveryArgs(generation + 5),
			},
			directory,
			{ sessionID: PR_ARTIFACT_SESSION_ID },
		);
		const result = JSON.parse(raw);
		expect(result.success).toBe(false);
		expect(result.message).toContain('generation mismatch');
	});

	test('a base-bound armed workflow requires the exact base_sha', async () => {
		const { generation, id } = await armWorkflow({ withBase: true });
		const missing = await executeAbortPrWorkflow(
			armedRecoveryArgs(generation, id),
			directory,
			{ sessionID: PR_ARTIFACT_SESSION_ID },
		);
		expect(JSON.parse(missing).message).toContain('omitted base_sha');
		const wrong = await executeAbortPrWorkflow(
			{
				...armedRecoveryArgs(generation, id),
				armed_recovery: {
					...armedRecoveryArgs(generation, id).armed_recovery,
					base_sha: 'deadbeef1234',
				},
			},
			directory,
			{ sessionID: PR_ARTIFACT_SESSION_ID },
		);
		expect(JSON.parse(wrong).message).toContain('merge-base bound to');
		const exact = await executeAbortPrWorkflow(
			{
				...armedRecoveryArgs(generation, id),
				armed_recovery: {
					...armedRecoveryArgs(generation, id).armed_recovery,
					base_sha: 'fedcba9876543210fedcba9876543210fedcba98',
				},
			},
			directory,
			{ sessionID: PR_ARTIFACT_SESSION_ID },
		);
		expect(JSON.parse(exact)).toMatchObject({ success: true });
	});

	test('kind recovery remains unchanged and still refuses while armed', async () => {
		const { generation } = await armWorkflow();
		expect(generation).toBeGreaterThanOrEqual(0);
		const raw = await executeAbortPrWorkflow(
			{ kind: 'recovery', reason: 'ordinary recovery while armed' },
			directory,
			{ sessionID: PR_ARTIFACT_SESSION_ID },
		);
		const result = JSON.parse(raw);
		expect(result.success).toBe(false);
		expect(result.message).toContain('armed for publication');
	});

	test('rejects armed_recovery without the identity block', async () => {
		await armWorkflow();
		const raw = await executeAbortPrWorkflow(
			{ kind: 'armed_recovery', reason: 'missing identity' },
			directory,
			{ sessionID: PR_ARTIFACT_SESSION_ID },
		);
		expect(JSON.parse(raw).success).toBe(false);
	});
});
