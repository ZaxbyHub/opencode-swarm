/**
 * Issue #3313 AC2 (trace C26, PRESERVING) — a 50-message window WITHOUT any
 * terminal assistant message (assistant text present, but the last assistant
 * message carries no terminal finish) still fails with transcript_incomplete.
 * The window cannot prove it holds the lane's last assistant turn, so the
 * incomplete flag stays honest. Green at the base tree AND after the fix
 * (which keys the count term on the window lacking its terminal assistant
 * message — this window lacks exactly that proof).
 */

/**
 * Issues #3312/#3313 acceptance checks — honest `transcript_incomplete`
 * settlement for verdict lanes whose fetch window is count-truncated.
 *
 * `extractAssistantTranscript` (src/tools/dispatch-lanes.ts) folds a COUNT-only
 * term into `transcriptIncomplete` (`messages.length >=
 * ASYNC_MESSAGE_FETCH_LIMIT (50)`), which is a "there MAY be unfetched earlier
 * messages" signal, not a "this lane is unfinished" signal. Verdict lanes
 * (swarm-pr-review:reviewer|critic) always run transport validation
 * (gate `analyzeLaneRecordResultIntegrity` with
 * `allowTranscriptIncompleteRecovery: false`), so the count-only term alone
 * fails a lane that actually holds its terminal assistant message.
 *
 * AC25 (discriminating): a reviewer lane whose fetched window holds exactly 50
 * messages AND whose LAST message is its terminal assistant message (finish
 * 'stop', no error) with valid [REVIEWED] rows settles COMPLETED through
 * collect and the collected result does NOT carry transcript_incomplete: true.
 * At the base tree this test FAILS at `expect(result.completed).toBe(1)`
 * (Expected: 1, Received: 0): the count-only term sets transcriptIncomplete,
 * transport validation fails on predicate `result.transcript_incomplete`, and
 * the lane settles status 'error' / failed: 1 with `transcript_incomplete:
 * true` and error 'PR_WORKFLOW_CONTRACT_INVALID: ... predicate=
 * result.transcript_incomplete expected="false outside discovery candidate
 * recovery" actual="true"' (typed class verdict_contract) — the documented
 * base signature.
 *
 * AC26 (preserving): a 50-message window WITHOUT any terminal assistant
 * message (assistant text present, but the last assistant message carries no
 * terminal finish) still fails with transcript_incomplete. The window cannot
 * prove it holds the lane's last assistant turn, so the incomplete flag stays
 * honest. Green at the base tree.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
	findByCorrelationId,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import { recordPrReviewValidationBatch } from '../../../src/hooks/pr-workflow-gate.js';
import {
	_internals,
	executeCollectLaneResults,
	type SessionOps,
} from '../../../src/tools/dispatch-lanes.js';
import {
	establishReviewPrerequisites,
	HEAD_SHA,
	PR_REVIEW_SCOPE,
	REVISION_DIGEST,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from '../hooks/pr-workflow-gate.test-fixtures.js';

const ITEM_IDS = ['C-0', 'C-1'] as const;
/** 49 user turns + 1 assistant turn = 50 total messages in the fetch window. */
const PADDING_TURNS = 49;
const originalInternals = { ..._internals };

function reviewed(
	id: string,
	classification: 'CONFIRMED' | 'DISPROVED' = 'CONFIRMED',
): string {
	const severity = classification === 'DISPROVED' ? 'NONE' : 'HIGH';
	return `[REVIEWED] | ${id} | ${classification} | STRUCTURALLY_PROVEN | ${severity} | YES | file.ts:1 | rationale ${id} | probe ${id} | reviewer`;
}

/** The lane's LAST assistant turn: finish 'stop', completed stamp, no error. */
function terminalAssistantMessage(text: string) {
	return {
		info: { role: 'assistant', time: { completed: 2 }, finish: 'stop' },
		parts: [{ type: 'text', text }],
	};
}

/**
 * An assistant turn with text but NO terminal discriminator: no finish value,
 * no completed stamp. A window ending in this shape cannot prove it holds the
 * lane's last assistant turn.
 */
function openAssistantMessage(text: string) {
	return {
		info: { role: 'assistant' },
		parts: [{ type: 'text', text }],
	};
}

function userTurnMessage(text = 'prior turn') {
	return {
		info: { role: 'user' },
		parts: [{ type: 'text', text }],
	};
}

function baseOps(): Pick<
	SessionOps,
	'create' | 'prompt' | 'delete' | 'messages' | 'status'
> {
	return {
		create: mock(async () => ({ data: { id: 'unused' } })),
		prompt: mock(async () => ({ data: null })),
		delete: mock(async () => undefined),
		status: mock(async () => ({ data: {} })),
		messages: mock(async () => ({ data: [] })),
	};
}

async function recordCollectedReviewerLane(args: {
	batchId: string;
	laneId: string;
}): Promise<string> {
	const correlationId = `${args.batchId}--${args.laneId}`;
	await recordPendingDelegation(tempDir, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: SESSION_ID,
		callID: args.batchId,
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: args.batchId,
		laneId: args.laneId,
		mode: 'swarm-pr-review:reviewer',
		workflowLane: args.laneId,
		workspace: {
			directory: tempDir,
			gitHead: HEAD_SHA,
			dirtyHash: null,
			prHeadSha: HEAD_SHA,
			scope: PR_REVIEW_SCOPE,
		},
		promptHash: `${args.batchId}-hash`,
		generation: 1,
	});
	return correlationId;
}

async function declareReviewerBatch(args: {
	batchId: string;
	laneId: string;
}): Promise<void> {
	await establishReviewPrerequisites();
	await recordPrReviewValidationBatch(
		tempDir,
		SESSION_ID,
		'reviewer',
		[
			{
				laneId: args.laneId,
				workflowLane: args.laneId,
				reviewItemIds: [...ITEM_IDS],
			},
		],
		{ batchId: args.batchId, prHeadSha: HEAD_SHA },
	);
}

beforeEach(() => {
	setupPrWorkflowGateFixtures();
	Object.assign(_internals, originalInternals);
	_internals.resolvePrWorkflowRevisionDigestAsync = async () => REVISION_DIGEST;
});

afterEach(async () => {
	Object.assign(_internals, originalInternals);
	await teardownPrWorkflowGateFixtures();
});

describe('collect_lane_results — honest transcript_incomplete for count-truncated verdict windows (#3312/#3313)', () => {
	test('AC26: a 50-message window without any terminal assistant message still fails with transcript_incomplete', async () => {
		const batchId = 'verdict-window-open-3312';
		const laneId = 'reviewer-window-open';
		await declareReviewerBatch({ batchId, laneId });
		const correlationId = await recordCollectedReviewerLane({
			batchId,
			laneId,
		});
		const verdictText = ITEM_IDS.map((id) => reviewed(id)).join('\n');
		const window = [
			...Array.from({ length: PADDING_TURNS }, (_unused, index) =>
				userTurnMessage(`prior turn ${index}`),
			),
			openAssistantMessage(verdictText),
		];
		expect(window).toHaveLength(50);
		_internals.getSessionOps = () => ({
			...baseOps(),
			status: mock(async () => ({
				data: { [correlationId]: { type: 'idle' } },
			})),
			messages: mock(async () => ({ data: window })),
		});

		const result = await executeCollectLaneResults(
			{ batch_id: batchId, wait: false },
			tempDir,
			{ sessionID: SESSION_ID },
		);

		// No terminal assistant message in the window: the incomplete flag is
		// honest and the verdict lane still fails transport validation on it.
		expect(result.failed).toBe(1);
		expect(result.lane_results[0]?.status).toBe('failed');
		expect(result.lane_results[0]?.transcript_incomplete).toBe(true);
		expect(result.lane_results[0]?.error).toContain(
			'result.transcript_incomplete',
		);
		const record = findByCorrelationId(tempDir, correlationId)!;
		expect(record.status).toBe('error');
		expect(record.result?.transcriptIncomplete).toBe(true);
		expect(record.result?.error).toContain('result.transcript_incomplete');
	});
});
