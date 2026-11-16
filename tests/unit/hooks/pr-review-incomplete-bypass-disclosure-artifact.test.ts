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

// Issue #3312 AC2: the honest INCOMPLETE bypass must PERSIST a durable skip
// disclosure before the terminal clear — a JSON record at
// .swarm/pr-review/<runId>/validation-skip-disclosure.json with schemaVersion 1,
// the run's prHeadSha/revisionDigest, coverageKind, reportVerdict 'INCOMPLETE',
// and the skipped phases naming their unsettled item ids — and the gate state
// must carry the disclosure path and digest up to the terminal clear, with a
// core pr_review_validation_skip_disclosed audit event appended.
// RED at base: the completion throws the reviewer-settlement BLOCKED error
// ("BLOCKED: PR_REVIEW reviewer items lack an authenticated verdict ...") and
// none of these artifacts exist. GREEN after the fix: the completion resolves,
// the disclosure file and audit event exist, and the pre-clear gate state
// carries prReviewValidationSkipDisclosurePath/prReviewValidationSkipDisclosureDigest.

const SESSION_ID = PR_ARTIFACT_SESSION_ID;
const HEAD_SHA = PR_ARTIFACT_HEAD_SHA;
const RUN_ID = 'ac2-partial-run';
let directory = '';

const ORIGINALS = {
	head: gateInternals.resolveCurrentGitHead,
	headAsync: gateInternals.resolveCurrentGitHeadAsync,
	revision: gateInternals.resolvePrWorkflowRevisionDigest,
	clean: gateInternals.resolveIsWorkingTreeClean,
	cleanAsync: gateInternals.resolveIsWorkingTreeCleanAsync,
};

beforeEach(async () => {
	directory = canonicalMkdtemp('pr-incomplete-bypass-ac2-');
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

type SkipDisclosureRecord = {
	schemaVersion?: number;
	runId?: string;
	prHeadSha?: string;
	revisionDigest?: string;
	createdAt?: string;
	coverageKind?: string;
	reportVerdict?: string;
	skippedPhases?: Array<{
		phase?: string;
		reason?: string;
		unsettledItemIds?: string[];
	}>;
};

describe('issue #3312 AC2 — bypass persists the durable validation-skip disclosure', () => {
	test('completion writes validation-skip-disclosure.json, gate-state fields, and the audit event', async () => {
		const itemIds = await establishPartialBase();
		await recordUnsettledReviewerBatch(itemIds);

		// The pre-clear hook is the one deterministic observation window for the
		// gate-state disclosure fields: the terminal clear deletes the state
		// after the hook returns, but the disclosure must already be on it.
		let stateAtClear: Awaited<ReturnType<typeof readPrWorkflowGateState>> =
			null;
		gateInternals.beforeTerminalClear = async () => {
			stateAtClear = await readPrWorkflowGateState(directory, SESSION_ID);
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

		// Durable skip-disclosure artifact at the contracted run-scoped path.
		const disclosurePath = path.join(
			directory,
			'.swarm',
			'pr-review',
			RUN_ID,
			'validation-skip-disclosure.json',
		);
		const raw = await fs.readFile(disclosurePath, 'utf-8');
		const disclosure = JSON.parse(raw) as SkipDisclosureRecord;
		expect(disclosure.schemaVersion).toBe(1);
		expect(disclosure.runId).toBe(RUN_ID);
		expect(disclosure.prHeadSha).toBe(HEAD_SHA);
		expect(disclosure.revisionDigest).toBe(PR_ARTIFACT_REVISION_DIGEST);
		expect(typeof disclosure.createdAt).toBe('string');
		expect(disclosure.coverageKind).toBe('PARTIAL');
		expect(disclosure.reportVerdict).toBe('INCOMPLETE');
		const reviewerSkip = (disclosure.skippedPhases ?? []).find(
			(entry) => entry.phase === 'reviewer',
		);
		expect(reviewerSkip).toBeDefined();
		expect([...(reviewerSkip?.unsettledItemIds ?? [])].sort()).toEqual(
			[...itemIds].sort(),
		);

		// The gate state carried the disclosure path and digest into the clear.
		expect(stateAtClear).not.toBeNull();
		const stateFields = stateAtClear as Record<string, unknown>;
		const disclosureStatePath =
			stateFields.prReviewValidationSkipDisclosurePath;
		expect(typeof disclosureStatePath).toBe('string');
		expect(String(disclosureStatePath)).toContain(
			'validation-skip-disclosure.json',
		);
		expect(String(disclosureStatePath)).toContain(RUN_ID);
		expect(String(stateFields.prReviewValidationSkipDisclosureDigest)).toMatch(
			/^[0-9a-f]{64}$/,
		);

		// The non-fatal audit event names the disclosed skip.
		const events = await fs.readFile(
			path.join(directory, '.swarm', 'events.jsonl'),
			'utf-8',
		);
		expect(events).toContain('"pr_review_validation_skip_disclosed"');
	});
});
