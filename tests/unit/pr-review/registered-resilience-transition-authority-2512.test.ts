import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { DEFAULT_PR_REVIEW_RESILIENCE_CONFIG } from '../../../src/config/schema.js';
import {
	activatePrWorkflow,
	bindPrReviewBase,
	enforcePrReviewBaseDimensions,
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
	readPrWorkflowGateState,
	rollbackPrReviewBaseAdmissionIfUnlaunched,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	withSessionStateMutation,
	writeStateWhileLocked,
} from '../../../src/pr-review/persistence.js';
import {
	HEAD_SHA,
	PR_REVIEW_BASE_SHA,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from '../hooks/pr-workflow-gate.test-fixtures.js';

const originalDiffStats = gateInternals.resolvePrReviewDiffStats;
const originalRevisionDigest = gateInternals.resolvePrWorkflowRevisionDigest;
const originalNowMs = gateInternals.nowMs;

beforeEach(setupPrWorkflowGateFixtures);

afterEach(async () => {
	gateInternals.resolvePrReviewDiffStats = originalDiffStats;
	gateInternals.resolvePrWorkflowRevisionDigest = originalRevisionDigest;
	gateInternals.nowMs = originalNowMs;
	await teardownPrWorkflowGateFixtures();
});

function baseLane(laneId = 'base-lane-2512') {
	return {
		laneId,
		workflowLane: PR_REVIEW_BASE_DIMENSION_IDS[0]!,
	};
}

async function bindWorkflow(): Promise<
	NonNullable<Awaited<ReturnType<typeof readPrWorkflowGateState>>>
> {
	await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
	gateInternals.resolvePrWorkflowRevisionDigest = () => 'e'.repeat(64);
	gateInternals.resolvePrReviewDiffStats = () => ({
		changedLines: 12,
		changedFiles: 2,
		hasSubmoduleChange: false,
	});
	await bindPrReviewBase(tempDir, SESSION_ID, {
		prHeadSha: HEAD_SHA,
		baseRef: 'origin/main',
		baseSha: PR_REVIEW_BASE_SHA,
	});
	const state = await readPrWorkflowGateState(tempDir, SESSION_ID);
	if (!state) throw new Error('workflow binding was not persisted');
	return state;
}

describe('registered resilience transition outcomes (#2512)', () => {
	test('staged admission persists the circuit advance attempt and a same-generation blocked retry does not mutate it', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
		gateInternals.resolvePrReviewDiffStats = () => ({
			changedLines: 2_000,
			changedFiles: 60,
			hasSubmoduleChange: false,
		});
		await bindPrReviewBase(tempDir, SESSION_ID, {
			prHeadSha: HEAD_SHA,
			baseRef: 'origin/main',
			baseSha: PR_REVIEW_BASE_SHA,
		});
		const policy = {
			...DEFAULT_PR_REVIEW_RESILIENCE_CONFIG,
			enabled: true,
		};
		const canary = {
			laneId: 'advance-canary-2512',
			workflowLane: PR_REVIEW_BASE_DIMENSION_IDS[0]!,
		};
		const advanced = await enforcePrReviewBaseDimensions(
			tempDir,
			SESSION_ID,
			[canary],
			{
				batchId: 'advance-batch-2512',
				prHeadSha: HEAD_SHA,
				prReviewWaveStage: 'canary',
				prReviewWaveAttempt: 0,
				prReviewResiliencePolicy: policy,
			},
		);
		expect(advanced.prReviewResilience?.attempts).toHaveLength(1);
		expect(advanced.prReviewResilience?.attempts[0]).toMatchObject({
			attempt: 0,
			canaryBatchId: 'advance-batch-2512',
			canaryLaneId: canary.laneId,
		});
		const revision = advanced.revision;

		await expect(
			enforcePrReviewBaseDimensions(
				tempDir,
				SESSION_ID,
				[{ ...canary, laneId: 'advance-retry-2512' }],
				{
					batchId: 'advance-retry-batch-2512',
					prHeadSha: HEAD_SHA,
					prReviewWaveStage: 'canary',
					prReviewWaveAttempt: 0,
					prReviewResiliencePolicy: policy,
				},
			),
		).rejects.toThrow('canary is not yet proven successful');
		gateInternals.resetTrackedStateCache();
		const replay = await readPrWorkflowGateState(tempDir, SESSION_ID);
		expect(replay?.revision).toBe(revision);
		expect(replay?.prReviewResilience?.attempts).toHaveLength(1);
	});

	test('unlaunched HALF_OPEN probe rollback settles the registered circuit; stale and replay stay unchanged', async () => {
		await bindWorkflow();
		const policy = {
			...DEFAULT_PR_REVIEW_RESILIENCE_CONFIG,
			enabled: true,
		};
		await enforcePrReviewBaseDimensions(tempDir, SESSION_ID, [baseLane()], {
			batchId: 'probe-seed-2512',
			prHeadSha: HEAD_SHA,
			prReviewResiliencePolicy: policy,
		});
		await withSessionStateMutation(tempDir, SESSION_ID, async () => {
			const current = await readPrWorkflowGateState(tempDir, SESSION_ID);
			if (!current?.prReviewResilience) {
				throw new Error('expected resilience state before probe seeding');
			}
			await writeStateWhileLocked(tempDir, {
				...current,
				prReviewDepthTier: 'L',
				prReviewDiffStats: {
					changedLines: 2_000,
					changedFiles: 60,
					hasSubmoduleChange: false,
				},
				prReviewResilience: {
					...current.prReviewResilience,
					circuit: {
						version: 2,
						state: 'OPEN',
						generation: 2,
						contributors: [],
						openedAt: '2026-09-01T00:00:00.000Z',
						openUntil: '2026-09-01T00:01:00.000Z',
					},
				},
			});
		});
		gateInternals.resolvePrReviewDiffStats = () => ({
			changedLines: 2_000,
			changedFiles: 60,
			hasSubmoduleChange: false,
		});
		gateInternals.nowMs = () => Date.parse('2026-09-01T00:02:00.000Z');
		const probeLane = {
			laneId: 'probe-lane-2512',
			workflowLane: PR_REVIEW_BASE_DIMENSION_IDS[1]!,
		};
		const admitted = await enforcePrReviewBaseDimensions(
			tempDir,
			SESSION_ID,
			[probeLane],
			{
				batchId: 'probe-admission-2512',
				prHeadSha: HEAD_SHA,
				prReviewWaveStage: 'canary',
				prReviewWaveAttempt: 0,
				prReviewResiliencePolicy: policy,
			},
		);
		expect(admitted.prReviewResilience?.circuit).toMatchObject({
			state: 'HALF_OPEN',
			generation: 2,
			probe: { batchId: 'probe-admission-2512', laneId: probeLane.laneId },
		});
		const staleSnapshot = JSON.stringify(admitted);
		expect(
			await rollbackPrReviewBaseAdmissionIfUnlaunched(
				tempDir,
				SESSION_ID,
				'not-the-probe-2512',
			),
		).toBe(false);
		gateInternals.resetTrackedStateCache();
		expect(
			JSON.stringify(await readPrWorkflowGateState(tempDir, SESSION_ID)),
		).toBe(staleSnapshot);

		expect(
			await rollbackPrReviewBaseAdmissionIfUnlaunched(
				tempDir,
				SESSION_ID,
				'probe-admission-2512',
			),
		).toBe(true);
		gateInternals.resetTrackedStateCache();
		const settled = await readPrWorkflowGateState(tempDir, SESSION_ID);
		expect(settled?.prReviewBaseDispatches?.at(-1)?.batchId).toBe(
			'probe-seed-2512',
		);
		expect(settled?.prReviewResilience?.attempts).toEqual([]);
		expect(settled?.prReviewResilience?.circuit).toEqual({
			version: 2,
			state: 'OPEN',
			generation: 2,
			contributors: [],
			openedAt: '2026-09-01T00:00:00.000Z',
			openUntil: '2026-09-01T00:03:00.000Z',
		});
		const replaySnapshot = JSON.stringify(settled);
		expect(
			await rollbackPrReviewBaseAdmissionIfUnlaunched(
				tempDir,
				SESSION_ID,
				'probe-admission-2512',
			),
		).toBe(false);
		gateInternals.resetTrackedStateCache();
		expect(
			JSON.stringify(await readPrWorkflowGateState(tempDir, SESSION_ID)),
		).toBe(replaySnapshot);
	});

	test('same disabled policy preserves resilience state while a new batch admission still persists', async () => {
		await bindWorkflow();
		const enabled = {
			...DEFAULT_PR_REVIEW_RESILIENCE_CONFIG,
			enabled: true,
		};
		await enforcePrReviewBaseDimensions(tempDir, SESSION_ID, [baseLane()], {
			batchId: 'config-enabled-2512',
			prHeadSha: HEAD_SHA,
			prReviewResiliencePolicy: enabled,
		});
		await withSessionStateMutation(tempDir, SESSION_ID, async () => {
			const current = await readPrWorkflowGateState(tempDir, SESSION_ID);
			if (!current?.prReviewResilience) {
				throw new Error('expected resilience state before config replay');
			}
			await writeStateWhileLocked(tempDir, {
				...current,
				prReviewResilience: {
					...current.prReviewResilience,
					circuit: {
						version: 2,
						state: 'CLOSED',
						generation: 4,
						contributors: [],
						evidenceWaterline: '2026-09-01T00:00:00.000Z',
					},
				},
			});
		});
		const disabled = { ...enabled, enabled: false };
		const changed = await enforcePrReviewBaseDimensions(
			tempDir,
			SESSION_ID,
			[baseLane('config-disabled-2512')],
			{
				batchId: 'config-disabled-2512',
				prHeadSha: HEAD_SHA,
				prReviewResiliencePolicy: disabled,
			},
		);
		expect(changed.prReviewResilience?.policy.enabled).toBe(false);
		const revision = changed.revision;
		const resilienceBeforeReplay = changed.prReviewResilience;
		const next = await enforcePrReviewBaseDimensions(
			tempDir,
			SESSION_ID,
			[baseLane('config-replay-2512')],
			{
				batchId: 'config-replay-2512',
				prHeadSha: HEAD_SHA,
				prReviewResiliencePolicy: disabled,
			},
		);
		expect(next.prReviewResilience?.policy.enabled).toBe(false);
		expect(next.revision).toBeGreaterThan(revision);
		expect(next.prReviewResilience?.policy).toEqual(
			resilienceBeforeReplay?.policy,
		);
		expect(next.prReviewResilience?.circuit).toEqual(
			resilienceBeforeReplay?.circuit,
		);
		expect(next.prReviewResilience?.circuit?.generation).toBe(4);
		expect(next.prReviewResilience?.attempts).toEqual(
			resilienceBeforeReplay?.attempts,
		);
		expect(next.prReviewBaseDispatches?.at(-1)?.batchId).toBe(
			'config-replay-2512',
		);
	});
});
