// Issue #3362 AC1/AC4 (+ #3341 class): the critic preflight's reviewer
// derivations read through the FAIL-CLOSED authoritative gate; the severity
// lookup stays null-prototype. Fixture (frozen check C5 shape: real gate
// APIs over a real temp git repository): a complete discovery chain, then
// ONE reviewer batch partitioned into two lanes — the covered lane settles
// completed, the gap lane fails — leaving the reviewer phase genuinely
// PARTIAL. Post-fix contract: an uncovered partial phase yields an EMPTY
// severity Map and NO order-unstable items (even under a stale coherence
// stamp); an admitted settlement covering the unclaimed items retains the
// surviving claims; a prototype-key id WITHOUT an entry renders bare.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { storeLaneOutput } from '../../../src/background/lane-output-store.ts';
import {
	appendDelegationTransition,
	readDelegations,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.ts';
import { closeAllProjectDbs } from '../../../src/db/project-db.ts';
import {
	activatePrWorkflow,
	bindPrReviewBase,
	derivePrReviewOrderUnstableItems,
	derivePrReviewReviewerSeverities,
	enforcePrReviewBaseDimensions,
	_test_exports as gateInternals,
	markPrReviewTriggerEvaluationComplete,
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_REQUIRED_MICRO_LANE_IDS,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.ts';
import {
	withSessionStateMutation,
	writeStateWhileLocked,
} from '../../../src/pr-review/persistence.ts';
import {
	buildVerdictSettlementReceipt,
	persistVerdictSettlementReceipt,
	readVerdictSettlementReceipt,
} from '../../../src/pr-review/verdict-settlement.ts';
import {
	_internals as dispatchInternals,
	_test_exports as dispatchTest,
	executeCollectLaneResults,
	executeDispatchLanesAsync,
} from '../../../src/tools/dispatch-lanes.ts';
import { safeRmRecursive } from '../../helpers/safe-test-dir.ts';
import { canonicalMkdtemp } from '../../helpers/tmpdir.ts';
import { initializeGitRepository } from '../helpers/git-repository.ts';
import { LEGACY_PR_REVIEW_RESILIENCE_POLICY } from '../pr-review-test-policy.ts';

const SESSION_ID = 'severity-authoritative-3362';
const HEAD_SHA = 'abc123';
const BASE_SHA = 'def456';
const BASE_REF = 'origin/main';
const REVISION_DIGEST = 'revision-digest-3362';
const REVIEW_SCOPE = `complete PR diff ${BASE_SHA}...${HEAD_SHA}`;
const INVENTORY = PR_REVIEW_BASE_DIMENSION_IDS.map((_d, i) => `C-${i}`);
const COVERED = INVENTORY.slice(0, 2);
const GAP = INVENTORY.filter((itemId) => !COVERED.includes(itemId));
const ITEM_SEVERITY: Record<string, string> = { 'C-0': 'LOW', 'C-1': 'HIGH' };
type DigestMap = Record<string, string>;

let directory = '';
const transcripts = new Map<string, string>();
const originalInternals = { ...dispatchInternals };
const originalGateInternals = { ...gateInternals };

/** Record + artifact + completed transition for one settled discovery lane. */
async function recordSettledLane(args: {
	correlationId: string;
	callID: string;
	batchId: string;
	laneId: string;
	mode: string;
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

/** One reviewer lane declaration (identical shape for both fixture lanes). */
const reviewerLane = (id: string, reviewItemIds: string[]) => ({
	id,
	agent: 'reviewer',
	prompt: 'Classify every assigned candidate.',
	workflow_lane: id,
	review_item_ids: reviewItemIds,
});

/** Full discovery prerequisite chain + one PARTIAL reviewer pass. */
async function establishPartialReviewerPhase(): Promise<void> {
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
		await recordSettledLane({
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
		await recordSettledLane({
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
			evidence: `evidence for ${workflowLane}`,
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

	// One reviewer batch, partitioned: covered lane settles, gap lane fails.
	const batchId = 'rev-pass-a-3362';
	const coveredLaneId = 'rev-a-covered';
	const gapLaneId = 'rev-a-gap';
	const dispatchResult = await executeDispatchLanesAsync(
		{
			mode: 'swarm-pr-review:reviewer',
			pr_head_sha: HEAD_SHA,
			base_sha: BASE_SHA,
			base_ref: BASE_REF,
			batch_id: batchId,
			lanes: [
				reviewerLane(coveredLaneId, [...COVERED]),
				reviewerLane(gapLaneId, [...GAP]),
			],
		},
		directory,
		{ sessionID: SESSION_ID },
	);
	expect(dispatchResult.success, String(dispatchResult.message)).toBe(true);

	let coveredRecord: { subagentSessionId?: string } | undefined;
	for (let attempt = 0; attempt < 250; attempt++) {
		coveredRecord = (readDelegations(directory) ?? []).find(
			(candidate) =>
				candidate.batchId === batchId && candidate.laneId === coveredLaneId,
		);
		if (coveredRecord?.subagentSessionId) break;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	expect(coveredRecord?.subagentSessionId).toBeTruthy();
	// Byte-identical to a 12-column pipe-joined row with its trailing " | ".
	const partialRows = COVERED.map(
		(itemId) =>
			`[REVIEWED] | ${itemId} | CONFIRMED | STRUCTURALLY_PROVEN | ${ITEM_SEVERITY[itemId]} | YES | src/a.ts:1 | direct code evidence at the exact location | traced downstream impact context | reviewer root cause analysis | UNKNOWN | `,
	).join('\n');
	transcripts.set(coveredRecord.subagentSessionId, partialRows);
	const collected = await executeCollectLaneResults(
		{ batch_id: batchId, wait: false },
		directory,
		{ sessionID: SESSION_ID },
	);
	const coveredLaneResult = (collected?.lane_results ?? []).find(
		(lane) => lane.id === coveredLaneId,
	);
	expect(coveredLaneResult?.status).toBe('completed');
}

/** Anti-vacuity: the reviewer phase must be genuinely PARTIAL. */
async function assertPhaseIsPartial(): Promise<void> {
	const state = await readPrWorkflowGateState(directory, SESSION_ID);
	expect(state).not.toBeNull();
	const { composePrReviewPhaseVerdicts } = await import(
		'../../../src/pr-review/legacy-transcript-adapter.ts'
	);
	const composition = composePrReviewPhaseVerdicts(
		directory,
		state!,
		'reviewer',
		{ revisionDigest: REVISION_DIGEST },
	);
	const claimIds = [...composition.claims.keys()].sort();
	const unclaimed = [...composition.unclaimed].sort();
	expect(claimIds).toEqual([...COVERED].sort());
	expect(unclaimed).toEqual([...GAP].sort());
}

/** Sanctioned locked hand-mutation of persisted gate state (codec-validated). */
async function mutateAuthoritativeState(
	mutate: (state: Record<string, unknown>) => void,
): Promise<void> {
	await withSessionStateMutation(directory, SESSION_ID, async () => {
		const current = await readPrWorkflowGateState(directory, SESSION_ID);
		if (!current) throw new Error('missing active workflow state');
		const next = structuredClone(current) as unknown as Record<string, unknown>;
		mutate(next);
		await writeStateWhileLocked(directory, next as never);
	});
	gateInternals.resetTrackedStateCache();
}

beforeEach(async () => {
	directory = canonicalMkdtemp('severity-authoritative-3362-');
	await initializeGitRepository(directory);
	dispatchTest.resetDeliveredLaneOutputs();
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
	let sessionCounter = 0;
	dispatchInternals.getSessionOps = () =>
		({
			create: async () => ({
				data: { id: `child-3362-${++sessionCounter}` },
				error: undefined,
			}),
			prompt: async () => ({ data: undefined, error: undefined }),
			promptAsync: async () => ({ data: undefined, error: undefined }),
			status: async () => ({
				data: Object.fromEntries(
					[...transcripts.keys()].map((session) => [session, { type: 'idle' }]),
				),
				error: undefined,
			}),
			messages: async (args: { path: { id: string } }) => ({
				data: transcripts.has(args.path.id)
					? [
							{
								info: { role: 'assistant' },
								parts: [{ type: 'text', text: transcripts.get(args.path.id) }],
							},
						]
					: [],
				error: undefined,
			}),
			delete: async () => undefined,
		}) as never;
}, 30_000);

afterEach(async () => {
	Object.assign(dispatchInternals, originalInternals);
	Object.assign(gateInternals, originalGateInternals);
	gateInternals.resetTrackedStateCache();
	dispatchTest.resetDeliveredLaneOutputs();
	closeAllProjectDbs();
	safeRmRecursive(directory);
	transcripts.clear();
}, 30_000);

describe('critic preflight derivations read the authoritative gate (#3362 AC1)', () => {
	test('an UNCOVERED partial reviewer phase yields an EMPTY severity map', async () => {
		await establishPartialReviewerPhase();
		await assertPhaseIsPartial();
		const severities = await derivePrReviewReviewerSeverities(
			directory,
			SESSION_ID,
		);
		// Return-type guard: a broken type is never a pass.
		expect(severities).toBeInstanceOf(Map);
		expect(severities.size).toBe(0);
	}, 120_000);

	test('an UNCOVERED partial phase yields NO order-unstable items even with a stale stamp', async () => {
		await establishPartialReviewerPhase();
		await assertPhaseIsPartial();
		// Seed a stale coherence stamp from a prior critic batch window. The
		// codec rejects hand-rolled batch shapes, so clone a REAL persisted
		// batch and re-identify it.
		await mutateAuthoritativeState((state) => {
			const batches = Array.isArray(state.prReviewValidationBatches)
				? (state.prReviewValidationBatches as Record<string, unknown>[])
				: [];
			const template = batches[0];
			if (!template) throw new Error('fixture must persist a batch');
			const stale = structuredClone(template);
			stale.batchId = 'stale-critic-batch';
			stale.phase = 'critic';
			state.prReviewValidationBatches = [stale, ...batches];
			state.prReviewBatchCoherence = {
				...((state.prReviewBatchCoherence as Record<string, unknown>) ?? {}),
				'stale-critic-batch': {
					validatedInventory: [...INVENTORY],
					orderUnstableItemIds: [...GAP],
				},
			};
		});
		// The stamp is stale vs the UNCOVERED phase: the gate must ignore it.
		const unstable = await derivePrReviewOrderUnstableItems(
			directory,
			SESSION_ID,
		);
		expect(unstable).toEqual([]);
	}, 120_000);

	test('an admitted settlement covering the gap retains the surviving claims', async () => {
		await establishPartialReviewerPhase();
		await assertPhaseIsPartial();
		// Admit a settlement covering every unclaimed item through the REAL
		// mechanism: a persisted receipt anchored by its sha256 digest in
		// durable state (the reader re-verifies run/prHeadSha/revisionDigest
		// AND the digest anchor).
		const gate = await readPrWorkflowGateState(directory, SESSION_ID);
		let runId = gate?.prReviewArtifactRunId ?? gate?.prReviewReservedRunId;
		if (!runId) {
			// The fixture stops after the reviewer pass, so no artifact run is
			// bound yet: bind the trigger-evaluation run ('run') — the receipt
			// lives in that run's .swarm/pr-review/<runId>/ directory.
			runId = gate?.prReviewTriggerEvalRunId;
			if (!runId) throw new Error('fixture must reserve a run id');
			await mutateAuthoritativeState((state) => {
				state.prReviewArtifactRunId = runId;
			});
		}
		const receipt = buildVerdictSettlementReceipt({
			runId,
			prHeadSha: HEAD_SHA,
			revisionDigest: REVISION_DIGEST,
			phase: 'reviewer',
			items: GAP.map((itemId) => ({
				itemId,
				sourceBatchId: 'rev-pass-a-3362',
				sourceLaneId: 'rev-a-gap',
				disposition: 'liveness_dead',
				evidenceClass: 'liveness',
				terminalStatus: 'stale',
			})),
		});
		await persistVerdictSettlementReceipt(directory, receipt);
		const readBack = readVerdictSettlementReceipt(directory, runId, 'reviewer');
		// The receipt must round-trip (status ok AND a raw sha256 to anchor).
		expect(readBack.status).toBe('ok');
		if (readBack.status !== 'ok') throw new Error(readBack.status);
		expect(readBack.rawSha256).toMatch(/^[0-9a-f]{64}$/);
		await mutateAuthoritativeState((state) => {
			const prior = (state.prReviewVerdictSettlementDigests ?? {}) as DigestMap;
			state.prReviewVerdictSettlementDigests = {
				...prior,
				reviewer: readBack.rawSha256,
			};
		});
		const severities = await derivePrReviewReviewerSeverities(
			directory,
			SESSION_ID,
		);
		expect(severities).toBeInstanceOf(Map);
		// The surviving ACTUAL claims are retained under admission.
		expect([...severities.keys()].sort()).toEqual([...COVERED].sort());
		expect(severities.get('C-0')).toBe('LOW');
		expect(severities.get('C-1')).toBe('HIGH');
		// Unstamped covered phase: single-pass claims are 'single', so [].
		const unstable = await derivePrReviewOrderUnstableItems(
			directory,
			SESSION_ID,
		);
		expect(unstable).toEqual([]);
	}, 120_000);
});

describe('null-prototype severity lookup (#3362 AC4)', () => {
	test('the severity lookup helper returns no inherited member for a prototype-key item id without an entry', () => {
		const lookup = dispatchTest.ownPropertySeverityLookup(
			new Map([
				['c1', 'HIGH'],
				['c2', 'LOW'],
			]),
		);
		expect(lookup.c1).toBe('HIGH');
		// 'toString' has no settled severity: the null-prototype lookup must
		// yield undefined (bare render), never the inherited function.
		expect(lookup.toString).toBeUndefined();
		expect(lookup.constructor).toBeUndefined();
		expect(lookup.hasOwnProperty).toBeUndefined();
		// And the lookup carries no Object prototype at all.
		expect(Object.getPrototypeOf(lookup)).toBeNull();
	});

	test('every settled severity is an own property', () => {
		const lookup = dispatchTest.ownPropertySeverityLookup(
			new Map([
				['toString', 'HIGH'],
				['valueOf', 'LOW'],
			]),
		);
		// Prototype-key IDS WITH entries render their own settled severity.
		expect(lookup.toString).toBe('HIGH');
		expect(lookup.valueOf).toBe('LOW');
		expect(Object.keys(lookup).sort()).toEqual(['toString', 'valueOf']);
	});
});
