import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { storeLaneOutput } from '../../../src/background/lane-output-store';
import {
	appendDelegationTransition,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import { PR_REVIEW_TRIGGER_DEFINITIONS } from '../../../src/background/pr-review-trigger-contract.js';
import {
	activatePrWorkflow,
	enforcePrReviewBaseDimensions,
	_test_exports as gateInternals,
	markPrReviewTriggerEvaluationComplete,
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_REQUIRED_MICRO_LANE_IDS,
	recordPrReviewValidationBatch,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	HEAD_SHA,
	persistBatch,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from './pr-workflow-gate.test-fixtures.js';

// End-to-end guard for the recorded-degradation path: a micro lane that ended
// degraded after retries was accepted by write_pr_review_trigger_eval with a
// coverage_degradations entry on the receipt. The reviewer/critic inventory
// (derivePrReviewCandidateInventory) must skip that family instead of
// re-creating the trigger-eval dead-end — while a family with NO record and NO
// degradation entry still blocks.

beforeEach(setupPrWorkflowGateFixtures);
afterEach(teardownPrWorkflowGateFixtures);

const BASE_CANDIDATE_IDS = PR_REVIEW_BASE_DIMENSION_IDS.map(
	(_lane, index) => `C-${index}`,
);

async function recordDegradedMicroLane(family: string): Promise<void> {
	const batchId = `micro-${family}`;
	const laneId = `micro-lane-${family}`;
	const correlationId = `${batchId}--${laneId}`;
	const text =
		'the lane produced no usable protocol rows before exhausting retries';
	await recordPendingDelegation(tempDir, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: SESSION_ID,
		callID: `call-${correlationId}`,
		normalizedAgent: 'explorer',
		swarmPrefixedAgent: 'explorer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId,
		laneId,
		mode: 'swarm-pr-review:micro',
		workflowLane: family,
		workspace: {
			directory: tempDir,
			gitHead: HEAD_SHA,
			dirtyHash: null,
			prHeadSha: HEAD_SHA,
			scope: `complete PR diff def456...${HEAD_SHA}`,
		},
	});
	const stored = storeLaneOutput(tempDir, {
		batchId,
		laneId,
		agent: 'explorer',
		role: 'explorer',
		sessionId: correlationId,
		parentSessionId: SESSION_ID,
		mode: 'swarm-pr-review:micro',
		workflowLane: family,
		prHeadSha: HEAD_SHA,
		gitHead: HEAD_SHA,
		revisionDigest: gateInternals.resolvePrWorkflowRevisionDigest(
			tempDir,
			HEAD_SHA,
		),
		scope: `complete PR diff def456...${HEAD_SHA}`,
		source: 'collect_lane_results',
		text,
	});
	await appendDelegationTransition(tempDir, correlationId, {
		status: 'error',
		result: {
			text,
			chars: stored.chars,
			truncated: false,
			digest: stored.digest,
			outputRef: stored.ref,
		},
	});
}

/** Writes a full v2 trigger receipt; `degradedFamilies` get coverage_degradations
 * entries citing their (batch, lane) tuple. The receipt is hand-constructed to
 * isolate the INVENTORY consumer: the trigger-eval provenance gate that would
 * normally produce these degradations is exercised separately in
 * tests/unit/tools/write-pr-review-trigger-eval-degraded.test.ts. */
async function writeTriggerReceipt(degradedFamilies: string[]): Promise<void> {
	const rows = PR_REVIEW_TRIGGER_DEFINITIONS.map((definition) => {
		const batchId = `micro-${definition.id}`;
		const laneId = `micro-lane-${definition.id}`;
		return {
			trigger_id: definition.id,
			scope: definition.scope,
			trigger_row: definition.trigger_row,
			micro_lane: definition.micro_lane,
			result: 'MATCHED' as const,
			evidence: `fixture evidence for ${definition.id}`,
			source_batch_id: batchId,
			source_lane_id: laneId,
		};
	});
	const coverage_degradations = degradedFamilies.map((family) => ({
		trigger_id: family,
		source_batch_id: `micro-${family}`,
		source_lane_id: `micro-lane-${family}`,
		reason: 'no covered candidate or clean row for the family',
	}));
	const triggerRelative = path.join(
		'pr-review',
		'test-run',
		'trigger-eval.json',
	);
	const triggerAbsolute = path.join(tempDir, '.swarm', triggerRelative);
	await fs.mkdir(path.dirname(triggerAbsolute), { recursive: true });
	await fs.writeFile(
		triggerAbsolute,
		JSON.stringify({
			schema_version: 2,
			run_id: 'test-run',
			pr_head_sha: HEAD_SHA,
			base_ref: 'origin/main',
			base_sha: 'def456',
			evaluated_at: '2026-08-14T00:00:00.000Z',
			dispatched_micro_lane_count: PR_REVIEW_TRIGGER_DEFINITIONS.length,
			trigger_count: rows.length,
			matched_count: rows.length,
			not_triggered_count: 0,
			no_match_count: 0,
			rows,
			coverage_degradations,
		}),
		'utf-8',
	);
	await markPrReviewTriggerEvaluationComplete(
		tempDir,
		SESSION_ID,
		'test-run',
		triggerRelative,
	);
}

async function establishBaseAndMicroLanes(
	degradedFamily?: string,
): Promise<void> {
	await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
	const baseLanes = PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) => ({
		laneId: workflowLane,
		workflowLane,
	}));
	await enforcePrReviewBaseDimensions(tempDir, SESSION_ID, baseLanes, {
		batchId: 'base-all',
		prHeadSha: HEAD_SHA,
	});
	await persistBatch('base-all', 'swarm-pr-review:base', baseLanes);
	for (const family of PR_REVIEW_REQUIRED_MICRO_LANE_IDS) {
		if (family === degradedFamily) {
			await recordDegradedMicroLane(family);
			continue;
		}
		await persistBatch(
			`micro-${family}`,
			'swarm-pr-review:micro',
			[{ laneId: `micro-lane-${family}`, workflowLane: family }],
			{
				textOverride: `[CANDIDATE] | candidate_id | micro_lane | severity | category | file:line | claim | invariant_violated | evidence_summary | confidence\n[CLEAN] | ${family} | exact reviewed diff | no finding after focused invariant review`,
			},
		);
	}
}

describe('degraded micro lane does not block the reviewer inventory', () => {
	test('reviewer dispatch proceeds when the receipt discloses the degradation', async () => {
		const degradedFamily = PR_REVIEW_REQUIRED_MICRO_LANE_IDS[0];
		await establishBaseAndMicroLanes(degradedFamily);
		await writeTriggerReceipt([degradedFamily]);
		await expect(
			recordPrReviewValidationBatch(
				tempDir,
				SESSION_ID,
				'reviewer',
				[
					{
						laneId: 'review-all',
						workflowLane: 'review-all',
						reviewItemIds: BASE_CANDIDATE_IDS,
					},
				],
				{ batchId: 'review-all', prHeadSha: HEAD_SHA },
			),
		).resolves.toBeDefined();
	});

	test('a missing micro lane with NO degradation entry still blocks', async () => {
		// Same shape, but the receipt does not disclose the degraded family: the
		// hard provenance requirement must still fail closed.
		const degradedFamily = PR_REVIEW_REQUIRED_MICRO_LANE_IDS[0];
		await establishBaseAndMicroLanes(degradedFamily);
		await writeTriggerReceipt([]);
		await expect(
			recordPrReviewValidationBatch(
				tempDir,
				SESSION_ID,
				'reviewer',
				[
					{
						laneId: 'review-all',
						workflowLane: 'review-all',
						reviewItemIds: BASE_CANDIDATE_IDS,
					},
				],
				{ batchId: 'review-all', prHeadSha: HEAD_SHA },
			),
		).rejects.toThrow('mandatory micro-lane provenance');
	});
});
