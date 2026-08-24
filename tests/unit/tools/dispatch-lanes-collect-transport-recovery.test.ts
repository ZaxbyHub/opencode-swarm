import { afterEach, describe, expect, mock, test } from 'bun:test';
import { findByCorrelationId } from '../../../src/background/pending-delegations';
import { _test_exports as gateInternals } from '../../../src/hooks/pr-workflow-gate';
import {
	_internals,
	executeCollectLaneResults,
} from '../../../src/tools/dispatch-lanes';
import {
	BASE_HEADER,
	createCollectLaneTimeoutFixture,
} from './dispatch-lanes-collect-host-timeout.fixtures';

const {
	assistantMessage,
	baseOps,
	cleanupTempDirs,
	makeTempDir,
	recordPending,
	restoreInternals,
	withTestDeadline,
} = createCollectLaneTimeoutFixture();

afterEach(async () => {
	restoreInternals();
	await cleanupTempDirs();
});

describe('collect_lane_results transport recovery provenance', () => {
	test('persists and exposes truncated-preview durable-artifact recovery', async () => {
		const directory = makeTempDir();
		const batchId = 'truncated-preview-recovery';
		const correlationId = `${batchId}-session`;
		await recordPending({
			directory,
			batchId,
			correlationId,
			mode: 'swarm-pr-review:base',
			workflowLane: 'correctness-state',
			workspace: {
				directory,
				gitHead: 'head-1',
				dirtyHash: null,
				prHeadSha: 'head-1',
				scope: 'complete PR diff base-1...head-1',
			},
		});
		_internals.resolvePrWorkflowRevisionDigestAsync = async () => 'revision-1';
		const candidate = `${BASE_HEADER}\nC-1 | correctness-state | HIGH | correctness | src/state.ts:1 | invalid transition | direct state-machine evidence | user-visible corruption | HIGH${' '.repeat(20_000)}`;
		_internals.getSessionOps = () => ({
			...baseOps(),
			messages: mock(async () => ({ data: [assistantMessage(candidate)] })),
		});

		const result = await executeCollectLaneResults(
			{ batch_id: batchId, wait: false },
			directory,
		);

		expect(result.completed).toBe(1);
		expect(result.lane_results[0]?.output_truncated).toBe(true);
		expect(
			findByCorrelationId(directory, correlationId)?.result
				?.salvagedWorkflowLaneRecoveries,
		).toEqual([
			{
				workflowLane: 'correctness-state',
				kind: 'truncated-preview-durable-artifact',
				reason:
					'inline preview truncated; durable artifact retained exact coverage',
			},
		]);
		expect(result.lane_results[0]?.salvaged_workflow_lane_recoveries).toEqual([
			{
				workflow_lane: 'correctness-state',
				kind: 'truncated-preview-durable-artifact',
				reason:
					'inline preview truncated; durable artifact retained exact coverage',
			},
		]);
	});

	test('persists and exposes transcript-incomplete terminal-candidate recovery', async () => {
		const directory = makeTempDir();
		const batchId = 'incomplete-candidate-recovery';
		const correlationId = `${batchId}-session`;
		await recordPending({
			directory,
			batchId,
			correlationId,
			mode: 'swarm-pr-review:base',
			workflowLane: 'security-trust',
			workspace: {
				directory,
				gitHead: 'head-1',
				dirtyHash: null,
				prHeadSha: 'head-1',
				scope: 'complete PR diff base-1...head-1',
			},
		});
		_internals.resolvePrWorkflowRevisionDigestAsync = async () => 'revision-1';
		const candidate = `${BASE_HEADER}\nC-2 | security-trust | HIGH | security | src/auth.ts:1 | missing authorization | direct request-path evidence | privilege escalation | HIGH`;
		const paddingMessages = Array.from({ length: 49 }, () => ({
			info: { role: 'user' },
			parts: [{ type: 'text', text: 'prior prompt' }],
		}));
		_internals.getSessionOps = () => ({
			...baseOps(),
			messages: mock(async () => ({
				data: [assistantMessage(candidate), ...paddingMessages],
			})),
		});

		const result = await executeCollectLaneResults(
			{ batch_id: batchId, wait: false },
			directory,
		);

		expect(result.completed).toBe(1);
		expect(result.lane_results[0]?.transcript_incomplete).toBe(true);
		expect(
			findByCorrelationId(directory, correlationId)?.result
				?.salvagedWorkflowLaneRecoveries,
		).toEqual([
			{
				workflowLane: 'security-trust',
				kind: 'transcript-incomplete-terminal-candidate',
				reason:
					'partial transcript accepted only because a durable [CANDIDATE] row proved this lane',
			},
		]);
		expect(result.lane_results[0]?.salvaged_workflow_lane_recoveries).toEqual([
			{
				workflow_lane: 'security-trust',
				kind: 'transcript-incomplete-terminal-candidate',
				reason:
					'partial transcript accepted only because a durable [CANDIDATE] row proved this lane',
			},
		]);
	});

	test.each([
		'length',
		'content-filter',
	])('salvages terminal candidates cut short by finish=%s', async (finish) => {
		const directory = makeTempDir();
		const batchId = `cut-short-candidate-${finish}`;
		const correlationId = `${batchId}-session`;
		await recordPending({
			directory,
			batchId,
			correlationId,
			mode: 'swarm-pr-review:base',
			workflowLane: 'security-trust',
			workspace: {
				directory,
				gitHead: 'head-1',
				dirtyHash: null,
				prHeadSha: 'head-1',
				scope: 'complete PR diff base-1...head-1',
			},
		});
		_internals.resolvePrWorkflowRevisionDigestAsync = async () => 'revision-1';
		const candidate = `${BASE_HEADER}\nC-3 | security-trust | HIGH | security | src/auth.ts:2 | incomplete authorization | direct request-path evidence | privilege escalation | HIGH`;
		_internals.getSessionOps = () => ({
			...baseOps(),
			messages: mock(async () => ({
				data: [assistantMessage(candidate, { finish })],
			})),
		});

		const result = await executeCollectLaneResults(
			{ batch_id: batchId, wait: false },
			directory,
		);

		expect(result.completed).toBe(1);
		expect(result.lane_results[0]?.transcript_incomplete).toBe(true);
		expect(
			findByCorrelationId(directory, correlationId)?.result
				?.salvagedWorkflowLaneRecoveries,
		).toEqual([
			{
				workflowLane: 'security-trust',
				kind: 'transcript-incomplete-terminal-candidate',
				reason:
					'partial transcript accepted only because a durable [CANDIDATE] row proved this lane',
			},
		]);
	});

	test.each([
		'length',
		'content-filter',
	])('rejects CLEAN attestations cut short by finish=%s when readiness is idle', async (finish) => {
		const directory = makeTempDir();
		const batchId = `cut-short-clean-${finish}`;
		const correlationId = `${batchId}-session`;
		await recordPending({
			directory,
			batchId,
			correlationId,
			mode: 'swarm-pr-review:base',
			workflowLane: 'security-trust',
			workspace: {
				directory,
				gitHead: 'head-1',
				dirtyHash: null,
				prHeadSha: 'head-1',
				scope: 'complete PR diff base-1...head-1',
			},
		});
		_internals.resolvePrWorkflowRevisionDigestAsync = async () => 'revision-1';
		const clean =
			'[CLEAN] | security-trust | complete PR diff base-1...head-1 | no finding after focused invariant review';
		_internals.getSessionOps = () => ({
			...baseOps(),
			status: mock(async () => ({
				data: { [correlationId]: { type: 'idle' } },
			})),
			messages: mock(async () => ({
				data: [assistantMessage(clean, { finish })],
			})),
		});

		const result = await executeCollectLaneResults(
			{ batch_id: batchId, wait: false },
			directory,
		);

		expect(result.failed).toBe(1);
		expect(result.lane_results[0]?.status).toBe('failed');
		expect(result.lane_results[0]?.transcript_incomplete).toBe(true);
		expect(result.lane_results[0]?.error).toContain(
			'result.transcript_incomplete',
		);
	});

	test('bounds a hung revision digest and still collects a later PR lane', async () => {
		const directory = makeTempDir();
		const batchId = 'hung-digest-fair-share';
		for (const [laneId, workflowLane] of [
			['lane-a', 'correctness-state'],
			['lane-b', 'security-trust'],
		] as const) {
			await recordPending({
				directory,
				batchId,
				laneId,
				correlationId: `${laneId}-session`,
				mode: 'swarm-pr-review:base',
				workflowLane,
				workspace: {
					directory,
					gitHead: 'head-1',
					dirtyHash: null,
					prHeadSha: 'head-1',
					scope: 'complete PR diff base-1...head-1',
				},
			});
		}
		let digestCalls = 0;
		let resolveHungDigest: ((digest: string) => void) | undefined;
		_internals.resolvePrWorkflowRevisionDigestAsync = mock(async () => {
			digestCalls++;
			if (digestCalls === 1) {
				return new Promise<string>((resolve) => {
					resolveHungDigest = resolve;
				});
			}
			return 'revision-1';
		});
		_internals.getSessionOps = () => ({
			...baseOps(),
			messages: mock(async ({ path }) => {
				const workflowLane =
					path.id === 'lane-a-session' ? 'correctness-state' : 'security-trust';
				const candidate = `${BASE_HEADER}\nC-${workflowLane} | ${workflowLane} | HIGH | correctness | src/state.ts:1 | invalid transition | direct state evidence | user-visible corruption | HIGH`;
				return { data: [assistantMessage(candidate)] };
			}),
		});

		const result = await withTestDeadline(
			executeCollectLaneResults(
				{
					batch_id: batchId,
					wait: false,
					include_pending: true,
					timeout_ms: 25,
				},
				directory,
			),
		);

		expect(digestCalls).toBe(2);
		expect(result.completed).toBe(1);
		expect(result.pending).toBe(1);
		expect(
			result.lane_results.find((lane) => lane.id === 'lane-a')?.status,
		).toBe('pending');
		expect(
			result.lane_results.find((lane) => lane.id === 'lane-b')?.status,
		).toBe('completed');
		expect(result.errors?.join('; ')).toContain('revision digest for lane');

		resolveHungDigest?.('late-revision');
		await Promise.resolve();
		await Promise.resolve();
		expect(findByCorrelationId(directory, 'lane-a-session')?.status).toBe(
			'pending',
		);
	});

	test('fails incomplete council candidates consistently through collection and gate validation', async () => {
		const directory = makeTempDir();
		const batchId = 'incomplete-council';
		const correlationId = `${batchId}-session`;
		const workflowLane = 'correctness-state';
		await recordPending({
			directory,
			batchId,
			correlationId,
			mode: 'swarm-pr-review:council',
			workflowLane,
			workspace: {
				directory,
				gitHead: 'head-1',
				dirtyHash: null,
				prHeadSha: 'head-1',
				scope: 'complete PR diff base-1...head-1',
			},
		});
		_internals.resolvePrWorkflowRevisionDigestAsync = async () => 'revision-1';
		const candidate = [
			'[CANDIDATE] | candidate_id | micro_lane | severity | category | file:line | claim | invariant_violated | evidence_summary | confidence',
			`C-C | ${workflowLane} | HIGH | correctness | src/state.ts:1 | invalid transition | STATE_INVARIANT | direct state evidence | HIGH`,
		].join('\n');
		_internals.getSessionOps = () => ({
			...baseOps(),
			status: mock(async () => ({
				data: { [correlationId]: { type: 'idle' } },
			})),
			messages: mock(async () => ({
				data: [assistantMessage(candidate, { finish: 'length' })],
			})),
		});

		const result = await executeCollectLaneResults(
			{ batch_id: batchId, wait: false },
			directory,
		);
		const record = findByCorrelationId(directory, correlationId)!;
		const analyses = gateInternals.analyzePrReviewBatchRecordIntegrity({
			batchId,
			expectedLanes: [{ laneId: `${batchId}-lane`, workflowLane }],
			expectedMode: 'swarm-pr-review:council',
			validatedAt: new Date(0).toISOString(),
			checkWorkflowLane: true,
			forbiddenSubagentSessionIds: new Set(),
			records: [record],
			expectedPrHeadSha: 'head-1',
		});

		expect(result.failed).toBe(1);
		expect(result.lane_results[0]?.status).toBe('failed');
		expect(result.lane_results[0]?.error).toContain(
			'result.transcript_incomplete',
		);
		expect(analyses[0]?.ok).toBe(false);
		if (!analyses[0]?.ok) {
			expect(analyses[0]?.failure.predicate).toBe('record.status');
		}
	});
});
