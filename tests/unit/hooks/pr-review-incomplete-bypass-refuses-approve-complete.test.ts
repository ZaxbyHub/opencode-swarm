import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	completePrWorkflow,
	_test_exports as gateInternals,
	readPrWorkflowGateState,
	recordPrReviewValidationBatch,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	establishPrReviewPrerequisites,
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_REVISION_DIGEST,
	PR_ARTIFACT_SESSION_ID,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

// Issue #3312 AC20: the honest INCOMPLETE bypass NEVER admits APPROVE. A
// COMPLETE-settlement run with a recorded-but-unsettled reviewer batch asked
// to complete with report_verdict APPROVE is refused — APPROVE passes the
// COMPLETE coverage verdict matrix, so the refusal comes from the ladder's
// reviewer-settlement assertion (not an earlier verdict rejection) — the gate
// state is kept and no validation-skip-disclosure.json is written.
// GREEN at base (the ladder refuses) and GREEN after the fix (APPROVE keeps
// routing through the existing ladder; only INCOMPLETE takes the bypass).

const SESSION_ID = PR_ARTIFACT_SESSION_ID;
const HEAD_SHA = PR_ARTIFACT_HEAD_SHA;
const RUN_ID = 'ac20-complete-run';
let directory = '';

const ORIGINALS = {
	head: gateInternals.resolveCurrentGitHead,
	headAsync: gateInternals.resolveCurrentGitHeadAsync,
	revision: gateInternals.resolvePrWorkflowRevisionDigest,
	clean: gateInternals.resolveIsWorkingTreeClean,
	cleanAsync: gateInternals.resolveIsWorkingTreeCleanAsync,
};

beforeEach(async () => {
	directory = canonicalMkdtemp('pr-incomplete-bypass-ac20-');
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

/** Declare a reviewer batch over the full candidate inventory (C-0..C-5) that
 * never settles: no persisted reviewer artifact, no delegation record, no
 * admission receipt. */
async function recordUnsettledReviewerBatch(): Promise<void> {
	await recordPrReviewValidationBatch(
		directory,
		SESSION_ID,
		'reviewer',
		[
			{
				laneId: `${RUN_ID}-rv`,
				workflowLane: `${RUN_ID}-rv`,
				reviewItemIds: ['C-0', 'C-1', 'C-2', 'C-3', 'C-4', 'C-5'],
			},
		],
		{ batchId: `${RUN_ID}-rv`, prHeadSha: HEAD_SHA },
	);
}

describe('issue #3312 AC20 — the bypass never admits APPROVE on COMPLETE coverage', () => {
	test('COMPLETE coverage + unsettled reviewer phase + APPROVE is refused by the ladder, no disclosure', async () => {
		await establishPrReviewPrerequisites(directory, RUN_ID);
		await recordUnsettledReviewerBatch();

		let message = '';
		try {
			await completePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', HEAD_SHA, {
				reportVerdict: 'APPROVE',
			});
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		// APPROVE is verdict-permitted for COMPLETE coverage, so the refusal is
		// NOT a verdict-matrix rejection: the fixture reaches the ladder, which
		// throws the reviewer-settlement error.
		expect(message).toMatch(/BLOCKED: PR_REVIEW/);
		expect(message).toContain(
			'reviewer items lack an authenticated verdict from any successful lane',
		);
		expect(message).not.toMatch(/allows report_verdict/);

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
