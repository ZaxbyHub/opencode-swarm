import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
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

// Split from run-pr-feedback-stage-a-runner-evidence.test.ts (FR-006):
// execution guards that reject list-only, zero-test, or validation-theater
// runner payloads before or during Stage A reproduction.

const SESSION = 'stage-a-runner-evidence-session';
const HEAD = 'abc123';
const BASE = 'def456';
const REVISION = 'revision-1';
let directory = '';
let baseContracts = new Map<string, string>();
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

const validChecks = [
	{ category: 'build', command: ['cargo', 'build'] },
	{ category: 'typecheck', command: ['tsc', '--noEmit'] },
	{ category: 'lint', command: ['eslint', '.'] },
	{ category: 'diff-check', command: ['git', 'diff', '--check'] },
	{
		category: 'reproduction',
		command: ['bun', 'test', 'tests/targeted-regression.test.ts'],
		targets: ['tests/targeted-regression.test.ts'],
		feedback_targets: [
			{
				feedback_item_id: 'FB-001',
				target: 'tests/targeted-regression.test.ts',
				expected_behavior: 'targeted regression passes after the feedback fix',
			},
		],
	},
] as const;

beforeEach(async () => {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'feedback-stage-a-runner-guards-')),
	);
	await fs.mkdir(path.join(directory, 'tests'), { recursive: true });
	await fs.writeFile(
		path.join(directory, 'tests', 'targeted-regression.test.ts'),
		'// Stage A target fixture\n',
		'utf8',
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
	baseContracts = new Map();
	_internals.resolveExactMergeBase = () => BASE;
	_internals.resolveExactMergeBaseAsync = async (...a) =>
		_internals.resolveExactMergeBase(...a);
	_internals.readGitTextAtRevision = (_directory, sha, contractPath) =>
		sha === BASE ? (baseContracts.get(contractPath) ?? null) : null;
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

describe('run_pr_feedback_stage_a runner evidence - execution guards', () => {
	test('rejects Jest list-only assignment variants before reproduction executes', async () => {
		for (const listFlag of [
			'--listTests=true',
			'--listTests=1',
			'--list-tests=true',
			'--list=true',
		]) {
			const checks = validChecks.map((check) =>
				check.category === 'reproduction'
					? { ...check, command: ['jest', check.targets[0], listFlag] }
					: check,
			);
			const result = JSON.parse(
				await executeRunPrFeedbackStageA(
					{ pr_head_sha: HEAD, checks },
					directory,
					{ sessionID: SESSION },
				),
			);
			expect(result.success).toBe(false);
			expect(result.message).toContain('not a recognized non-publishing');
		}
		expect(_internals.runExternalTool).not.toHaveBeenCalled();
	});

	test('rejects Bun --only before a zero-test reproduction can execute', async () => {
		const checks = validChecks.map((check) =>
			check.category === 'reproduction'
				? {
						...check,
						command: [
							'bun',
							'test',
							'tests/targeted-regression.test.ts',
							'--only',
						],
					}
				: check,
		);
		const result = JSON.parse(
			await executeRunPrFeedbackStageA(
				{ pr_head_sha: HEAD, checks },
				directory,
				{ sessionID: SESSION },
			),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain('not a recognized non-publishing');
		expect(_internals.runExternalTool).not.toHaveBeenCalled();
	});

	test('rejects supported-runner output that proves zero tests ran', async () => {
		for (const zeroTestOutput of [
			'0 pass\nRan 0 tests across 1 file.',
			'Tests run: 0, Failures: 0, Errors: 0, Skipped: 0',
			'No test is available in Example.dll',
			'No tests were found!!!',
			'0 examples, 0 failures',
			'No tests executed!',
			'0 passing',
			'running 0 tests',
			'collected 0 items',
			'[no test files]',
			'Tests are skipped.',
			'Task :test SKIPPED',
			'Task :test NO-SOURCE',
		]) {
			_internals.runExternalTool = mock(async ({ executable }) => ({
				status: 'completed' as const,
				exitCode: 0,
				stdout: executable === 'bun' ? zeroTestOutput : 'ok',
				stderr: '',
				stdoutTruncated: false,
				stderrTruncated: false,
			}));
			const result = JSON.parse(
				await executeRunPrFeedbackStageA(
					{ pr_head_sha: HEAD, checks: validChecks },
					directory,
					{ sessionID: SESSION },
				),
			);
			expect(result.success).toBe(false);
			expect(result.message).toContain('zero tests executed');
			expect(
				(await readPrWorkflowGateState(directory, SESSION))?.prFeedbackStageA,
			).toBeUndefined();
		}
	});
});
