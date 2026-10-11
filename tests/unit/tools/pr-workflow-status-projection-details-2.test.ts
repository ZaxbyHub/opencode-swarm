/**
 * Issue #3095 — fix-PR details coverage, part 2 (F8 uncovered-branch
 * register): lane coverage rows. Pins markers (finding / clean / no-evidence
 * / unknown-evidence), itemCount attribution, the lanes cap, per-source
 * degradation, mixed-evidence precedence, finding bounding, and the artifact
 * parse bound. Additional to the frozen acceptance suite — never a
 * replacement for it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import {
	publishPrReviewResultReceipt,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	encodePrReviewWorkflowBinding,
	type PrReviewLaneResultEnvelope,
	prReviewLaneResultEnvelopeDigest,
} from '../../../src/background/pr-review-contract.js';
import {
	_test_exports,
	activatePrWorkflow,
	bindPrReviewBase,
	enforcePrReviewBaseDimensions,
	PR_REVIEW_BASE_DIMENSION_IDS,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import type { ToolResult } from '../../../src/tools/create-tool.js';
import {
	_internals,
	pr_workflow_status,
} from '../../../src/tools/pr-workflow-status.js';
import {
	establishReviewPrerequisites,
	HEAD_SHA,
	LEGACY_PR_REVIEW_RESILIENCE_POLICY,
	persistBatch,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from '../hooks/pr-workflow-gate.test-fixtures.js';

const BASE_CANDIDATE_HEADER =
	'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence | risk_impact | risk_tags';

const realReadGate = _internals.readPrWorkflowGateStateForRecovery;
const realFindByBatchId = _internals.findByBatchIdDetailed;
const realHead = _internals.resolveCurrentGitHeadAsync;
const realClean = _internals.resolveIsWorkingTreeCleanAsync;
const realRunGit = _internals.runGitCapture;
const realClassify = _internals.classifyGitState;

beforeEach(() => {
	setupPrWorkflowGateFixtures();
	_internals.resolveCurrentGitHeadAsync = async () => 'a'.repeat(40);
	_internals.resolveIsWorkingTreeCleanAsync = async () => true;
	_internals.classifyGitState = async () =>
		({ kind: 'clean' }) as unknown as Awaited<ReturnType<typeof realClassify>>;
	_internals.runGitCapture = async (_d: string, args: string[]) =>
		({ 'rev-parse': 'HEAD\n', status: '', remote: '' })[args[0] ?? ''] ?? null;
});

afterEach(async () => {
	_internals.readPrWorkflowGateStateForRecovery = realReadGate;
	_internals.findByBatchIdDetailed = realFindByBatchId;
	_internals.resolveCurrentGitHeadAsync = realHead;
	_internals.resolveIsWorkingTreeCleanAsync = realClean;
	_internals.runGitCapture = realRunGit;
	_internals.classifyGitState = realClassify;
	await teardownPrWorkflowGateFixtures();
});

type LaneRow = {
	batchId: string;
	phase: string;
	laneId: string;
	workflowLane: string;
	itemCount: number | null;
	marker: string;
	findings: Array<{
		id: string;
		severity: string | null;
		title: string | null;
	}>;
	findingsTruncated: boolean;
	artifactTruncated: boolean;
};

type LanesSection = {
	lanes: LaneRow[];
	lanesTruncated: boolean;
	laneCount: number;
	sourceState: { base: string; validation: string; micro: string };
	sourceNotes: { base?: string; validation?: string; micro?: string };
};

const statusExecute = (
	pr_workflow_status as unknown as {
		execute: (args: unknown, ctx: ToolContext) => Promise<unknown>;
	}
).execute;

async function runLanes(): Promise<LanesSection> {
	const result = await statusExecute({}, {
		directory: tempDir,
		sessionID: SESSION_ID,
	} as unknown as ToolContext);
	const text =
		typeof result === 'string' ? result : (result as ToolResult).output;
	const gate = (JSON.parse(text as string) as Record<string, unknown>)
		.gate as Record<string, unknown>;
	return (gate.reviewProjection as Record<string, unknown>)
		.lanes as LanesSection;
}

function rowOf(lanes: LanesSection, laneId: string): LaneRow {
	const row = lanes.lanes.find((candidate) => candidate.laneId === laneId);
	expect(row, `lane row ${laneId} must project`).toBeDefined();
	return row as LaneRow;
}

/** Publish a real result receipt for one dispatched lane (C4 recipe). */
async function publishReceipt(options: {
	batchId: string;
	laneId: string;
	workflowLane: string;
	ownedWorkflowLanes?: string[];
	childSessionId: string;
	findings: Array<{ id: string; workflowLane: string }>;
}): Promise<void> {
	const ownedWorkflowLanes = options.ownedWorkflowLanes ?? [
		options.workflowLane,
	];
	const state = await readPrWorkflowGateState(tempDir, SESSION_ID);
	const instanceId = state.workflowInstanceId;
	const revision = state.revision;
	const child = options.childSessionId;
	await recordPendingDelegation(
		tempDir,
		JSON.parse(
			`{"correlationId":"${child}","jobId":"${encodePrReviewWorkflowBinding(instanceId)}",` +
				`"subagentSessionId":"${child}","parentSessionId":"${SESSION_ID}",` +
				`"callID":"call-${child}","normalizedAgent":"reviewer","swarmPrefixedAgent":"reviewer",` +
				`"planTaskId":null,"evidenceTaskId":null,"batchId":"${options.batchId}","laneId":"${options.laneId}",` +
				`"mode":"swarm-pr-review:base","workflowLane":"${options.workflowLane}",` +
				`"ownedWorkflowLanes":${JSON.stringify(ownedWorkflowLanes)},` +
				`"workflowGeneration":${revision},"generation":1,` +
				`"workspace":{"directory":${JSON.stringify(tempDir)},"gitHead":"${HEAD_SHA}",` +
				`"dirtyHash":null,"prHeadSha":"${HEAD_SHA}","scope":null}}`,
		),
	);
	const envelope = {
		schemaVersion: 1,
		outcome: 'FINDINGS',
		creditedLanes: ownedWorkflowLanes,
		findings: options.findings.map((finding) => ({
			id: finding.id,
			workflowLane: finding.workflowLane,
			severity: 'HIGH',
			riskImpact: 'HIGH_IMPACT',
			riskTags: ['SECURITY'],
			title: `Envelope finding ${finding.id}`,
			body: 'The lane found a reachable defect within the reviewed scope.',
			evidence: 'Confirmed from the changed path and reviewer-visible state.',
			location: { kind: 'local', file: 'src/review.ts', line: 12 },
		})),
		cleanAttestations: [],
		unresolved: [],
	} as unknown as PrReviewLaneResultEnvelope;
	const digest = prReviewLaneResultEnvelopeDigest(envelope);
	const receipt = JSON.parse(
		`{"schemaVersion":1,"mode":"swarm-pr-review:base","workflowInstanceId":"${instanceId}",` +
			`"workflowRevision":${revision},"batchId":"${options.batchId}","laneId":"${options.laneId}",` +
			`"workflowLane":"${options.workflowLane}","ownedWorkflowLanes":${JSON.stringify(ownedWorkflowLanes)},` +
			`"baseSha":"def456","headSha":"${HEAD_SHA}","dispatchRevisionDigest":"${'d'.repeat(64)}",` +
			`"childSessionId":"${child}","generation":1,` +
			`"semanticEnvelopeDigest":"${digest}","envelope":${JSON.stringify(envelope)}}`,
	);
	const outcome = await publishPrReviewResultReceipt(tempDir, {
		parentSessionId: SESSION_ID,
		childSessionId: child,
		batchId: options.batchId,
		laneId: options.laneId,
		expectedWorkflowInstanceId: instanceId,
		expectedWorkflowRevision: revision,
		expectedBaseSha: 'def456',
		receipt,
	});
	expect(['recorded', 'duplicate']).toContain(outcome.status);
}

/** Re-stub the tool's gate read with disk state plus targeted overrides. */
async function stubGateState(
	overrides: Record<string, unknown>,
): Promise<void> {
	const diskState = await readPrWorkflowGateState(tempDir, SESSION_ID);
	_internals.readPrWorkflowGateStateForRecovery = async () =>
		({
			salvaged: false,
			schemaErrors: [],
			revisionSalvageable: true,
			armedShapeUnreadable: false,
			state: { ...diskState, ...overrides },
		}) as unknown as Awaited<ReturnType<typeof realReadGate>>;
}

describe('lane markers and attribution', () => {
	test('F6 + artifact source: a lane with a real candidate row reports finding (never clean) with parsed id/severity/title', async () => {
		await establishReviewPrerequisites();
		const lanes = await runLanes();
		const row = rowOf(lanes, 'intent-architecture');
		expect(row.batchId).toBe('base-all');
		expect(row.phase).toBe('base');
		expect(row.itemCount).toBe(null);
		expect(row.artifactTruncated).toBe(false);
		expect(row.marker).toBe('finding');
		expect(row.marker).not.toBe('clean');
		expect(row.findings[0]).toEqual({
			id: 'C-0',
			severity: 'HIGH',
			title: 'claim',
		});
	});

	test('evidence-status marker: a lane with only a [CLEAN] artifact attestation reports clean', async () => {
		await establishReviewPrerequisites();
		const lanes = await runLanes();
		const row = rowOf(lanes, 'micro-lane-0');
		expect(row.batchId).toBe('micro-0');
		expect(row.phase).toBe('micro');
		expect(row.workflowLane).toBe('auth-identity-secrets');
		expect(row.itemCount).toBe(null);
		expect(row.marker).toBe('clean');
		expect(row.findings).toEqual([]);
	});

	test('F5: itemCount is the reviewItemIds count on validation rows and null on base/micro rows', async () => {
		await establishReviewPrerequisites();
		await stubGateState({
			prReviewValidationBatches: [
				{
					batchId: 'council-batch',
					phase: 'council',
					lanes: [
						{
							laneId: 'council-lane-a',
							workflowLane: 'intent-architecture',
							reviewItemIds: ['C-0', 'C-1'],
						},
						{ laneId: 'council-lane-b', workflowLane: 'correctness-contracts' },
					],
					validatedAt: new Date().toISOString(),
				},
			],
		});
		const lanes = await runLanes();
		expect(lanes.sourceState.validation).toBe('ok');
		const rowA = rowOf(lanes, 'council-lane-a');
		expect(rowA.phase).toBe('council');
		expect(rowA.batchId).toBe('council-batch');
		expect(rowA.itemCount).toBe(2);
		expect(rowOf(lanes, 'council-lane-b').itemCount).toBe(null);
		expect(rowOf(lanes, 'intent-architecture').itemCount).toBe(null);
	});

	test('N1: a dispatched lane with a completed read and no recorded evidence reports no-evidence, not clean', async () => {
		await establishReviewPrerequisites();
		await stubGateState({
			prReviewBaseDispatches: [
				{
					batchId: 'ghost-batch',
					lanes: [
						{ laneId: 'ghost-lane', workflowLane: 'intent-architecture' },
					],
					validatedAt: new Date().toISOString(),
				},
			],
		});
		const lanes = await runLanes();
		expect(lanes.sourceState.base).toBe('ok');
		const row = rowOf(lanes, 'ghost-lane');
		expect(row.marker).toBe('no-evidence');
		expect(row.findings).toEqual([]);
	});
});

describe('per-source degradation (R3-1)', () => {
	test('a corrupt trigger-eval receipt degrades only the micro source; the tool still returns with base rows', async () => {
		await establishReviewPrerequisites();
		const triggerAbsolute = path.join(
			tempDir,
			'.swarm',
			'pr-review',
			'test-run',
			'trigger-eval.json',
		);
		await fs.promises.writeFile(triggerAbsolute, 'corrupt', 'utf-8');
		const lanes = await runLanes();
		expect(lanes.sourceState.base).toBe('ok');
		expect(lanes.sourceState.micro).toBe('unavailable');
		expect(typeof lanes.sourceNotes.micro).toBe('string');
		expect((lanes.sourceNotes.micro ?? '').length).toBeGreaterThan(0);
		expect((lanes.sourceNotes.micro ?? '').length).toBeLessThanOrEqual(241);
		expect(rowOf(lanes, 'intent-architecture').marker).toBe('finding');
		expect(lanes.lanes.some((row) => row.laneId === 'micro-lane-0')).toBe(
			false,
		);
	});

	test('an uncertain delegation-store read is unknown-evidence, never an absence claim', async () => {
		await establishReviewPrerequisites();
		_internals.findByBatchIdDetailed = (() => ({
			status: 'uncertain',
			attempts: 2,
			reason: 'fixture-forced uncertain store',
		})) as unknown as typeof realFindByBatchId;
		try {
			const lanes = await runLanes();
			expect(lanes.sourceState.base).toBe('uncertain');
			expect(lanes.sourceState.micro).toBe('uncertain');
			const row = rowOf(lanes, 'intent-architecture');
			expect(row.marker).toBe('unknown-evidence');
			expect(row.findings).toEqual([]);
		} finally {
			_internals.findByBatchIdDetailed = realFindByBatchId;
		}
	});
});

describe('precedence and bounding', () => {
	test('P3-1: a lane with BOTH receipt findings and a [CLEAN] artifact reports finding (findings win)', async () => {
		await establishReviewPrerequisites();
		const lane = { laneId: 'base-mixed', workflowLane: 'intent-architecture' };
		await enforcePrReviewBaseDimensions(tempDir, SESSION_ID, [lane], {
			batchId: 'base-mixed',
			prHeadSha: HEAD_SHA,
			prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
		});
		await persistBatch('base-mixed', 'swarm-pr-review:base', [lane], {
			textOverride: [
				BASE_CANDIDATE_HEADER,
				'[CLEAN] | intent-architecture | exact reviewed diff | no finding after focused invariant review',
			].join('\n'),
		});
		await publishReceipt({
			batchId: 'base-mixed',
			laneId: 'base-mixed',
			workflowLane: 'intent-architecture',
			childSessionId: 'mixed-child',
			findings: [{ id: 'FIND-MIXED', workflowLane: 'intent-architecture' }],
		});
		const lanes = await runLanes();
		const row = rowOf(lanes, 'base-mixed');
		expect(row.marker).toBe('finding');
		expect(row.findings.some((f) => f.id === 'FIND-MIXED')).toBe(true);
		expect(row.findings[0].title).toBe('Envelope finding FIND-MIXED');
	});

	test('multi-finding envelope: per-lane findings are capped at 5 with an explicit truncation flag', async () => {
		// One consolidated tier-S lane owning all six base dimensions, so the
		// receipt envelope can legally carry one finding per owned lane (the
		// schema partitions creditedLanes exactly across ownedWorkflowLanes, and
		// tier L forbids consolidation on the initial wave).
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
		const originalDiffStats = _test_exports.resolvePrReviewDiffStats;
		_test_exports.resolvePrReviewDiffStats = () => ({
			changedLines: 10,
			changedFiles: 2,
			hasSubmoduleChange: false,
		});
		try {
			await bindPrReviewBase(tempDir, SESSION_ID, {
				prHeadSha: HEAD_SHA,
				baseRef: 'origin/main',
				baseSha: 'def456',
			});
		} finally {
			_test_exports.resolvePrReviewDiffStats = originalDiffStats;
		}
		const dimensions = PR_REVIEW_BASE_DIMENSION_IDS;
		const lane = {
			laneId: 'base-multi',
			workflowLane: dimensions[0],
			ownedWorkflowLanes: dimensions,
		};
		await enforcePrReviewBaseDimensions(tempDir, SESSION_ID, [lane], {
			batchId: 'base-multi',
			prHeadSha: HEAD_SHA,
			prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
		});
		await publishReceipt({
			batchId: 'base-multi',
			laneId: 'base-multi',
			workflowLane: dimensions[0],
			ownedWorkflowLanes: dimensions,
			childSessionId: 'multi-child',
			findings: dimensions.map((dimension, index) => ({
				id: `F-${index}`,
				workflowLane: dimension,
			})),
		});
		const lanes = await runLanes();
		const row = rowOf(lanes, 'base-multi');
		expect(row.marker).toBe('finding');
		expect(row.findings.length).toBe(5);
		expect(row.findings.map((f) => f.id)).toEqual([
			'F-0',
			'F-1',
			'F-2',
			'F-3',
			'F-4',
		]);
		expect(row.findingsTruncated).toBe(true);
	});

	test('P3-2: an artifact exceeding the parse bound is truncated at the bound with an explicit signal, and early rows still parse', async () => {
		await establishReviewPrerequisites();
		const lane = { laneId: 'base-huge', workflowLane: 'intent-architecture' };
		await enforcePrReviewBaseDimensions(tempDir, SESSION_ID, [lane], {
			batchId: 'base-huge',
			prHeadSha: HEAD_SHA,
			prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
		});
		const filler = Array.from({ length: 4000 }, () => 'f'.repeat(100)).join(
			'\n',
		);
		await persistBatch('base-huge', 'swarm-pr-review:base', [lane], {
			textOverride: [
				BASE_CANDIDATE_HEADER,
				'HUGE-0 | intent-architecture | HIGH | correctness | file.ts:1 | huge claim | evidence | impact | HIGH | ORDINARY | ',
				filler,
			].join('\n'),
		});
		const lanes = await runLanes();
		const row = rowOf(lanes, 'base-huge');
		expect(row.artifactTruncated).toBe(true);
		expect(row.marker).toBe('finding');
		expect(row.findings[0]?.id).toBe('HUGE-0');
	});

	test('lanes cap: 60 dispatched lanes project 50 rows with the full laneCount and lanesTruncated true', async () => {
		await establishReviewPrerequisites();
		await stubGateState({
			prReviewBaseDispatches: [
				{
					batchId: 'base-many',
					lanes: Array.from({ length: 60 }, (_v, i) => ({
						laneId: `many-lane-${i}`,
						workflowLane: 'intent-architecture',
					})),
					validatedAt: new Date().toISOString(),
				},
			],
		});
		const lanes = await runLanes();
		expect(lanes.lanes.length).toBe(50);
		// 60 stubbed base rows + the 11 real micro rows from the fixture.
		expect(lanes.laneCount).toBe(71);
		expect(lanes.lanesTruncated).toBe(true);
		expect(lanes.lanes[0]?.laneId).toBe('many-lane-0');
		expect(lanes.lanes.some((row) => row.laneId === 'many-lane-59')).toBe(
			false,
		);
	});
});
