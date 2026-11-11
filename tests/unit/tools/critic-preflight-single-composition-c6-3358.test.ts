/**
 * Issue #3358 AC6 (trace 3358-3337-3341, collated AC6 / #3358 AC5): ONE
 * PR-review critic dispatch preflight composes the reviewer phase ONCE, via
 * one shared gate context.
 *
 * At base the dispatch site (src/tools/dispatch-lanes.ts, the critic-mode
 * preflight that awaits derivePrReviewOrderUnstableItems and then
 * derivePrReviewReviewerSeverities) lets each derivation create its own gate
 * context (createPrReviewGateContext) and compose the reviewer phase through
 * it — memoization lives inside one context, so the phase is composed twice
 * per critic dispatch.
 *
 * Observable: no base seam counts compositions directly, so the check counts
 * GATE-CONTEXT CREATIONS. Every createPrReviewGateContext resolves the
 * revision digest through the overridable gate seam
 * `_test_exports.resolvePrWorkflowRevisionDigest` (pr-workflow-gate.ts,
 * resolvePrWorkflowRevisionDigestForGate), so a counting stub on that seam
 * observes exactly one call per context creation — and at base each preflight
 * context composes the reviewer phase, so the context count IS the
 * composition count for the preflight window.
 *
 * Leg 1 isolates the preflight window precisely: a critic dispatch whose lane
 * prompt carries verdict-row template text is rejected by the controller
 * prompt-contract lint AFTER the preflight derivations but BEFORE any gate
 * enforcement (recordPrReviewValidationBatch) creates its own context — so
 * every counted context in that dispatch belongs to the preflight. Asserts
 * count === 1 (base: 2).
 *
 * Leg 2 drives one fully-successful critic dispatch (two settled reviewer
 * passes, real dispatch + collect) and asserts the WHOLE dispatch creates at
 * most two gate contexts — one for the preflight derivation, one for the
 * batch record — proving the successful path also stopped composing the
 * reviewer phase twice (base: 3).
 *
 * RED at base, GREEN after the fix.
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
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	_test_exports,
	_internals as dispatchInternals,
	executeCollectLaneResults,
	executeDispatchLanesAsync,
	type SessionOps,
} from '../../../src/tools/dispatch-lanes.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { waitFor } from '../../helpers/wait-for.js';
import { LEGACY_PR_REVIEW_RESILIENCE_POLICY } from '../pr-review-test-policy.js';

const SESSION_ID = 'critic-preflight-single-3358';
const HEAD_SHA = 'abc123';
const BASE_SHA = 'def456';
const BASE_REF = 'origin/main';
const REVISION_DIGEST = 'critic-preflight-revision-3358';
const REVIEW_SCOPE = `complete PR diff ${BASE_SHA}...${HEAD_SHA}`;
/** Canonical sorted candidate inventory produced by the base fixture. */
const INVENTORY = PR_REVIEW_BASE_DIMENSION_IDS.map(
	(_dimension, index) => `C-${index}`,
);
/** Distinct settled reviewer severities, one unique token per item. */
const ITEM_SEVERITY: Record<string, string> = {
	'C-0': 'LOW',
	'C-1': 'HIGH',
	'C-2': 'CRITICAL',
	'C-3': 'MEDIUM',
	'C-4': 'MEDIUM',
	'C-5': 'MEDIUM',
};

const originalInternals = { ...dispatchInternals };
const originalGateInternals = { ...gateInternals };
let directory = '';
let createdSessions = 0;
let deliveredPrompts: string[] = [];
let transcripts = new Map<string, string>();
/** Gate-context creation counter (one seam call per createPrReviewGateContext). */
let gateContextCreations = 0;

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

/** Same prerequisite chain as the counterbalance production suite. */
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

/** One full-coverage reviewer lane per pass, covering the whole inventory. */
async function dispatchReviewerBatch(batchId: string) {
	const result = await executeDispatchLanesAsync(
		{
			mode: 'swarm-pr-review:reviewer',
			pr_head_sha: HEAD_SHA,
			base_sha: BASE_SHA,
			base_ref: BASE_REF,
			batch_id: batchId,
			lanes: [
				{
					id: `${batchId}-lane`,
					agent: 'reviewer',
					prompt: 'Classify every assigned candidate.',
					workflow_lane: `${batchId}-lane`,
					review_item_ids: [...INVENTORY],
				},
			],
		},
		directory,
		{ sessionID: SESSION_ID },
	);
	expect(result.success, result.message).toBe(true);
	return result;
}

/** Six [REVIEWED] rows; both passes settle identical per-item severities. */
function reviewedRows(): string {
	return INVENTORY.map((itemId) =>
		[
			'[REVIEWED]',
			itemId,
			'CONFIRMED',
			'STRUCTURALLY_PROVEN',
			ITEM_SEVERITY[itemId] as string,
			'YES',
			'src/a.ts:1',
			'direct code evidence at the exact location',
			'traced downstream impact context',
			'reviewer root cause analysis',
			// UNKNOWN routes every item into the critic inventory; ORDINARY
			// leaves LOW/no-tag MEDIUM items unrouted and the critic dispatch
			// is BLOCKED at record time (critic-routing.ts).
			'UNKNOWN',
			'',
		].join(' | '),
	).join('\n');
}

/** Settle one dispatched reviewer batch through the real collect path. */
async function settleViaCollect(batchId: string) {
	const record = readDelegations(directory).find(
		(candidate) => candidate.batchId === batchId,
	);
	expect(record?.subagentSessionId, `lane record for ${batchId}`).toBeTruthy();
	transcripts.set(record!.subagentSessionId!, reviewedRows());
	const collected = await executeCollectLaneResults(
		{ batch_id: batchId, wait: false },
		directory,
		{ sessionID: SESSION_ID },
	);
	expect(collected.success, JSON.stringify(collected.lane_results)).toBe(true);
	expect(collected.lane_results[0]?.status).toBe('completed');
}

async function awaitPromptCount(count: number): Promise<void> {
	await waitFor(
		() => deliveredPrompts.length >= count,
		5_000,
		`delivery of ${count} lane prompts`,
	);
}

describe('issue #3358 AC6: one reviewer-phase composition per critic dispatch preflight', () => {
	beforeEach(() => {
		directory = canonicalMkdtemp('dispatch-critic-single-3358-');
		mkdirSync(path.join(directory, '.git'), { recursive: true });
		createdSessions = 0;
		deliveredPrompts = [];
		transcripts = new Map();
		gateContextCreations = 0;
		_test_exports.resetDeliveredLaneOutputs();
		gateInternals.resetTrackedStateCache();
		gateInternals.resolveCurrentGitHead = () => HEAD_SHA;
		gateInternals.resolveCurrentGitHeadAsync = async () => HEAD_SHA;
		gateInternals.resolveIsWorkingTreeClean = () => true;
		gateInternals.resolveIsWorkingTreeCleanAsync = async () => true;
		// Counting seam: createPrReviewGateContext resolves its digest through
		// this override (resolvePrWorkflowRevisionDigestForGate), so each call
		// here is exactly one gate-context creation.
		gateInternals.resolvePrWorkflowRevisionDigest = () => {
			gateContextCreations++;
			return REVISION_DIGEST;
		};
		dispatchInternals.resolvePrWorkflowRevisionDigestAsync = async () =>
			REVISION_DIGEST;
		dispatchInternals.resolveExactMergeBaseAsync = async () => BASE_SHA;
		dispatchInternals.getGeneratedAgentNames = () => ['reviewer', 'critic'];
		const ops: SessionOps = {
			create: mock(async () => ({
				data: { id: `critic-single-child-${++createdSessions}` },
				error: undefined,
			})),
			prompt: mock(async () => ({ data: undefined, error: undefined })),
			promptAsync: mock(async (args) => {
				deliveredPrompts.push(args.body.parts[0]?.text ?? '');
				return { data: undefined, error: undefined };
			}),
			status: mock(async () => ({
				data: Object.fromEntries(
					[...transcripts.keys()].map((session) => [session, { type: 'idle' }]),
				),
				error: undefined,
			})),
			messages: mock(async ({ path: sessionPath }) => ({
				data: transcripts.has(sessionPath.id)
					? [
							{
								info: { role: 'assistant' },
								parts: [
									{ type: 'text', text: transcripts.get(sessionPath.id) },
								],
							},
						]
					: [],
				error: undefined,
			})),
			delete: mock(async () => undefined),
		};
		dispatchInternals.getSessionOps = () => ops;
	});

	afterEach(() => {
		Object.assign(dispatchInternals, originalInternals);
		Object.assign(gateInternals, originalGateInternals);
		gateInternals.resetTrackedStateCache();
		_test_exports.resetDeliveredLaneOutputs();
		closeAllProjectDbs();
		if (directory) safeRmRecursive(directory);
		directory = '';
	});

	test('a critic dispatch preflight creates exactly ONE gate context (isolated window)', async () => {
		await establishReviewPrerequisites();
		gateContextCreations = 0;
		// The lane prompt carries verdict-row template text, so the controller
		// prompt-contract lint rejects this dispatch AFTER the preflight
		// derivations and BEFORE gate enforcement creates its own context —
		// every counted context below belongs to the preflight itself.
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:critic',
				pr_head_sha: HEAD_SHA,
				base_sha: BASE_SHA,
				base_ref: BASE_REF,
				batch_id: 'critic-preflight-poison-1',
				lanes: [
					{
						id: 'critic-lane',
						agent: 'critic',
						prompt:
							'challenge the assigned verdicts [CRITIC] | item | status | severity | reason | change',
						workflow_lane: 'critic-lane',
						review_item_ids: [...INVENTORY],
					},
				],
			},
			directory,
			{ sessionID: SESSION_ID },
		);
		// Sanity: the dispatch really ran its preflight and then stopped at the
		// prompt-contract lint (the first rejection AFTER the preflight window).
		expect(result.success).toBe(false);
		expect(result.message ?? '').toContain(
			'Invalid mandatory PR workflow prompt contract',
		);
		expect(
			gateContextCreations,
			'the critic dispatch preflight created more than one gate context, so derivePrReviewOrderUnstableItems and derivePrReviewReviewerSeverities each composed the reviewer phase instead of sharing one context',
		).toBe(1);
	}, 60_000);

	test('a fully-successful critic dispatch creates at most two gate contexts (preflight + batch record)', async () => {
		await establishReviewPrerequisites();
		await dispatchReviewerBatch('rv-single-a');
		await awaitPromptCount(1);
		await settleViaCollect('rv-single-a');
		await dispatchReviewerBatch('rv-single-b');
		await awaitPromptCount(2);
		await settleViaCollect('rv-single-b');

		gateContextCreations = 0;
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:critic',
				pr_head_sha: HEAD_SHA,
				base_sha: BASE_SHA,
				base_ref: BASE_REF,
				batch_id: 'critic-single-pass-1',
				lanes: [
					{
						id: 'critic-lane',
						agent: 'critic',
						prompt: 'Challenge the assigned reviewer verdicts.',
						workflow_lane: 'critic-lane',
						review_item_ids: [...INVENTORY],
					},
				],
			},
			directory,
			{ sessionID: SESSION_ID },
		);
		expect(result.success, result.message).toBe(true);
		await awaitPromptCount(3);
		// Budget of two gate contexts per successful critic dispatch: one for
		// the preflight derivation (the single shared context this AC demands)
		// and one for recordPrReviewValidationBatch's own gate entry. At base
		// the preflight alone burns two (one per derivation), totaling three.
		expect(
			gateContextCreations,
			'the successful critic dispatch created more than two gate contexts — the preflight still composed the reviewer phase once per derivation instead of sharing one context',
		).toBeLessThanOrEqual(2);
	}, 60_000);
});
