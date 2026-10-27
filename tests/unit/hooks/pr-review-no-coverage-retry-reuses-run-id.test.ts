import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	_test_exports,
	activatePrWorkflow,
	completePrWorkflow,
	enforcePrReviewBaseDimensions,
	PR_REVIEW_BASE_DIMENSION_IDS,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_REVISION_DIGEST,
	PR_ARTIFACT_SESSION_ID,
	persistPrReviewBatch,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { writeAuthoritativePrWorkflowState } from '../../helpers/pr-workflow-state-authority.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { LEGACY_PR_REVIEW_RESILIENCE_POLICY } from '../pr-review-test-policy.js';

// ACCEPTANCE CHECK AC14 (DISCRIMINATING — RED at base, GREEN after the fix).
//
// Contract under test: a NO_COVERAGE completion that fails at the TERMINAL
// CLEAR after its mid-completion admission (a concurrent state write wins
// the CAS) must stay recoverable: the retry's NO_COVERAGE run id chain
// prefers the already-admitted disclosure's run id
// (`state.prReviewPartialBaseCoverage?.runId ?? prReviewArtifactRunId ??
//   prReviewReservedRunId ?? generatePrReviewRunId()`),
// so the re-admission on retry matches the existing disclosure instead of
// minting a fresh id and throwing 'differs from the immutable existing
// disclosure'.
//
// Failure injection: the gate's `_test_exports.beforeTerminalClear` seam
// fires exactly between the NO_COVERAGE admission and the terminal clear.
// The one-shot hook writes the just-admitted state back through the
// authoritative store with revision + 1 (the concurrent-writer simulation
// the seam exists for, per the beforeAbortClear precedent), so the clear's
// compare-and-swap throws 'BLOCKED: PR workflow gate state changed during
// terminal completion...' on attempt 1 — at base AND after the fix alike
// (that first-attempt failure is test-side injection, asserted below).
//
// RED at base: attempt 2 mints a NEW run id (no artifact/reserved id exists)
// and the re-admission throws
// 'BLOCKED: partial base coverage admission differs from the immutable
//  existing disclosure'
// so the expected-completed assertion fails. GREEN after the fix: attempt 2
// reuses the admitted disclosure's run id, re-admission accepts, and the
// workflow completes.

let directory = '';
const originalResolveCurrentGitHead = _test_exports.resolveCurrentGitHead;
const originalResolveCurrentGitHeadAsync =
	_test_exports.resolveCurrentGitHeadAsync;
const originalResolveRevisionDigest =
	_test_exports.resolvePrWorkflowRevisionDigest;
const originalResolveIsWorkingTreeClean =
	_test_exports.resolveIsWorkingTreeClean;
const originalResolveIsWorkingTreeCleanAsync =
	_test_exports.resolveIsWorkingTreeCleanAsync;

beforeEach(() => {
	directory = canonicalMkdtemp('ac14-no-coverage-retry-');
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = () => PR_ARTIFACT_HEAD_SHA;
	_test_exports.resolveCurrentGitHeadAsync = async () => PR_ARTIFACT_HEAD_SHA;
	_test_exports.resolvePrWorkflowRevisionDigest = () =>
		PR_ARTIFACT_REVISION_DIGEST;
	_test_exports.resolveIsWorkingTreeClean = () => true;
	_test_exports.resolveIsWorkingTreeCleanAsync = async () => true;
});

afterEach(async () => {
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = originalResolveCurrentGitHead;
	_test_exports.resolveCurrentGitHeadAsync = originalResolveCurrentGitHeadAsync;
	_test_exports.resolvePrWorkflowRevisionDigest = originalResolveRevisionDigest;
	_test_exports.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
	_test_exports.resolveIsWorkingTreeCleanAsync =
		originalResolveIsWorkingTreeCleanAsync;
	closeAllProjectDbs();
	await fs.rm(directory, { recursive: true, force: true });
});

/**
 * Zero-coverage fixture (the pr-review-terminal-report-verdict recipe): all
 * six base dimensions settle terminally FAILED/operator_cancelled — the
 * truthful operator-confirmed abandonment shape, non-retryable under every
 * policy, so NO_COVERAGE settles at completion with verdict INCOMPLETE.
 */
async function establishZeroCoverage(): Promise<void> {
	await activatePrWorkflow(directory, PR_ARTIFACT_SESSION_ID, 'PR_REVIEW', {
		prHeadSha: PR_ARTIFACT_HEAD_SHA,
	});
	for (const [index, workflowLane] of PR_REVIEW_BASE_DIMENSION_IDS.entries()) {
		const batchId = `base-failed-${index}`;
		const lanes = [{ laneId: `failed-${workflowLane}`, workflowLane }];
		await enforcePrReviewBaseDimensions(
			directory,
			PR_ARTIFACT_SESSION_ID,
			lanes,
			{
				batchId,
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
				prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
			},
		);
		await persistPrReviewBatch(
			directory,
			batchId,
			'swarm-pr-review:base',
			lanes,
			{
				status: 'cancelled',
				workflowLaneFailureClass: 'operator_cancelled',
			},
		);
	}
}

describe('AC14: NO_COVERAGE completion retried after a failed terminal clear reuses the admitted run id', () => {
	test('clear CAS fails post-admission once; the retry completes without the immutable-disclosure wedge', async () => {
		await establishZeroCoverage();
		// One-shot concurrent-writer injection at the gate's documented seam:
		// bump the durable revision AFTER the NO_COVERAGE admission so the
		// terminal clear's CAS throws. The hook clears itself before doing
		// anything (and resetTrackedStateCache would clear it too), so the
		// retry attempt runs with no injection.
		_test_exports.beforeTerminalClear = async () => {
			_test_exports.beforeTerminalClear = undefined;
			const current = await readPrWorkflowGateState(
				directory,
				PR_ARTIFACT_SESSION_ID,
			);
			if (!current) {
				throw new Error('AC14 injection: gate state vanished before the clear');
			}
			// The admission must already have landed: the injected state carries
			// the disclosure whose run id the retry is supposed to reuse.
			if (!current.prReviewPartialBaseCoverage) {
				throw new Error(
					'AC14 injection: hook fired before the NO_COVERAGE admission',
				);
			}
			await writeAuthoritativePrWorkflowState(directory, {
				...current,
				revision: current.revision + 1,
			});
			_test_exports.resetTrackedStateCache();
		};
		// Attempt 1: fails at the terminal clear — AFTER the admission — on
		// both the base tree and the fixed tree (test-side injection). This
		// assertion also proves the flow reached the clear; an admission-level
		// failure would surface a different message.
		await expect(
			completePrWorkflow(
				directory,
				PR_ARTIFACT_SESSION_ID,
				'PR_REVIEW',
				PR_ARTIFACT_HEAD_SHA,
				{ reportVerdict: 'INCOMPLETE' },
			),
		).rejects.toThrow('gate state changed during terminal completion');
		// The admitted disclosure survived the failed clear.
		const midRetry = await readPrWorkflowGateState(
			directory,
			PR_ARTIFACT_SESSION_ID,
		);
		const admittedRunId = midRetry?.prReviewPartialBaseCoverage?.runId;
		expect(admittedRunId).toBeTruthy();
		// Attempt 2: at base this throws
		// 'BLOCKED: partial base coverage admission differs from the immutable
		//  existing disclosure' (a fresh generated run id never matches) — the
		// RED signature. After the fix the retry reuses the admitted run id,
		// re-admission accepts, and the workflow completes.
		const status = await completePrWorkflow(
			directory,
			PR_ARTIFACT_SESSION_ID,
			'PR_REVIEW',
			PR_ARTIFACT_HEAD_SHA,
			{ reportVerdict: 'INCOMPLETE' },
		);
		expect(status).toBe('completed');
		expect(
			await readPrWorkflowGateState(directory, PR_ARTIFACT_SESSION_ID),
		).toBeNull();
	});
});
