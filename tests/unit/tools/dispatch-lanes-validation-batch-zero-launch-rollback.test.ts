/**
 * AC18 (validation-batch zero-launch rollback): when a reviewer/critic
 * dispatch records its validation batch but EVERY lane then fails to launch
 * (rejected or session.create fails — zero lanes launched), the recorded
 * validation batch must be rolled back (absent from gate state) or never
 * persisted — otherwise the gate permanently owes verdicts for a batch whose
 * lanes never ran.
 *
 * Contract for both ends: RED at base, GREEN after the fix. At base the
 * reviewer validation batch is recorded before lane launch and there is no
 * reviewer/critic rollback (the base-mode rollback covers only
 * `swarm-pr-review:base`), so the batch persists in gate state after a
 * zero-launch dispatch; after the fix it is rolled back or never persisted.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { storeLaneOutput } from '../../../src/background/lane-output-store.js';
import {
	appendDelegationTransition,
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

const SESSION_ID = 'zero-launch-ac18';
const HEAD_SHA = 'abc123';
const BASE_SHA = 'def456';
const BASE_REF = 'origin/main';
const REVISION_DIGEST = 'zero-launch-revision';
const REVIEW_SCOPE = `complete PR diff ${BASE_SHA}...${HEAD_SHA}`;
const ZERO_BATCH_ID = 'zero-launch-reviewer-batch';

const originalInternals = { ...dispatchInternals };
const originalGateInternals = { ...gateInternals };
const originalSwarmAgentNames = swarmState.generatedAgentNames;
let directory = '';

beforeEach(() => {
	directory = canonicalMkdtemp('dispatch-zero-launch-');
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
	// The agent IS registered, so the dispatch phase gate and validateLaneAgent
	// both accept it — every lane fails LATER, at session.create.
	dispatchInternals.getGeneratedAgentNames = () => ['reviewer'];
	swarmState.generatedAgentNames = ['reviewer'];
	const sessionOps: SessionOps = {
		// Permanent create rejection: the host never yields a session id, so no
		// lane can launch and no delegation record can be written.
		create: mock(async () => ({
			data: undefined,
			error: {
				message: 'session create rejected (AC18 zero-launch fixture)',
				isRetryable: false,
			},
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

describe('dispatch_lanes_async — reviewer validation batch zero-launch rollback (AC18)', () => {
	test('a reviewer dispatch where every lane fails to create a session leaves no validation batch in gate state', async () => {
		await establishReviewPrerequisites();

		const dispatch = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:reviewer',
				pr_head_sha: HEAD_SHA,
				base_sha: BASE_SHA,
				base_ref: BASE_REF,
				batch_id: ZERO_BATCH_ID,
				lanes: [
					{
						id: 'zero-launch-lane-a',
						agent: 'reviewer',
						prompt: 'Classify the assigned candidates (lane A).',
						workflow_lane: 'zero-launch-lane-a',
						review_item_ids: ['C-0', 'C-1'],
					},
					{
						id: 'zero-launch-lane-b',
						agent: 'reviewer',
						prompt: 'Classify the assigned candidates (lane B).',
						workflow_lane: 'zero-launch-lane-b',
						review_item_ids: ['C-2', 'C-3'],
					},
				],
			},
			directory,
			{ sessionID: SESSION_ID },
		);

		// Harness proof (green at base): the dispatch itself reports failure with
		// zero pending lanes — every lane failed at session.create.
		expect(dispatch.success).toBe(false);
		expect(dispatch.pending).toBe(0);
		expect(dispatch.failed + dispatch.rejected).toBe(2);

		// DISCRIMINATING assertion (red at base): with zero lanes launched there
		// is no lane that can ever produce the owed verdicts, so the recorded
		// validation batch must be rolled back (absent from gate state) or never
		// persisted. At base the batch persists — the reviewer/critic phases have
		// no zero-launch rollback (only swarm-pr-review:base does).
		const state = await readPrWorkflowGateState(directory, SESSION_ID);
		const zeroBatch = (state?.prReviewValidationBatches ?? []).find(
			(batch) => batch.batchId === ZERO_BATCH_ID,
		);
		expect(zeroBatch).toBeUndefined();
	});
});
