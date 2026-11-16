import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	activatePrWorkflow,
	completePrWorkflow,
	enforcePrReviewBaseDimensions,
	_test_exports as gateInternals,
	markPrReviewTriggerEvaluationComplete,
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_REQUIRED_MICRO_LANE_IDS,
	readPrWorkflowGateState,
	recordPrReviewValidationBatch,
} from '../../../src/hooks/pr-workflow-gate.js';
import { executeWritePrReviewArtifact } from '../../../src/tools/write-pr-review-artifact.js';
import {
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_REVISION_DIGEST,
	PR_ARTIFACT_SESSION_ID,
	persistPrReviewBatch,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { LEGACY_PR_REVIEW_RESILIENCE_POLICY } from '../pr-review-test-policy.js';

// Issue #3312 AC3: the honest INCOMPLETE bypass never admits REQUEST_CHANGES.
// A PARTIAL-settlement run with every lane terminal, the workflow bound to the
// PR head, an admitted partial-base disclosure, and a recorded-but-unsettled
// reviewer batch must STILL be refused for report_verdict REQUEST_CHANGES by
// the terminal-ready ladder's reviewer-settlement assertion, with the gate
// state kept and no validation-skip-disclosure.json written.
// GREEN at base (the ladder refuses) and GREEN after the fix (REQUEST_CHANGES
// keeps routing through the existing ladder; only INCOMPLETE takes the bypass).

const SESSION_ID = PR_ARTIFACT_SESSION_ID;
const HEAD_SHA = PR_ARTIFACT_HEAD_SHA;
const RUN_ID = 'ac3-partial-run';
let directory = '';

const ORIGINALS = {
	head: gateInternals.resolveCurrentGitHead,
	headAsync: gateInternals.resolveCurrentGitHeadAsync,
	revision: gateInternals.resolvePrWorkflowRevisionDigest,
	clean: gateInternals.resolveIsWorkingTreeClean,
	cleanAsync: gateInternals.resolveIsWorkingTreeCleanAsync,
};

beforeEach(async () => {
	directory = canonicalMkdtemp('pr-incomplete-bypass-ac3-');
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
 * PARTIAL-settlement fixture (issue #2383 N-of-6 shape): five clean base
 * dimensions, one operator_cancelled terminal failure, admitted partial-base
 * disclosure, CLEAN micro lanes, and a marked trigger evaluation. Returns the
 * covered candidate inventory (C-0..C-4).
 */
async function establishPartialBase(): Promise<string[]> {
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
	const records = successful.map((_dimension, index) => ({
		finding_id: `C-${index}`,
		status: 'PENDING',
		file_line: 'file.ts:1',
		evidence: `authoritative candidate ${index}`,
		next_action: 'route_to_reviewer',
		severity: 'HIGH',
	}));
	const disclosureWrite = await executeWritePrReviewArtifact(
		{
			kind: 'findings',
			run_id: RUN_ID,
			pr_head_sha: HEAD_SHA,
			boundary: 'post_explorer',
			records,
			partial_base_coverage: { unresolved_dimensions: [...failed] },
		},
		directory,
		{ sessionID: SESSION_ID },
	);
	expect(disclosureWrite).toContain('"success": true');
	const MICRO_HEADER =
		'[CANDIDATE] | candidate_id | micro_lane | severity | category | file:line | claim | invariant_violated | evidence_summary | confidence | risk_impact | risk_tags';
	const triggerRows: Array<Record<string, string>> = [];
	for (const [
		index,
		workflowLane,
	] of PR_REVIEW_REQUIRED_MICRO_LANE_IDS.entries()) {
		const batchId = `micro-${index}`;
		const laneId = `micro-lane-${index}`;
		await persistPrReviewBatch(
			directory,
			batchId,
			'swarm-pr-review:micro',
			[{ laneId, workflowLane }],
			{
				textOverride: `${MICRO_HEADER}\n[CLEAN] | ${workflowLane} | exact reviewed diff | no finding after focused invariant review`,
			},
		);
		triggerRows.push({
			trigger_id: workflowLane,
			result: 'MATCHED',
			evidence: `fixture evidence for ${workflowLane}`,
			source_batch_id: batchId,
			source_lane_id: laneId,
		});
	}
	const triggerRelative = path.join('pr-review', RUN_ID, 'trigger-eval.json');
	const triggerAbsolute = path.join(directory, '.swarm', triggerRelative);
	await fs.mkdir(path.dirname(triggerAbsolute), { recursive: true });
	await fs.writeFile(
		triggerAbsolute,
		JSON.stringify({ rows: triggerRows }),
		'utf-8',
	);
	await markPrReviewTriggerEvaluationComplete(
		directory,
		SESSION_ID,
		RUN_ID,
		triggerRelative,
	);
	return records.map((record) => record.finding_id);
}

/** Declare a reviewer batch that owns every candidate but never settles. */
async function recordUnsettledReviewerBatch(itemIds: readonly string[]) {
	await recordPrReviewValidationBatch(
		directory,
		SESSION_ID,
		'reviewer',
		[
			{
				laneId: `${RUN_ID}-rv`,
				workflowLane: `${RUN_ID}-rv`,
				reviewItemIds: [...itemIds],
			},
		],
		{ batchId: `${RUN_ID}-rv`, prHeadSha: HEAD_SHA },
	);
}

/** True when any validation-skip-disclosure.json exists under .swarm. */
async function anySkipDisclosureOnDisk(): Promise<boolean> {
	const prReviewRoot = path.join(directory, '.swarm', 'pr-review');
	async function walk(dir: string): Promise<boolean> {
		let entries: Array<{ name: string; isFile: () => boolean }> = [];
		try {
			entries = (await fs.readdir(dir, { withFileTypes: true })) as Array<{
				name: string;
				isFile: () => boolean;
			}>;
		} catch {
			return false;
		}
		for (const entry of entries) {
			const entryPath = path.join(dir, entry.name);
			if (entry.isFile()) {
				if (entry.name === 'validation-skip-disclosure.json') return true;
			} else if (await walk(entryPath)) {
				return true;
			}
		}
		return false;
	}
	return walk(prReviewRoot);
}

describe('issue #3312 AC3 — the bypass never admits REQUEST_CHANGES', () => {
	test('unsettled reviewer phase + REQUEST_CHANGES is refused by the ladder, state kept, no disclosure', async () => {
		const itemIds = await establishPartialBase();
		await recordUnsettledReviewerBatch(itemIds);

		let message = '';
		try {
			await completePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', HEAD_SHA, {
				reportVerdict: 'REQUEST_CHANGES',
			});
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		// The ladder's reviewer-settlement refusal fires — REQUEST_CHANGES is
		// verdict-permitted for PARTIAL coverage, so the refusal cannot be a
		// verdict-matrix rejection: it is the unsettled reviewer phase.
		expect(message).toMatch(/BLOCKED: PR_REVIEW/);
		expect(message).toContain(
			'reviewer items lack an authenticated verdict from any successful lane',
		);

		// The refusal kept the gate state and wrote no skip disclosure.
		expect(await readPrWorkflowGateState(directory, SESSION_ID)).not.toBeNull();
		expect(await anySkipDisclosureOnDisk()).toBe(false);
	});
});
