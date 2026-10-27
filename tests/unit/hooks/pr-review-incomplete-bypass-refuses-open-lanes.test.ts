import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	activatePrWorkflow,
	completePrWorkflow,
	_test_exports as gateInternals,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_REVISION_DIGEST,
	PR_ARTIFACT_SESSION_ID,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { recordOpenPrWorkflowLane } from '../../helpers/pr-workflow-lane-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

// Issue #3312 AC6: the honest INCOMPLETE bypass requires every PR workflow
// lane to be settled first. A completion attempt with one delegation-store
// lane record still pending (fresh, not presumed stale) is refused with the
// unsettled-lane BLOCKED error before any PR-review settlement reasoning runs,
// and the gate state is kept.
// GREEN at base (the open-lane check precedes the completion branch) and GREEN
// after the fix (the bypass arms only when all lanes are settled).

const SESSION_ID = PR_ARTIFACT_SESSION_ID;
const HEAD_SHA = PR_ARTIFACT_HEAD_SHA;
let directory = '';

const ORIGINALS = {
	head: gateInternals.resolveCurrentGitHead,
	headAsync: gateInternals.resolveCurrentGitHeadAsync,
	revision: gateInternals.resolvePrWorkflowRevisionDigest,
	clean: gateInternals.resolveIsWorkingTreeClean,
	cleanAsync: gateInternals.resolveIsWorkingTreeCleanAsync,
};

beforeEach(async () => {
	directory = canonicalMkdtemp('pr-incomplete-bypass-ac6-');
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

describe('issue #3312 AC6 — the bypass refuses completion while a lane is open', () => {
	test('one fresh pending PR workflow lane blocks INCOMPLETE completion with the unsettled-lane error', async () => {
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		// A just-recorded lane is fresh by construction (nowhere near the
		// presumed-stale horizon), so it counts as open, not settled.
		await recordOpenPrWorkflowLane(
			directory,
			SESSION_ID,
			'intent-architecture',
			'ac6-open-lane',
		);

		let message = '';
		try {
			await completePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', HEAD_SHA, {
				reportVerdict: 'INCOMPLETE',
			});
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toMatch(/BLOCKED: PR_REVIEW/);
		expect(message).toContain('unsettled PR workflow lane');

		// The refusal kept the gate state.
		expect(await readPrWorkflowGateState(directory, SESSION_ID)).not.toBeNull();
	});
});
