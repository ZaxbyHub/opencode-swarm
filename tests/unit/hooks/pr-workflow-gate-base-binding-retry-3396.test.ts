import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
	activatePrWorkflow,
	_test_exports as gateInternals,
	_internals as gateSeams,
	readPrWorkflowGateState,
	rebindPrFeedbackHead,
	recordPrFeedbackBaseMismatch,
} from '../../../src/hooks/pr-workflow-gate.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir.js';

/**
 * #3396 feedback pins over the PR_FEEDBACK base binding lifecycle (the
 * PRR-006/007/009 fix round): the production `gh pr view` resolver's success
 * path (including 64-hex identities), the re-activation retry that heals an
 * unbound base, and the rebind clearing of the ancestry-bound anchor + marker.
 * The resolver runs for real through the gate's `_internals` DI seam — only
 * the `gh` subprocess and the merge-base probe are stubbed.
 */

const SESSION = 'base-binding-retry-3396';
const HEAD = 'a'.repeat(40);
const NEW_HEAD = 'c'.repeat(40);
const BASE_TIP = 'b'.repeat(40);
const MERGE_BASE = 'd'.repeat(64);
const PR_URL = 'https://github.com/ZaxbyHub/opencode-swarm/pull/1234';

let directory = '';
/** What the stubbed `gh` subprocess returns this leg. */
let ghOutcome: 'ok' | 'fail' | 'other-head' = 'ok';
/** The HEAD the stubbed git seams report (moves to NEW_HEAD for the rebind). */
let currentHead = HEAD;

const originalRunExternalTool = gateSeams.runExternalTool;
const originalResolveExactMergeBaseAsync = gateSeams.resolveExactMergeBaseAsync;
const originalResolveGhBinary = gateSeams.resolveGhBinary;
const originalDigest = gateInternals.resolvePrWorkflowRevisionDigest;
const originalHead = gateInternals.resolveCurrentGitHead;
const originalHeadAsync = gateInternals.resolveCurrentGitHeadAsync;
const originalClean = gateInternals.resolveIsWorkingTreeClean;
const originalCleanAsync = gateInternals.resolveIsWorkingTreeCleanAsync;
const originalUpstream = gateInternals.resolveCurrentUpstreamPushTarget;
const originalUpstreamAsync =
	gateInternals.resolveCurrentUpstreamPushTargetAsync;
const originalRemoteRefs = gateInternals.resolveRemoteRefsContainingHead;
const originalRemoteRefsAsync =
	gateInternals.resolveRemoteRefsContainingHeadAsync;

beforeEach(() => {
	directory = canonicalMkdtemp('base-binding-retry-3396-');
	ghOutcome = 'ok';
	currentHead = HEAD;
	gateInternals.resetTrackedStateCache();
	gateInternals.resolvePrWorkflowRevisionDigest = () => 'revision-1';
	gateInternals.resolveCurrentGitHead = () => currentHead;
	gateInternals.resolveCurrentGitHeadAsync = async () => currentHead;
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolveIsWorkingTreeCleanAsync = async () => true;
	gateInternals.resolveCurrentUpstreamPushTarget = () => ({
		remoteName: 'origin',
		remoteBranchRef: 'refs/heads/pr-head',
		remoteTrackingRef: 'refs/remotes/origin/pr-head',
	});
	gateInternals.resolveCurrentUpstreamPushTargetAsync = async () =>
		gateInternals.resolveCurrentUpstreamPushTarget();
	gateInternals.resolveRemoteRefsContainingHead = () => [
		'refs/remotes/origin/pr-head',
	];
	gateInternals.resolveRemoteRefsContainingHeadAsync = async () => [
		'refs/remotes/origin/pr-head',
	];
	gateSeams.resolveGhBinary = () => 'gh';
	gateSeams.resolveExactMergeBaseAsync = async () => MERGE_BASE;
	gateSeams.runExternalTool = mock(
		async (opts: { args: readonly string[] }) => {
			if (ghOutcome === 'fail') {
				return {
					status: 'completed' as const,
					exitCode: 1,
					stdout: '',
					stderr: 'gh: auth failure',
					stdoutTruncated: false,
					stderrTruncated: false,
				};
			}
			expect(opts.args).toContain('baseRefName,baseRefOid,headRefOid');
			return {
				status: 'completed' as const,
				exitCode: 0,
				stdout: JSON.stringify({
					baseRefName: 'main',
					baseRefOid: BASE_TIP,
					headRefOid: ghOutcome === 'other-head' ? NEW_HEAD : HEAD,
				}),
				stderr: '',
				stdoutTruncated: false,
				stderrTruncated: false,
			};
		},
	);
});

afterEach(() => {
	gateSeams.runExternalTool = originalRunExternalTool;
	gateSeams.resolveExactMergeBaseAsync = originalResolveExactMergeBaseAsync;
	gateSeams.resolveGhBinary = originalResolveGhBinary;
	gateInternals.resolvePrWorkflowRevisionDigest = originalDigest;
	gateInternals.resolveCurrentGitHead = originalHead;
	gateInternals.resolveCurrentGitHeadAsync = originalHeadAsync;
	gateInternals.resolveIsWorkingTreeClean = originalClean;
	gateInternals.resolveIsWorkingTreeCleanAsync = originalCleanAsync;
	gateInternals.resolveCurrentUpstreamPushTarget = originalUpstream;
	gateInternals.resolveCurrentUpstreamPushTargetAsync = originalUpstreamAsync;
	gateInternals.resolveRemoteRefsContainingHead = originalRemoteRefs;
	gateInternals.resolveRemoteRefsContainingHeadAsync = originalRemoteRefsAsync;
	gateInternals.resetTrackedStateCache();
	removeTreeWithRetry(directory);
});

describe('PR_FEEDBACK base binding lifecycle (#3396 feedback)', () => {
	test('resolver success path binds the computed merge base, not the base tip (PRR-001/007)', async () => {
		await activatePrWorkflow(directory, SESSION, 'PR_FEEDBACK', {
			prUrl: PR_URL,
		});
		const state = await readPrWorkflowGateState(directory, SESSION);
		expect(state?.prFeedbackBaseRef).toBe('main');
		expect(state?.prFeedbackBaseSha).toBe(MERGE_BASE);
		expect(state?.prFeedbackBaseSha).not.toBe(BASE_TIP);
		expect(state?.prFeedbackBaseBindingError).toBeUndefined();
	});

	test('a failed binding retries on the next re-activation and clears the advisory (PRR-006)', async () => {
		ghOutcome = 'fail';
		await activatePrWorkflow(directory, SESSION, 'PR_FEEDBACK', {
			prUrl: PR_URL,
		});
		const failed = await readPrWorkflowGateState(directory, SESSION);
		expect(failed?.prFeedbackBaseSha).toBeUndefined();
		expect(typeof failed?.prFeedbackBaseBindingError === 'string').toBe(true);

		// Re-activation with the gh failure healed: the unbound base MUST
		// resolve (the pre-fix code never retried once the target was bound)
		// and the stale advisory must be cleared.
		ghOutcome = 'ok';
		await activatePrWorkflow(directory, SESSION, 'PR_FEEDBACK', {
			prUrl: PR_URL,
		});
		const healed = await readPrWorkflowGateState(directory, SESSION);
		expect(healed?.prFeedbackBaseSha).toBe(MERGE_BASE);
		expect(healed?.prFeedbackBaseBindingError).toBeUndefined();
	});

	test('rebind clears the base anchor and mismatch marker (PRR-009)', async () => {
		await activatePrWorkflow(directory, SESSION, 'PR_FEEDBACK', {
			prUrl: PR_URL,
			prHeadSha: HEAD,
		});
		await recordPrFeedbackBaseMismatch(
			directory,
			SESSION,
			'e'.repeat(40),
			MERGE_BASE,
		);
		const before = await readPrWorkflowGateState(directory, SESSION);
		expect(before?.prFeedbackStageABaseMismatch).toBeDefined();

		currentHead = NEW_HEAD;
		await rebindPrFeedbackHead(directory, SESSION, NEW_HEAD);
		const after = await readPrWorkflowGateState(directory, SESSION);
		expect(after?.prHeadSha).toBe(NEW_HEAD);
		expect(after?.prFeedbackBaseRef).toBeUndefined();
		expect(after?.prFeedbackBaseSha).toBeUndefined();
		expect(after?.prFeedbackStageABaseMismatch).toBeUndefined();
		// Round-2 residual pins (reviewer E/F): the ancestry-bound trust
		// verdict and the stale binding advisory clear with the receipt.
		expect(after?.prFeedbackStageABaseTrust).toBeUndefined();
		expect(after?.prFeedbackBaseBindingError).toBeUndefined();
	});

	test('an anchor computed for a different PR head is skipped (review F5)', async () => {
		// The pre-lock resolution races a head move: when gh reports a head
		// that differs from the head being bound, the anchor must NOT be
		// applied (pre-fix of the guard this test pins, resolvedBaseHeadMatches
		// returning true unconditionally bound a stale-base anchor).
		ghOutcome = 'other-head';
		await activatePrWorkflow(directory, SESSION, 'PR_FEEDBACK', {
			prUrl: PR_URL,
			prHeadSha: HEAD,
		});
		const skipped = await readPrWorkflowGateState(directory, SESSION);
		expect(skipped?.prFeedbackBaseSha).toBeUndefined();
		expect(skipped?.prFeedbackBaseRef).toBeUndefined();

		// A matching head resolves and binds normally.
		ghOutcome = 'ok';
		await activatePrWorkflow(directory, SESSION, 'PR_FEEDBACK', {
			prUrl: PR_URL,
		});
		const healed = await readPrWorkflowGateState(directory, SESSION);
		expect(healed?.prFeedbackBaseSha).toBe(MERGE_BASE);
	});

	test('rebind clears a stale binding advisory (review F6)', async () => {
		ghOutcome = 'fail';
		await activatePrWorkflow(directory, SESSION, 'PR_FEEDBACK', {
			prUrl: PR_URL,
			prHeadSha: HEAD,
		});
		const failed = await readPrWorkflowGateState(directory, SESSION);
		expect(typeof failed?.prFeedbackBaseBindingError === 'string').toBe(true);

		currentHead = NEW_HEAD;
		await rebindPrFeedbackHead(directory, SESSION, NEW_HEAD);
		const after = await readPrWorkflowGateState(directory, SESSION);
		expect(after?.prFeedbackBaseBindingError).toBeUndefined();
	});
});
