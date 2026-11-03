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
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir.js';

/**
 * Issue #3396 Stage A trust hardening: D7 (durable merge-base binding at
 * PR_FEEDBACK activation), D8 (compound-script plausibility screen), D9
 * (implicit npm lifecycle-hook screening). Mirrors the #3314 trusted-scripts
 * e2e harness (run-pr-feedback-stage-a-trusted-scripts-e2e.test.ts); the one
 * structural difference is that ACTIVATION moved out of beforeEach into
 * per-test helpers so each test controls the prUrl/binding shape. The
 * production `resolvePrFeedbackBaseViaGh` (one bounded `gh pr view`) is never
 * allowed to run here — the seam is always stubbed.
 */

const SESSION = 'stage-a-base-binding-3396';
const THROW_SESSION = 'stage-a-base-binding-3396-throw';
const HEAD = 'abccccccccccccccccccccccccccccccccccc123';
const BASE = 'defffffffffffffffffffffffffffffffffff456';
const OTHER_BASE = 'b'.repeat(40);
const A40 = 'a'.repeat(40);
const PR_URL = 'https://github.com/ZaxbyHub/opencode-swarm/pull/1234';
const REVISION = 'revision-1';
const TARGET = 'tests/targeted-regression.test.ts';
const VERIFIED_TEXT = '[FEEDBACK-VERIFIED] | FB-001 | CONFIRMED | evidence';

let directory = '';
let basePackageJson = '';
/** What the gateInternals.resolvePrFeedbackBaseViaGh stub resolves. */
let baseResolution:
	| { kind: 'ok'; ref: string; oid: string }
	| { kind: 'throw' }
	| { kind: 'null' } = { kind: 'null' };

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
const originalResolveBase = gateInternals.resolvePrFeedbackBaseViaGh;

beforeEach(async () => {
	directory = canonicalMkdtemp('feedback-stage-a-binding-3396-');
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
	gateInternals.resolvePrFeedbackBaseViaGh = async () => {
		if (baseResolution.kind === 'throw') {
			throw new Error('test-forced gh resolver failure');
		}
		if (baseResolution.kind === 'null') return null;
		return {
			baseRefName: baseResolution.ref,
			baseRefOid: baseResolution.oid,
		};
	};
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
	gateInternals.resolvePrFeedbackBaseViaGh = originalResolveBase;
	gateInternals.resetTrackedStateCache();
	baseResolution = { kind: 'null' };
	// #3396 feedback (PRR-017): retrying teardown — raw fs.rm on Windows
	// can hit EBUSY/EPERM from AV/indexer scans and leave a leaked tree.
	removeTreeWithRetry(directory);
});

async function activateWorkflow(sessionID: string, prUrl?: string) {
	await activatePrWorkflow(
		directory,
		sessionID,
		'PR_FEEDBACK',
		prUrl ? { prUrl } : undefined,
	);
}

/** Everything after activation that the #3314 e2e harness primes per test. */
async function declareVerifiedFeedbackLane(sessionID = SESSION) {
	await declarePrFeedbackInventory(directory, sessionID, ['FB-001'], {
		prHeadSha: HEAD,
	});
	await enforcePrFeedbackVerificationOwnership(
		directory,
		sessionID,
		[{ laneId: 'verify', ownedItemIds: ['FB-001'] }],
		{ batchId: 'verify-batch', prHeadSha: HEAD },
	);
	await recordPendingDelegation(directory, {
		correlationId: 'verify-lane',
		jobId: null,
		subagentSessionId: 'verify-lane',
		parentSessionId: sessionID,
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
		parentSessionId: sessionID,
		mode: 'swarm-pr-feedback:verification',
		workflowLane: 'verify',
		prHeadSha: HEAD,
		gitHead: HEAD,
		revisionDigest: REVISION,
		source: 'collect_lane_results',
		text: VERIFIED_TEXT,
	});
	await appendDelegationTransition(directory, 'verify-lane', {
		status: 'completed',
		result: {
			text: VERIFIED_TEXT,
			chars: stored.chars,
			truncated: false,
			digest: stored.digest,
			outputRef: stored.ref,
		},
	});
}

/** Write the working-tree manifest and pin the base manifest text. */
async function writeManifest(
	workingScripts: Record<string, string>,
	baseScripts?: Record<string, string>,
) {
	await fs.writeFile(
		path.join(directory, 'package.json'),
		JSON.stringify({ scripts: workingScripts }),
	);
	basePackageJson = JSON.stringify({ scripts: baseScripts ?? workingScripts });
}

function stageAChecks(
	buildCommand: readonly string[] = ['bun', 'run', 'build'],
) {
	return [
		{ category: 'build', command: [...buildCommand] },
		{ category: 'diff-check', command: ['git', 'diff', '--check'] },
		{
			category: 'reproduction',
			command: ['bun', 'test', TARGET],
			targets: [TARGET],
			feedback_targets: [
				{
					feedback_item_id: 'FB-001',
					target: TARGET,
					expected_behavior: '#3396 binding and screen fixture target',
					proof_kind: 'defect',
				},
			],
		},
	];
}

async function runStageA(checks: Array<Record<string, unknown>>) {
	return JSON.parse(
		await executeRunPrFeedbackStageA(
			{
				pr_head_sha: HEAD,
				base_ref: 'origin/main',
				base_sha: BASE,
				checks,
			},
			directory,
			{ sessionID: SESSION },
		),
	) as { success: boolean; message?: string };
}

describe('PR_FEEDBACK base binding at activation (#3396 S1)', () => {
	test('binds the gh-resolved merge base onto the gate state', async () => {
		baseResolution = { kind: 'ok', ref: 'main', oid: A40 };
		await activateWorkflow(SESSION, PR_URL);
		const state = await readPrWorkflowGateState(directory, SESSION);
		expect(state?.mode).toBe('PR_FEEDBACK');
		expect(state?.prFeedbackBaseRef).toBe('main');
		expect(state?.prFeedbackBaseSha).toBe(A40);
		expect(state?.prFeedbackBaseBindingError).toBeUndefined();
	});

	test('resolver failure is fail-open: fresh activation succeeds with an advisory', async () => {
		baseResolution = { kind: 'throw' };
		await activateWorkflow(THROW_SESSION, PR_URL);
		const state = await readPrWorkflowGateState(directory, THROW_SESSION);
		expect(state?.mode).toBe('PR_FEEDBACK');
		expect(state?.prFeedbackTargetUrl).toBe(PR_URL);
		expect(state?.prFeedbackBaseRef).toBeUndefined();
		expect(state?.prFeedbackBaseSha).toBeUndefined();
		const advisory = state?.prFeedbackBaseBindingError;
		expect(typeof advisory === 'string' && advisory.length > 0).toBe(true);
	});
});

describe('Stage A binding verification arms (#3396 S1c)', () => {
	test('bound base matching base_sha marks the run binding-verified', async () => {
		baseResolution = { kind: 'ok', ref: 'main', oid: BASE };
		await activateWorkflow(SESSION, PR_URL);
		await declareVerifiedFeedbackLane();
		await writeManifest({ build: 'custom-build && echo done' });
		const result = await runStageA(stageAChecks());
		expect(result.success).toBe(true);
		const state = await readPrWorkflowGateState(directory, SESSION);
		const stageA = state?.prFeedbackStageA;
		// #3396 feedback (PRR-004): the strict child stays on the BASE
		// two-value enum (rollback-safe floor: binding-verified maps to the
		// caller-asserted floor); the 4-value verdict rides the root-level
		// passthrough-safe prFeedbackStageABaseTrust.
		expect(stageA?.baseVerification).toBe('caller-asserted');
		expect(state?.prFeedbackStageABaseTrust).toBe('binding-verified');
		expect(stageA?.baseRef).toBe('origin/main');
		expect(stageA?.baseSha).toBe(BASE);
	});

	test('bound base differing from base_sha blocks the run and records the mismatch', async () => {
		baseResolution = { kind: 'ok', ref: 'main', oid: OTHER_BASE };
		await activateWorkflow(SESSION, PR_URL);
		await declareVerifiedFeedbackLane();
		await writeManifest({ build: 'custom-build && echo done' });
		const result = await runStageA(stageAChecks());
		// #3396 S1c per the issue's own contract: the caller provenance is
		// IGNORED (identical to no-provenance) — the run CONTINUES, and this
		// fixture needs trusted base-identical scripts, so it fails through
		// the ordinary opaque-script path (4.5 round 1 aligned the code with
		// the EARS text; a whole-run hard failure was over-strict).
		expect(result.success).toBe(false);
		expect(result.message ?? '').toContain('opaque package script');
		const state = await readPrWorkflowGateState(directory, SESSION);
		expect(state?.prFeedbackStageABaseMismatch).toMatchObject({
			expectedBaseSha: OTHER_BASE,
			receivedBaseSha: BASE,
		});
		// The blocked run persisted no Stage A receipt at all.
		expect(state?.prFeedbackStageA).toBeUndefined();
	});

	test('no binding (activation without prUrl) keeps the caller-asserted floor', async () => {
		await activateWorkflow(SESSION);
		await declareVerifiedFeedbackLane();
		await writeManifest({ build: 'custom-build && echo done' });
		const result = await runStageA(stageAChecks());
		expect(result.success).toBe(true);
		const state = await readPrWorkflowGateState(directory, SESSION);
		const stageA = state?.prFeedbackStageA;
		expect(stageA?.baseVerification).toBe('caller-asserted');
		expect(state?.prFeedbackStageABaseTrust).toBe('caller-asserted');
	});
});
