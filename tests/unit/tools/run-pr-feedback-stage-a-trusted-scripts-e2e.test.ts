import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { storeLaneOutput } from '../../../src/background/lane-output-store.js';
import {
	appendDelegationTransition,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	activatePrWorkflow,
	declarePrFeedbackInventory,
	enforcePrFeedbackVerificationOwnership,
	_test_exports as gateInternals,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	_internals,
	executeRunPrFeedbackStageA,
} from '../../../src/tools/run-pr-feedback-stage-a.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const SESSION = 'stage-a-trusted-scripts-e2e';
const HEAD = 'abccccccccccccccccccccccccccccccccccc123';
const BASE = 'defffffffffffffffffffffffffffffffffff456';
const REVISION = 'revision-1';
let directory = '';
let basePackageJson = '';
const originalRunner = _internals.runExternalTool;
const originalReadGitTextAtRevision = _internals.readGitTextAtRevision;
const originalResolveExactMergeBase = _internals.resolveExactMergeBase;
const originalResolveExactMergeBaseAsync =
	_internals.resolveExactMergeBaseAsync;
const originalDigest = _internals.resolvePrWorkflowRevisionDigest;
const originalDigestAsync = _internals.resolvePrWorkflowRevisionDigestAsync;
const originalStageHead = _internals.resolveCurrentGitHead;
const originalStageHeadAsync = _internals.resolveCurrentGitHeadAsync;
const originalControlDigest = _internals.resolveGitControlStateDigest;
const originalControlDigestAsync = _internals.resolveGitControlStateDigestAsync;
const originalGateDigest = gateInternals.resolvePrWorkflowRevisionDigest;
const originalHead = gateInternals.resolveCurrentGitHead;
const originalHeadAsync = gateInternals.resolveCurrentGitHeadAsync;
const originalWorkingTreeClean = gateInternals.resolveIsWorkingTreeClean;
const originalWorkingTreeCleanAsync =
	gateInternals.resolveIsWorkingTreeCleanAsync;
const originalUpstreamPushTarget =
	gateInternals.resolveCurrentUpstreamPushTarget;
const originalUpstreamPushTargetAsync =
	gateInternals.resolveCurrentUpstreamPushTargetAsync;
const originalRemoteRefsContainingHead =
	gateInternals.resolveRemoteRefsContainingHead;
const originalRemoteRefsContainingHeadAsync =
	gateInternals.resolveRemoteRefsContainingHeadAsync;

beforeEach(async () => {
	directory = canonicalMkdtemp('feedback-stage-a-trusted-e2e-');
	await fs.mkdir(path.join(directory, 'tests'), { recursive: true });
	await fs.writeFile(
		path.join(directory, 'tests', 'targeted-regression.test.ts'),
		'// target\n',
	);
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => HEAD;
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolveCurrentGitHeadAsync = async (dir) =>
		gateInternals.resolveCurrentGitHead(dir);
	gateInternals.resolveIsWorkingTreeCleanAsync = async (dir) =>
		gateInternals.resolveIsWorkingTreeClean(dir);
	gateInternals.resolveCurrentUpstreamPushTarget = () => ({
		remoteName: 'origin',
		remoteBranchRef: 'refs/heads/pr-feedback-head',
		remoteTrackingRef: 'refs/remotes/origin/pr-feedback-head',
	});
	gateInternals.resolveCurrentUpstreamPushTargetAsync = async (dir) =>
		gateInternals.resolveCurrentUpstreamPushTarget(dir);
	gateInternals.resolveRemoteRefsContainingHead = () => [
		'refs/remotes/origin/pr-feedback-head',
	];
	gateInternals.resolveRemoteRefsContainingHeadAsync = async (dir, head) =>
		gateInternals.resolveRemoteRefsContainingHead(dir, head);
	gateInternals.resolvePrWorkflowRevisionDigest = () => REVISION;
	_internals.resolvePrWorkflowRevisionDigest = () => REVISION;
	_internals.resolvePrWorkflowRevisionDigestAsync = async (...a) =>
		_internals.resolvePrWorkflowRevisionDigest(...a);
	_internals.resolveCurrentGitHead = () => HEAD;
	_internals.resolveCurrentGitHeadAsync = async (dir) =>
		_internals.resolveCurrentGitHead(dir);
	_internals.resolveGitControlStateDigest = () => 'git-control-1';
	_internals.resolveGitControlStateDigestAsync = async (dir) =>
		_internals.resolveGitControlStateDigest(dir);
	basePackageJson = '';
	_internals.resolveExactMergeBase = () => BASE;
	_internals.resolveExactMergeBaseAsync = async (...a) =>
		_internals.resolveExactMergeBase(...a);
	_internals.readGitTextAtRevision = (_dir, sha, manifestPath) =>
		sha === BASE && manifestPath === './package.json' ? basePackageJson : null;
	_internals.runExternalTool = mock(async () => ({
		status: 'completed' as const,
		exitCode: 0,
		stdout: 'ok',
		stderr: '',
		stdoutTruncated: false,
		stderrTruncated: false,
	}));
	await activatePrWorkflow(directory, SESSION, 'PR_FEEDBACK');
	await declarePrFeedbackInventory(directory, SESSION, ['FB-001'], {
		prHeadSha: HEAD,
	});
	await enforcePrFeedbackVerificationOwnership(
		directory,
		SESSION,
		[{ laneId: 'verify', ownedItemIds: ['FB-001'] }],
		{ batchId: 'verify-batch', prHeadSha: HEAD },
	);
	const text = '[FEEDBACK-VERIFIED] | FB-001 | CONFIRMED | evidence';
	await recordPendingDelegation(directory, {
		correlationId: 'verify-lane',
		jobId: null,
		subagentSessionId: 'verify-lane',
		parentSessionId: SESSION,
		callID: 'verify-batch',
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: 'verify-batch',
		laneId: 'verify',
		mode: 'swarm-pr-feedback:verification',
		workflowLane: 'verify',
		workspace: {
			directory,
			gitHead: HEAD,
			dirtyHash: REVISION,
			prHeadSha: HEAD,
			scope: null,
		},
	});
	const stored = storeLaneOutput(directory, {
		batchId: 'verify-batch',
		laneId: 'verify',
		agent: 'reviewer',
		role: 'reviewer',
		sessionId: 'verify-lane',
		parentSessionId: SESSION,
		mode: 'swarm-pr-feedback:verification',
		workflowLane: 'verify',
		prHeadSha: HEAD,
		gitHead: HEAD,
		revisionDigest: REVISION,
		source: 'collect_lane_results',
		text,
	});
	await appendDelegationTransition(directory, 'verify-lane', {
		status: 'completed',
		result: {
			text,
			chars: stored.chars,
			truncated: false,
			digest: stored.digest,
			outputRef: stored.ref,
		},
	});
});

afterEach(async () => {
	_internals.runExternalTool = originalRunner;
	_internals.readGitTextAtRevision = originalReadGitTextAtRevision;
	_internals.resolveExactMergeBase = originalResolveExactMergeBase;
	_internals.resolveExactMergeBaseAsync = originalResolveExactMergeBaseAsync;
	_internals.resolvePrWorkflowRevisionDigest = originalDigest;
	_internals.resolvePrWorkflowRevisionDigestAsync = originalDigestAsync;
	_internals.resolveCurrentGitHead = originalStageHead;
	_internals.resolveCurrentGitHeadAsync = originalStageHeadAsync;
	_internals.resolveGitControlStateDigest = originalControlDigest;
	_internals.resolveGitControlStateDigestAsync = originalControlDigestAsync;
	gateInternals.resolvePrWorkflowRevisionDigest = originalGateDigest;
	gateInternals.resolveCurrentGitHead = originalHead;
	gateInternals.resolveCurrentGitHeadAsync = originalHeadAsync;
	gateInternals.resolveIsWorkingTreeClean = originalWorkingTreeClean;
	gateInternals.resolveIsWorkingTreeCleanAsync = originalWorkingTreeCleanAsync;
	gateInternals.resolveCurrentUpstreamPushTarget = originalUpstreamPushTarget;
	gateInternals.resolveCurrentUpstreamPushTargetAsync =
		originalUpstreamPushTargetAsync;
	gateInternals.resolveRemoteRefsContainingHead =
		originalRemoteRefsContainingHead;
	gateInternals.resolveRemoteRefsContainingHeadAsync =
		originalRemoteRefsContainingHeadAsync;
	gateInternals.resetTrackedStateCache();
	await fs.rm(directory, { recursive: true, force: true });
});

/**
 * Issue #3314 AC3 — Stage A trusts a compound package script whose working-tree
 * package.json text is byte-identical to the immutable merge base, and records
 * the Stage A receipt without an explicit obligation_id (single-candidate
 * auto-selection binds the discovered build obligation).
 * RED at base, GREEN after the fix.
 */
describe('Stage A trusts base-identical compound package scripts end to end (AC3)', () => {
	test('executes a trusted compound build script and records the receipt', async () => {
		const packageJsonText = JSON.stringify({
			scripts: { build: 'custom-build && echo done' },
		});
		basePackageJson = packageJsonText;
		await fs.writeFile(path.join(directory, 'package.json'), packageJsonText);

		const result = JSON.parse(
			await executeRunPrFeedbackStageA(
				{
					pr_head_sha: HEAD,
					base_ref: 'origin/main',
					base_sha: BASE,
					checks: [
						{ category: 'build', command: ['bun', 'run', 'build'] },
						{ category: 'diff-check', command: ['git', 'diff', '--check'] },
						{
							category: 'reproduction',
							command: ['bun', 'test', 'tests/targeted-regression.test.ts'],
							targets: ['tests/targeted-regression.test.ts'],
							feedback_targets: [
								{
									feedback_item_id: 'FB-001',
									target: 'tests/targeted-regression.test.ts',
									expected_behavior:
										'trusted compound build passes discovery and records the receipt',
									proof_kind: 'defect',
								},
							],
						},
					],
				},
				directory,
				{ sessionID: SESSION },
			),
		);
		expect(result).toMatchObject({ success: true });
		expect(result.success).toBe(true);
		const stageA = (await readPrWorkflowGateState(directory, SESSION))
			?.prFeedbackStageA;
		expect(stageA?.checks?.length ?? 0).toBeGreaterThan(0);
	});
});
