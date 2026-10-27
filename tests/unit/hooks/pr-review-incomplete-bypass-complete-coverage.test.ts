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
import { readPrReviewTerminalCoverageForReport as readTerminalCoverageFromCompletion } from '../../../src/pr-review/completion.js';
import {
	establishPrReviewPrerequisites,
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_REVISION_DIGEST,
	PR_ARTIFACT_SESSION_ID,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

// Issue #3312 AC8: a COMPLETE-settlement run (all six base dimensions covered)
// with a recorded-but-unsettled reviewer batch must complete with
// report_verdict INCOMPLETE through the bypass, persisting a skip disclosure
// with coverageKind 'COMPLETE' — and for COMPLETE coverage that skip
// disclosure counts as a disclosed coverage degradation, so the terminal
// coverage report projection must EXCLUDE 'APPROVE' from allowedVerdicts for
// this run once the disclosure is persisted (observed in the pre-clear window,
// the last moment the gate state still exists).
// RED at base: the completion routes through the terminal-ready ladder and
// throws the reviewer-settlement BLOCKED error ("BLOCKED: PR_REVIEW reviewer
// items lack an authenticated verdict ... C-5 ..."). GREEN after the fix.

const SESSION_ID = PR_ARTIFACT_SESSION_ID;
const HEAD_SHA = PR_ARTIFACT_HEAD_SHA;
const RUN_ID = 'ac8-complete-run';
let directory = '';

const ORIGINALS = {
	head: gateInternals.resolveCurrentGitHead,
	headAsync: gateInternals.resolveCurrentGitHeadAsync,
	revision: gateInternals.resolvePrWorkflowRevisionDigest,
	clean: gateInternals.resolveIsWorkingTreeClean,
	cleanAsync: gateInternals.resolveIsWorkingTreeCleanAsync,
};

beforeEach(async () => {
	directory = canonicalMkdtemp('pr-incomplete-bypass-ac8-');
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

type TerminalCoverageReport = {
	kind?: string;
	allowedVerdicts?: readonly string[];
} | null;

describe('issue #3312 AC8 — COMPLETE-coverage bypass marks the run degraded', () => {
	test('COMPLETE settlement + unsettled reviewer + INCOMPLETE completes with a COMPLETE skip disclosure and APPROVE excluded', async () => {
		// Full coverage fixture: six base candidates (C-0..C-5), all micro lanes
		// settled CLEAN, trigger evaluation marked complete.
		await establishPrReviewPrerequisites(directory, RUN_ID);
		await recordUnsettledReviewerBatch();

		// Observed in the pre-terminal-clear window — after the skip disclosure
		// is persisted but while the gate state (and the run) still exist, which
		// is exactly the state the completion-report projection reads.
		let projectionAtClear: TerminalCoverageReport = null;
		gateInternals.beforeTerminalClear = async () => {
			projectionAtClear = (await readTerminalCoverageFromCompletion(
				directory,
				SESSION_ID,
			)) as TerminalCoverageReport;
		};
		try {
			const status = await completePrWorkflow(
				directory,
				SESSION_ID,
				'PR_REVIEW',
				HEAD_SHA,
				{ reportVerdict: 'INCOMPLETE' },
			);
			expect(status).toBe('completed');
		} finally {
			gateInternals.beforeTerminalClear = undefined;
		}

		// The completion is terminal: the gate state is cleared.
		expect(await readPrWorkflowGateState(directory, SESSION_ID)).toBeNull();

		// The durable skip disclosure records the COMPLETE coverage kind and the
		// skipped reviewer phase over the full unsettled inventory.
		const disclosurePath = path.join(
			directory,
			'.swarm',
			'pr-review',
			RUN_ID,
			'validation-skip-disclosure.json',
		);
		const disclosure = JSON.parse(
			await fs.readFile(disclosurePath, 'utf-8'),
		) as {
			schemaVersion?: number;
			coverageKind?: string;
			reportVerdict?: string;
			skippedPhases?: Array<{
				phase?: string;
				unsettledItemIds?: string[];
			}>;
		};
		expect(disclosure.schemaVersion).toBe(1);
		expect(disclosure.coverageKind).toBe('COMPLETE');
		expect(disclosure.reportVerdict).toBe('INCOMPLETE');
		const reviewerSkip = (disclosure.skippedPhases ?? []).find(
			(entry) => entry.phase === 'reviewer',
		);
		expect([...(reviewerSkip?.unsettledItemIds ?? [])].sort()).toEqual([
			'C-0',
			'C-1',
			'C-2',
			'C-3',
			'C-4',
			'C-5',
		]);

		// The disclosed skip degrades the run: the terminal coverage projection
		// (read while the disclosure is persisted and the gate still stands)
		// never permits APPROVE for this run.
		expect(projectionAtClear).not.toBeNull();
		expect(projectionAtClear?.kind).toBe('COMPLETE');
		expect([...(projectionAtClear?.allowedVerdicts ?? [])]).not.toContain(
			'APPROVE',
		);
		expect([...(projectionAtClear?.allowedVerdicts ?? [])]).toContain(
			'INCOMPLETE',
		);
	});
});
