// Issue #3310 AC — the critic's per-item reviewer severities must be DERIVED
// end-to-end: the dispatch handler's critic-mode preflight calls the new gate
// export derivePrReviewReviewerSeverities(directory, sessionID) on an active
// PR_REVIEW workflow and passes the composed severities to
// applyPrWorkflowPromptContract via the reviewerSeverities option (semantics
// frozen by the sibling dispatch-lanes-critic-lane-reviewer-severity.test.ts).
// Also frozen here: (a) a PARTIAL map annotates only known ids (c2 renders
// BARE on the assigned_item_ids line); (b) an EMPTY object option `{}` is
// treated as absent — byte-identical to the no-option rendering.
//
// The end-to-end group drives the real executeDispatchLanesAsync entry point
// in critic mode over FULL reviewer-artifact seeding (no fallback seam): the
// critic-validator-rejection stub family combined with the
// counterbalance-production-2906 prerequisites chain, two reviewer passes
// settled through the real collect path, then the critic dispatch.
//
// At base the derivePrReviewReviewerSeverities import fails the whole file:
// expected ERROR at base (NEW-SURFACE), GREEN after the fix.
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
	derivePrReviewReviewerSeverities,
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
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { waitFor } from '../../helpers/wait-for.js';
import { LEGACY_PR_REVIEW_RESILIENCE_POLICY } from '../pr-review-test-policy.js';

// Group 1 fixtures — pure applyPrWorkflowPromptContract option semantics.

type ContractOptions = Parameters<
	typeof _test_exports.applyPrWorkflowPromptContract
>[1];
type ContractLane = Parameters<
	typeof _test_exports.applyPrWorkflowPromptContract
>[0][number];

const criticLane: ContractLane = {
	id: 'crit1',
	agent: 'critic',
	prompt: 'challenge the assigned findings',
	workflow_lane: 'final-challenge',
	review_item_ids: ['c1', 'c2'],
};

const criticOptions = (extra: Record<string, unknown> = {}) =>
	({
		mode: 'swarm-pr-review:critic',
		prHeadSha: 'a'.repeat(40),
		revisionDigest: 'b'.repeat(64),
		...extra,
	}) as ContractOptions;

function contractedPrompt(options: ContractOptions): string {
	const result = _test_exports.applyPrWorkflowPromptContract(
		[criticLane],
		options,
	);
	if (!result.ok) {
		throw new Error(`contract rejected: ${result.errors.join('; ')}`);
	}
	const prompt = result.lanes[0]?.prompt ?? '';
	if (prompt === '') throw new Error('contract returned no prompt');
	return prompt;
}

function assignedItemIdsLine(prompt: string): string {
	const line = prompt
		.split('\n')
		.find((candidate) => candidate.startsWith('assigned_item_ids:'));
	if (line === undefined) {
		throw new Error('prompt has no assigned_item_ids line');
	}
	return line;
}

describe('option semantics — reviewerSeverities partial and empty maps (issue #3310)', () => {
	test('an all-present map pairs each assigned item id with its severity on its own line', () => {
		const prompt = contractedPrompt(
			criticOptions({ reviewerSeverities: { c1: 'HIGH', c2: 'LOW' } }),
		);
		expect(prompt).toContain('assigned_item_ids: c1, c2');
		expect(prompt).toMatch(/c1[^\n]*HIGH/);
		expect(prompt).toMatch(/c2[^\n]*LOW/);
	});

	test('a PARTIAL map annotates only known ids; the unsupplied id renders bare', () => {
		const prompt = contractedPrompt(
			criticOptions({ reviewerSeverities: { c1: 'HIGH' } }),
		);
		const assignedLine = assignedItemIdsLine(prompt);
		// The supplied id still gets its pairing on a reviewer_severity line...
		expect(prompt).toMatch(/c1[^\n]*HIGH/);
		// ...while the unsupplied id is the bare terminal token of the
		// assigned_item_ids line — no severity annotation after c2.
		expect(assignedLine).toMatch(/\bc2\s*$/);
		expect(assignedLine).not.toMatch(/c2[^\n]*reviewer\s+severity/i);
		expect(prompt).not.toMatch(/c2[^\n]*severity/i);
	});

	test('an EMPTY object option is treated as absent — byte-identical to the no-option rendering', () => {
		const absent = contractedPrompt(criticOptions());
		const emptyMap = contractedPrompt(
			criticOptions({ reviewerSeverities: {} }),
		);
		expect(emptyMap).toBe(absent);
		expect(emptyMap).toContain('assigned_item_ids: c1, c2');
		expect(emptyMap).not.toContain('reviewer_severity');
		expect(emptyMap).not.toMatch(/reviewer\s+severity/i);
	});
});

// Group 2 harness — real dispatch path over established PR-review state.

const SESSION_ID = 'critic-severity-wiring-3310';
const HEAD_SHA = 'abc123';
const BASE_SHA = 'def456';
const BASE_REF = 'origin/main';
const REVISION_DIGEST = 'critic-severity-revision-3310';
const REVIEW_SCOPE = `complete PR diff ${BASE_SHA}...${HEAD_SHA}`;
/** Canonical sorted candidate inventory produced by the base fixture. */
const INVENTORY = PR_REVIEW_BASE_DIMENSION_IDS.map(
	(_dimension, index) => `C-${index}`,
);
/** Distinct settled reviewer severities — every token is unique per item so
 * the per-item reviewer_severity assertions cannot cross-match another item. */
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
			ITEM_SEVERITY[itemId],
			'YES',
			'src/a.ts:1',
			'direct code evidence at the exact location',
			'traced downstream impact context',
			'reviewer root cause analysis',
			// UNKNOWN routes every item into the critic inventory; ORDINARY
			// leaves LOW/no-tag MEDIUM items unrouted and the critic dispatch
			// is BLOCKED at record time (critic-routing.ts:49).
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

describe('derivation helper and dispatch wiring (issue #3310)', () => {
	beforeEach(() => {
		directory = canonicalMkdtemp('dispatch-critic-severity-3310-');
		mkdirSync(path.join(directory, '.git'), { recursive: true });
		createdSessions = 0;
		deliveredPrompts = [];
		transcripts = new Map();
		_test_exports.resetDeliveredLaneOutputs();
		gateInternals.resetTrackedStateCache();
		gateInternals.resolveCurrentGitHead = () => HEAD_SHA;
		gateInternals.resolveCurrentGitHeadAsync = async () => HEAD_SHA;
		gateInternals.resolveIsWorkingTreeClean = () => true;
		gateInternals.resolveIsWorkingTreeCleanAsync = async () => true;
		gateInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
		dispatchInternals.resolvePrWorkflowRevisionDigestAsync = async () =>
			REVISION_DIGEST;
		dispatchInternals.resolveExactMergeBaseAsync = async () => BASE_SHA;
		dispatchInternals.getGeneratedAgentNames = () => ['reviewer', 'critic'];
		const ops: SessionOps = {
			create: mock(async () => ({
				data: { id: `critic-sev-child-${++createdSessions}` },
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

	afterEach(async () => {
		Object.assign(dispatchInternals, originalInternals);
		Object.assign(gateInternals, originalGateInternals);
		gateInternals.resetTrackedStateCache();
		_test_exports.resetDeliveredLaneOutputs();
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

	test('derivePrReviewReviewerSeverities composes settled reviewer severities and the critic dispatch renders them per item', async () => {
		await establishReviewPrerequisites();
		// Two counterbalanced reviewer passes settled with identical severities
		// — the admission shape a critic dispatch requires.
		await dispatchReviewerBatch('rev-sev-a');
		await awaitPromptCount(1);
		await settleViaCollect('rev-sev-a');
		await dispatchReviewerBatch('rev-sev-b');
		await awaitPromptCount(2);
		await settleViaCollect('rev-sev-b');

		// (a) The derivation helper returns the composed reviewer severities.
		const severities = await derivePrReviewReviewerSeverities(
			directory,
			SESSION_ID,
		);
		expect(severities).toBeInstanceOf(Map);
		expect(severities.size).toBeGreaterThanOrEqual(INVENTORY.length);
		for (const itemId of INVENTORY) {
			expect(severities.get(itemId), `severity for ${itemId}`).toBe(
				ITEM_SEVERITY[itemId],
			);
		}

		// (b) A critic-mode dispatch renders each item's severity on its own
		// reviewer_severity line (#3358 AC8) inside the controller-bound block.
		const critic = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:critic',
				pr_head_sha: HEAD_SHA,
				base_sha: BASE_SHA,
				base_ref: BASE_REF,
				batch_id: 'critic-sev-pass-1',
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
		expect(critic.success, critic.message).toBe(true);
		await awaitPromptCount(3);
		const criticPrompt = deliveredPrompts[2];
		expect(criticPrompt).toContain('[CONTROLLER-BOUND PR WORKFLOW CONTRACT]');
		expect(assignedItemIdsLine(criticPrompt)).not.toContain('(');
		// Exact controller line shape, so the contract card's positive
		// REVIEWED example row cannot vacuously satisfy a whole-prompt match.
		expect(criticPrompt).toContain('reviewer_severity: C-0=LOW');
		expect(criticPrompt).toContain('reviewer_severity: C-1=HIGH');
		expect(criticPrompt).toContain('reviewer_severity: C-2=CRITICAL');
		expect(criticPrompt).toContain('reviewer_severity: C-3=MEDIUM');
	}, 60_000);
});
