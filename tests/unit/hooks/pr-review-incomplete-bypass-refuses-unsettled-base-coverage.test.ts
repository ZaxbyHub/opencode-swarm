import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	activatePrWorkflow,
	completePrWorkflow,
	enforcePrReviewBaseDimensions,
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_REVISION_DIGEST,
	PR_ARTIFACT_SESSION_ID,
	persistPrReviewBatch,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { LEGACY_PR_REVIEW_RESILIENCE_POLICY } from '../pr-review-test-policy.js';

// Issue #3312 AC21: the honest INCOMPLETE bypass never replaces the base
// coverage settlement requirement. A PARTIAL-settlement run (five clean base
// dimensions, one operator_cancelled terminal failure, every launched lane
// terminal) with NO admitted partial-base coverage disclosure, asked to
// complete with report_verdict INCOMPLETE, is refused with the base-coverage
// BLOCKED error; the gate state is kept and no validation-skip-disclosure.json
// is written.
// Fixture note: on an undisclosed PARTIAL run the gate refuses even
// markPrReviewTriggerEvaluationComplete (it runs the same base-coverage
// assertion, pr-workflow-gate.ts assertPrReviewBaseCoverageSettled call), so
// the fixture deliberately stops after the terminal base lanes and the
// refusal under test comes from completePrWorkflow itself.
// GREEN at base (the ladder's base-coverage assertion refuses: "BLOCKED:
// PR_REVIEW base coverage is PARTIAL (...); no terminal settlement disclosure
// is admitted ...") and GREEN after the fix (the bypass never admits a run
// whose base coverage settlement is not disclosed).

const SESSION_ID = PR_ARTIFACT_SESSION_ID;
const HEAD_SHA = PR_ARTIFACT_HEAD_SHA;
const RUN_ID = 'ac21-partial-run';
let directory = '';

const ORIGINALS = {
	head: gateInternals.resolveCurrentGitHead,
	headAsync: gateInternals.resolveCurrentGitHeadAsync,
	revision: gateInternals.resolvePrWorkflowRevisionDigest,
	clean: gateInternals.resolveIsWorkingTreeClean,
	cleanAsync: gateInternals.resolveIsWorkingTreeCleanAsync,
};

beforeEach(async () => {
	directory = canonicalMkdtemp('pr-incomplete-bypass-ac21-');
	await fs.mkdir(path.join(directory, '.git'), { recursive: true });
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => HEAD_SHA;
	gateInternals.resolveCurrentGitHeadAsync = async () => HEAD_SHA;
	gateInternals.resolvePrWorkflowRevisionDigest = () =>
		PR_ARTIFACT_REVISION_DIGEST;
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolveIsWorkingTreeCleanAsync = async () => true;
});

afterEach(async () => {
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = ORIGINALS.head;
	gateInternals.resolveCurrentGitHeadAsync = ORIGINALS.headAsync;
	gateInternals.resolvePrWorkflowRevisionDigest = ORIGINALS.revision;
	gateInternals.resolveIsWorkingTreeClean = ORIGINALS.clean;
	gateInternals.resolveIsWorkingTreeCleanAsync = ORIGINALS.cleanAsync;
	closeAllProjectDbs();
	await fs.rm(directory, { recursive: true, force: true });
});

/**
 * PARTIAL-settlement fixture WITHOUT the partial-base coverage disclosure:
 * five base dimensions settle clean, the sixth terminally fails with a typed
 * operator_cancelled abandonment, and no trigger evaluation or validation
 * phase is recorded (the gate refuses both on an undisclosed PARTIAL run).
 * Every launched lane is terminal, so the completion attempt reaches the
 * base-coverage settlement refusal from completePrWorkflow itself.
 */
async function establishUndisclosedPartialBase(): Promise<void> {
	await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', {
		prHeadSha: HEAD_SHA,
	});
	const successful = PR_REVIEW_BASE_DIMENSION_IDS.slice(0, 5);
	const failed = PR_REVIEW_BASE_DIMENSION_IDS.slice(5);
	const lanes = successful.map((workflowLane) => ({
		laneId: `ok-${workflowLane}`,
		workflowLane,
	}));
	await enforcePrReviewBaseDimensions(directory, SESSION_ID, lanes, {
		batchId: 'base-successful',
		prHeadSha: HEAD_SHA,
		prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
	});
	await persistPrReviewBatch(
		directory,
		'base-successful',
		'swarm-pr-review:base',
		lanes,
	);
	for (const [index, workflowLane] of failed.entries()) {
		const batchId = `base-failed-${index}`;
		const failedLanes = [{ laneId: `failed-${workflowLane}`, workflowLane }];
		await enforcePrReviewBaseDimensions(directory, SESSION_ID, failedLanes, {
			batchId,
			prHeadSha: HEAD_SHA,
			prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
		});
		await persistPrReviewBatch(
			directory,
			batchId,
			'swarm-pr-review:base',
			failedLanes,
			{
				status: 'cancelled',
				workflowLaneFailureClass: 'operator_cancelled',
			},
		);
	}
}

describe('issue #3312 AC21 — the bypass refuses PARTIAL coverage without a disclosed settlement', () => {
	test('PARTIAL settlement with no admitted disclosure + INCOMPLETE is refused with the base-coverage error', async () => {
		await establishUndisclosedPartialBase();

		let message = '';
		try {
			await completePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', HEAD_SHA, {
				reportVerdict: 'INCOMPLETE',
			});
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toMatch(/BLOCKED: PR_REVIEW/);
		expect(message).toContain('base coverage');
		expect(message).toContain('PARTIAL');
		expect(message).toContain('no terminal settlement disclosure is admitted');

		// The refusal kept the gate state and wrote no skip disclosure.
		expect(await readPrWorkflowGateState(directory, SESSION_ID)).not.toBeNull();
		const disclosurePath = path.join(
			directory,
			'.swarm',
			'pr-review',
			RUN_ID,
			'validation-skip-disclosure.json',
		);
		await expect(fs.access(disclosurePath)).rejects.toThrow();
	});
});
