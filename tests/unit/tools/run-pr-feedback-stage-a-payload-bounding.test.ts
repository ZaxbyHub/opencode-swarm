import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	_internals,
	executeRunPrFeedbackStageA,
} from '../../../src/tools/run-pr-feedback-stage-a.js';

// Regression coverage for FINDING R2: buildBoundedChecksPayload must fail
// OPEN toward evidence availability when persisting full output fails,
// rather than silently dropping everything but a 4096-byte tail of the
// failing check. See src/tools/run-pr-feedback-stage-a.ts around
// buildBoundedChecksPayload/persistFullOutput.

const SESSION = 'stage-a-payload-session';
const HEAD = 'def456';
const REVISION = 'revision-payload-1';
let directory = '';

const originalRunner = _internals.runExternalTool;
const originalStoreSummary = _internals.storeSummary;
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

const LARGE_STDOUT = '0123456789'.repeat(1000); // 10,000 bytes, > 4096 tail cap
const LARGE_STDERR = 'stderr-line-'.repeat(400); // > 4096 bytes

beforeEach(async () => {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'feedback-stage-a-payload-')),
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
	_internals.resolveGitControlStateDigest = () => 'git-control-payload-1';
	_internals.resolveGitControlStateDigestAsync = async (dir) =>
		_internals.resolveGitControlStateDigest(dir);
	_internals.runExternalTool = async () => ({
		status: 'completed' as const,
		exitCode: 0,
		stdout: 'ok',
		stderr: '',
		stdoutTruncated: false,
		stderrTruncated: false,
	});
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
	_internals.storeSummary = originalStoreSummary;
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

const baseChecks = [
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

/** Fails the reproduction check (2nd runExternalTool call) with large output. */
function failReproductionWithLargeOutput(): void {
	let callCount = 0;
	_internals.runExternalTool = async () => {
		callCount += 1;
		if (callCount === 1) {
			return {
				status: 'completed' as const,
				exitCode: 0,
				stdout: 'diff-check ok',
				stderr: '',
				stdoutTruncated: false,
				stderrTruncated: false,
			};
		}
		return {
			status: 'completed' as const,
			exitCode: 1,
			stdout: LARGE_STDOUT,
			stderr: LARGE_STDERR,
			stdoutTruncated: false,
			stderrTruncated: false,
		};
	};
}

describe('run_pr_feedback_stage_a payload bounding', () => {
	test('success path: per-check summaries with no inline stdout/stderr, plus full_output_ref', async () => {
		const result = JSON.parse(
			await executeRunPrFeedbackStageA(
				{ pr_head_sha: HEAD, checks: baseChecks },
				directory,
				{ sessionID: SESSION },
			),
		);
		expect(result.success).toBe(true);
		expect(result.checks).toHaveLength(2);
		for (const check of result.checks) {
			expect(check.stdout).toBeUndefined();
			expect(check.stderr).toBeUndefined();
			expect(check.stdout_tail).toBeUndefined();
			expect(check.stderr_tail).toBeUndefined();
		}
		expect(typeof result.full_output_ref).toBe('string');
		expect(result.full_output_storage_error).toBeUndefined();
	});

	test('failure path with working persistence: summaries plus a bounded tail on the failing check only', async () => {
		failReproductionWithLargeOutput();
		const result = JSON.parse(
			await executeRunPrFeedbackStageA(
				{ pr_head_sha: HEAD, checks: baseChecks },
				directory,
				{ sessionID: SESSION },
			),
		);
		expect(result.success).toBe(false);
		expect(result.checks).toHaveLength(2);

		const [diffCheck, reproductionCheck] = result.checks;
		// Non-failing check stays a bare summary.
		expect(diffCheck.stdout).toBeUndefined();
		expect(diffCheck.stdout_tail).toBeUndefined();

		// Failing (last) check carries bounded tails, not the full output.
		expect(reproductionCheck.stdout).toBeUndefined();
		expect(reproductionCheck.stderr).toBeUndefined();
		expect(typeof reproductionCheck.stdout_tail).toBe('string');
		expect(typeof reproductionCheck.stderr_tail).toBe('string');
		expect(reproductionCheck.stdout_tail).not.toBe(LARGE_STDOUT);
		expect(reproductionCheck.stdout_tail).toBe(LARGE_STDOUT.slice(-4096));
		expect(reproductionCheck.stderr_tail).toBe(LARGE_STDERR.slice(-4096));

		expect(typeof result.full_output_ref).toBe('string');
		expect(result.full_output_retrieval).toContain(result.full_output_ref);
		expect(result.full_output_storage_error).toBeUndefined();
	});

	test('regression guard (FINDING R2): failure path with persistence throwing keeps the failing check full stdout/stderr inline', async () => {
		failReproductionWithLargeOutput();
		_internals.storeSummary = async () => {
			throw new Error('simulated persistence failure: entry exceeds cap');
		};
		const result = JSON.parse(
			await executeRunPrFeedbackStageA(
				{ pr_head_sha: HEAD, checks: baseChecks },
				directory,
				{ sessionID: SESSION },
			),
		);
		expect(result.success).toBe(false);
		expect(result.checks).toHaveLength(2);

		const [diffCheck, reproductionCheck] = result.checks;
		// Non-failing check is still summarized; it was never the evidence
		// anyone needs.
		expect(diffCheck.stdout).toBeUndefined();
		expect(diffCheck.stderr).toBeUndefined();

		// The failing check's FULL, untruncated output must survive inline
		// because there is nowhere else for it to live: persistence failed.
		expect(reproductionCheck.stdout).toBe(LARGE_STDOUT);
		expect(reproductionCheck.stderr).toBe(LARGE_STDERR);
		expect(reproductionCheck.stdout_tail).toBeUndefined();
		expect(reproductionCheck.stderr_tail).toBeUndefined();

		expect(result.full_output_ref).toBeUndefined();
		expect(typeof result.full_output_storage_error).toBe('string');
		expect(result.full_output_storage_error).toContain(
			'simulated persistence failure',
		);
	});

	test('tail bounding caps stdout_tail/stderr_tail at exactly 4096 bytes', async () => {
		failReproductionWithLargeOutput();
		const result = JSON.parse(
			await executeRunPrFeedbackStageA(
				{ pr_head_sha: HEAD, checks: baseChecks },
				directory,
				{ sessionID: SESSION },
			),
		);
		const [, reproductionCheck] = result.checks;
		expect(Buffer.byteLength(reproductionCheck.stdout_tail, 'utf8')).toBe(4096);
		expect(Buffer.byteLength(reproductionCheck.stderr_tail, 'utf8')).toBe(4096);
	});
});
