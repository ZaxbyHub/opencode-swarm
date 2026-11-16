/**
 * AC17 (validation-batch ghost owner): dispatching a reviewer-phase lane whose
 * agent name passes the phase role gate (bare `reviewer` resolves to the
 * canonical reviewer role) but FAILS validateLaneAgent's host-registration
 * check (#2614: a host whose generated names are prefixed only, e.g.
 * ['local_reviewer']) must reject BEFORE any PR-review validation batch is
 * recorded in gate state — otherwise the gate permanently owes verdicts for a
 * lane that never existed (a ghost owner).
 *
 * Contract for both ends: RED at base, GREEN after the fix. At base the
 * dispatch records the reviewer validation batch first and only then rejects
 * the lane at launch, so the batch is present in
 * `prReviewValidationBatches`; after the fix the dispatch rejects before the
 * batch is recorded and the gate state contains no entry for the batch.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { storeLaneOutput } from '../../../src/background/lane-output-store.js';
import {
	appendDelegationTransition,
	readDelegations,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	activatePrWorkflow,
	bindPrReviewBase,
	enforcePrReviewBaseDimensions,
	_test_exports as gateInternals,
	markPrReviewTriggerEvaluationComplete,
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_REQUIRED_MICRO_LANE_IDS,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import { swarmState } from '../../../src/state.js';
import {
	_internals as dispatchInternals,
	executeDispatchLanesAsync,
	type SessionOps,
} from '../../../src/tools/dispatch-lanes.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { LEGACY_PR_REVIEW_RESILIENCE_POLICY } from '../pr-review-test-policy.js';

const SESSION_ID = 'ghost-owner-ac17';
const HEAD_SHA = 'abc123';
const BASE_SHA = 'def456';
const BASE_REF = 'origin/main';
const REVISION_DIGEST = 'ghost-owner-revision';
const REVIEW_SCOPE = `complete PR diff ${BASE_SHA}...${HEAD_SHA}`;
const GHOST_BATCH_ID = 'ghost-reviewer-batch';

const originalInternals = { ...dispatchInternals };
const originalGateInternals = { ...gateInternals };
const originalSwarmAgentNames = swarmState.generatedAgentNames;
let directory = '';

beforeEach(() => {
	directory = canonicalMkdtemp('dispatch-ghost-owner-');
	mkdirSync(path.join(directory, '.git'), { recursive: true });
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => HEAD_SHA;
	gateInternals.resolveCurrentGitHeadAsync = async () => HEAD_SHA;
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolveIsWorkingTreeCleanAsync = async () => true;
	gateInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync = async () =>
		REVISION_DIGEST;
	dispatchInternals.resolveExactMergeBaseAsync = async () => BASE_SHA;
	// #2614 host shape: ONLY prefixed generated agents are registered. The bare
	// canonical name `reviewer` still resolves to the reviewer role (exact
	// canonical match wins in resolveGeneratedAgentRole), so the dispatch phase
	// gate accepts it — but the host cannot actually launch it.
	dispatchInternals.getGeneratedAgentNames = () => ['local_reviewer'];
	swarmState.generatedAgentNames = ['local_reviewer'];
	const sessionOps: SessionOps = {
		create: mock(async () => ({
			data: { id: 'ghost-child-session' },
			error: undefined,
		})),
		prompt: mock(async () => ({ data: undefined, error: undefined })),
		promptAsync: mock(async () => ({ data: undefined, error: undefined })),
		status: mock(async () => ({ data: {}, error: undefined })),
		messages: mock(async () => ({ data: [], error: undefined })),
		delete: mock(async () => undefined),
	};
	dispatchInternals.getSessionOps = () => sessionOps;
});

afterEach(async () => {
	Object.assign(dispatchInternals, originalInternals);
	Object.assign(gateInternals, originalGateInternals);
	swarmState.generatedAgentNames = originalSwarmAgentNames;
	gateInternals.resetTrackedStateCache();
	closeAllProjectDbs();
	for (let attempt = 0; ; attempt++) {
		try {
			await fsp.rm(directory, { recursive: true, force: true });
			break;
		} catch (error) {
			if (attempt >= 4 || (error as NodeJS.ErrnoException).code !== 'EBUSY')
				throw error;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
});

/** Record + artifact + completed transition for one settled discovery lane. */
async function recordSettledDiscoveryLane(args: {
	correlationId: string;
	callID: string;
	batchId: string;
	laneId: string;
	mode: 'swarm-pr-review:base' | 'swarm-pr-review:micro';
	workflowLane: string;
	text: string;
}): Promise<void> {
	await recordPendingDelegation(directory, {
		correlationId: args.correlationId,
		jobId: null,
		subagentSessionId: args.correlationId,
		parentSessionId: SESSION_ID,
		callID: args.callID,
		normalizedAgent: 'explorer',
		swarmPrefixedAgent: 'explorer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: args.batchId,
		laneId: args.laneId,
		mode: args.mode,
		workflowLane: args.workflowLane,
		prReviewLegacyTranscriptCompatibility: true,
		workspace: {
			directory,
			gitHead: HEAD_SHA,
			dirtyHash: null,
			prHeadSha: HEAD_SHA,
			scope: REVIEW_SCOPE,
		},
	});
	const stored = storeLaneOutput(directory, {
		batchId: args.batchId,
		laneId: args.laneId,
		agent: 'explorer',
		role: 'explorer',
		sessionId: args.correlationId,
		parentSessionId: SESSION_ID,
		mode: args.mode,
		workflowLane: args.workflowLane,
		prHeadSha: HEAD_SHA,
		gitHead: HEAD_SHA,
		revisionDigest: REVISION_DIGEST,
		scope: REVIEW_SCOPE,
		source: 'collect_lane_results',
		text: args.text,
	});
	await appendDelegationTransition(directory, args.correlationId, {
		status: 'completed',
		result: {
			text: args.text,
			chars: stored.chars,
			truncated: false,
			digest: stored.digest,
			outputRef: stored.ref,
		},
	});
}

/** Same prerequisite chain as the counterbalance/council mechanical suites. */
async function establishReviewPrerequisites(): Promise<void> {
	await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');
	await bindPrReviewBase(directory, SESSION_ID, {
		prHeadSha: HEAD_SHA,
		baseRef: BASE_REF,
		baseSha: BASE_SHA,
	});
	const baseLanes = PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) => ({
		laneId: workflowLane,
		workflowLane,
	}));
	await enforcePrReviewBaseDimensions(directory, SESSION_ID, baseLanes, {
		batchId: 'base-all',
		prHeadSha: HEAD_SHA,
		prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
	});
	const baseHeader =
		'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence | risk_impact | risk_tags';
	for (const [index, lane] of baseLanes.entries()) {
		await recordSettledDiscoveryLane({
			correlationId: `base-${index}`,
			callID: `call-${index}`,
			batchId: 'base-all',
			laneId: lane.laneId,
			mode: 'swarm-pr-review:base',
			workflowLane: lane.workflowLane,
			text: `${baseHeader}\nC-${index} | ${lane.workflowLane} | LOW | correctness | file.ts:1 | claim | evidence | impact | LOW | ORDINARY | `,
		});
	}
	const microHeader =
		'[CANDIDATE] | candidate_id | micro_lane | severity | category | file:line | claim | invariant_violated | evidence_summary | confidence | risk_impact | risk_tags';
	const triggerRows: Array<Record<string, string>> = [];
	for (const [
		index,
		workflowLane,
	] of PR_REVIEW_REQUIRED_MICRO_LANE_IDS.entries()) {
		const batchId = `micro-${index}`;
		const laneId = `micro-lane-${index}`;
		await recordSettledDiscoveryLane({
			correlationId: `micro-session-${index}`,
			callID: batchId,
			batchId,
			laneId,
			mode: 'swarm-pr-review:micro',
			workflowLane,
			text: `${microHeader}\n[CLEAN] | ${workflowLane} | exact reviewed diff | no finding after focused invariant review`,
		});
		triggerRows.push({
			trigger_id: workflowLane,
			result: 'MATCHED',
			evidence: `Fixture evidence for ${workflowLane}`,
			source_batch_id: batchId,
			source_lane_id: laneId,
		});
	}
	const triggerRelative = path.join('pr-review', 'run', 'trigger-eval.json');
	const triggerAbsolute = path.join(directory, '.swarm', triggerRelative);
	await fsp.mkdir(path.dirname(triggerAbsolute), { recursive: true });
	await fsp.writeFile(
		triggerAbsolute,
		JSON.stringify({ rows: triggerRows }),
		'utf-8',
	);
	await markPrReviewTriggerEvaluationComplete(
		directory,
		SESSION_ID,
		'run',
		triggerRelative,
	);
}

describe('dispatch_lanes_async — reviewer validation batch ghost owner (AC17)', () => {
	test('a reviewer lane whose agent is unregistered on the host rejects before any validation batch is recorded', async () => {
		await establishReviewPrerequisites();

		const dispatch = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:reviewer',
				pr_head_sha: HEAD_SHA,
				base_sha: BASE_SHA,
				base_ref: BASE_REF,
				batch_id: GHOST_BATCH_ID,
				lanes: [
					{
						id: 'ghost-reviewer-lane',
						agent: 'reviewer',
						prompt: 'Classify the assigned candidate.',
						workflow_lane: 'ghost-reviewer-lane',
						review_item_ids: ['C-0'],
					},
				],
			},
			directory,
			{ sessionID: SESSION_ID },
		);

		// The dispatch fails on both sides of the fix (at base the lane is
		// rejected at launch with the #2614 not-registered diagnostic; after the
		// fix the whole dispatch refuses earlier). Nothing may launch either way.
		expect(dispatch.success).toBe(false);
		expect(dispatch.pending).toBe(0);
		expect(
			readDelegations(directory).filter(
				(record) => record.batchId === GHOST_BATCH_ID,
			),
		).toHaveLength(0);

		// DISCRIMINATING assertion (red at base): the gate state must contain NO
		// reviewer validation batch for this dispatch — a recorded batch would
		// permanently owe verdicts for a lane that never existed. At base the
		// batch IS recorded before launchAsyncLane rejects the agent.
		const state = await readPrWorkflowGateState(directory, SESSION_ID);
		const ghostBatch = (state?.prReviewValidationBatches ?? []).find(
			(batch) => batch.batchId === GHOST_BATCH_ID,
		);
		expect(ghostBatch).toBeUndefined();
	});

	test('a MIXED dispatch (one launchable lane + one unregistered agent) records no validation batch — the precondition, not the zero-launch rollback', async () => {
		await establishReviewPrerequisites();

		const dispatch = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:reviewer',
				pr_head_sha: HEAD_SHA,
				base_sha: BASE_SHA,
				base_ref: BASE_REF,
				batch_id: 'ghost-reviewer-batch-mixed',
				lanes: [
					{
						id: 'mixed-registered-lane',
						agent: 'local_reviewer',
						prompt: 'Classify the assigned candidate.',
						workflow_lane: 'mixed-registered-lane',
						review_item_ids: ['C-0'],
					},
					{
						id: 'mixed-ghost-lane',
						agent: 'reviewer',
						prompt: 'Classify the assigned candidate.',
						workflow_lane: 'mixed-ghost-lane',
						review_item_ids: ['C-1'],
					},
				],
			},
			directory,
			{ sessionID: SESSION_ID },
		);

		// The registered lane WOULD launch (session.create succeeds in this
		// harness), so the zero-launch rollback cannot be what keeps the batch
		// out of gate state — only the pre-record validateLaneAgent
		// precondition covers the mixed case. Under its removal mutant this
		// dispatch records the batch (one lane pending), which this assertion
		// catches.
		expect(dispatch.success).toBe(false);
		expect(dispatch.pending).toBe(0);
		const state = await readPrWorkflowGateState(directory, SESSION_ID);
		const mixedBatch = (state?.prReviewValidationBatches ?? []).find(
			(batch) => batch.batchId === 'ghost-reviewer-batch-mixed',
		);
		expect(mixedBatch).toBeUndefined();
	});
});
