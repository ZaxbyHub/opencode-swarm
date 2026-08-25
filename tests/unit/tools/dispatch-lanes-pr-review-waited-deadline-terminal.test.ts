import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
	type BackgroundDelegationRecord,
	findByCorrelationId,
} from '../../../src/background/pending-delegations.js';
import {
	_internals,
	executeCollectLaneResults,
} from '../../../src/tools/dispatch-lanes.js';
import { createCollectLaneTimeoutFixture } from './dispatch-lanes-collect-host-timeout.fixtures.js';

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

function settledRecord(
	directory: string,
	correlationId: string,
): BackgroundDelegationRecord {
	const record = findByCorrelationId(directory, correlationId);
	if (!record) throw new Error(`missing delegation record ${correlationId}`);
	return record;
}

describe('collect_lane_results waited PR-review deadline terminalization (#2333)', () => {
	test('wait:true timeout_ms:0 terminalizes an active PR-review lane locally without host calls', async () => {
		const directory = makeTempDir();
		const batchId = 'review-zero-budget';
		const correlationId = `${batchId}-session`;
		await recordPending({
			directory,
			batchId,
			correlationId,
			mode: 'swarm-pr-review:base',
			workflowLane: 'intent-architecture',
			workspace: {
				directory,
				gitHead: 'head-1',
				dirtyHash: null,
				prHeadSha: 'head-1',
				scope: 'complete PR diff base-1...head-1',
			},
		});
		const status = mock(async () => ({ data: null }));
		const messages = mock(async () => ({
			data: [
				assistantMessage('ignored because the zero budget forbids host reads'),
			],
		}));
		const abort = mock(async () => undefined);
		_internals.getSessionOps = () => ({
			...baseOps(),
			status,
			messages,
			abort,
		});

		const result = await withTestDeadline(
			executeCollectLaneResults(
				{
					batch_id: batchId,
					wait: true,
					include_pending: true,
					timeout_ms: 0,
				},
				directory,
			),
		);

		expect(status).toHaveBeenCalledTimes(0);
		expect(messages).toHaveBeenCalledTimes(0);
		expect(abort).toHaveBeenCalledTimes(0);
		expect(result.pending).toBe(0);
		expect(result.failed).toBe(1);
		expect(result.lane_results[0]?.status).toBe('failed');
		expect(result.lane_results[0]?.error).toContain(
			'PR_REVIEW_COLLECTION_DEADLINE_EXCEEDED',
		);
		expect(result.lane_results[0]?.error).toContain(
			'salvage_skipped=no_budget',
		);

		const record = settledRecord(directory, correlationId);
		expect(record.status).toBe('error');
		expect(record.result?.error).toContain(
			'PR_REVIEW_COLLECTION_DEADLINE_EXCEEDED',
		);
	});

	test('wait:true terminalizes PR-review locally when the host messages client is unavailable', async () => {
		const directory = makeTempDir();
		const batchId = 'review-no-client';
		const correlationId = `${batchId}-session`;
		await recordPending({
			directory,
			batchId,
			correlationId,
			mode: 'swarm-pr-review:base',
			workflowLane: 'intent-architecture',
		});
		_internals.getSessionOps = () => null;

		const result = await executeCollectLaneResults(
			{ batch_id: batchId, wait: true, timeout_ms: 0 },
			directory,
		);

		expect(result.pending).toBe(0);
		expect(result.failed).toBe(1);
		expect(result.errors).toEqual([
			'OpenCode session messages client is not available',
		]);
		expect(settledRecord(directory, correlationId).status).toBe('error');
	});

	test('no-client behavior remains fail-closed for a non-review waited batch', async () => {
		const directory = makeTempDir();
		const batchId = 'advisory-no-client';
		await recordPending({ directory, batchId, mode: 'advisory' });
		_internals.getSessionOps = () => null;

		const result = await executeCollectLaneResults(
			{ batch_id: batchId, wait: true, timeout_ms: 0 },
			directory,
		);

		expect(result.failure_class).toBe('no_client');
		expect(findByCorrelationId(directory, `${batchId}-session`)?.status).toBe(
			'pending',
		);
	});

	test('wait:true can salvage a terminal candidate transcript yet still ends in error after the deadline', async () => {
		const directory = makeTempDir();
		const batchId = 'review-partial-salvage';
		const correlationId = `${batchId}-session`;
		await recordPending({
			directory,
			batchId,
			correlationId,
			mode: 'swarm-pr-review:base',
			workflowLane: 'intent-architecture',
			workspace: {
				directory,
				gitHead: 'head-1',
				dirtyHash: null,
				prHeadSha: 'head-1',
				scope: 'complete PR diff base-1...head-1',
			},
		});
		_internals.resolvePrWorkflowRevisionDigestAsync = async () => 'revision-1';
		const status = mock(() => new Promise<never>(() => {}));
		const messages = mock(async () => ({
			data: [
				assistantMessage(
					'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence\nC-0 | intent-architecture | HIGH | correctness | file.ts:1 | claim | evidence | impact | HIGH',
					{
						time: undefined,
						finish: 'stop',
					},
				),
			],
		}));
		_internals.getSessionOps = () => ({ ...baseOps(), status, messages });

		const result = await withTestDeadline(
			executeCollectLaneResults(
				{
					batch_id: batchId,
					wait: true,
					include_pending: true,
					timeout_ms: 25,
				},
				directory,
			),
		);

		expect(result.pending).toBe(0);
		expect(result.failed).toBe(1);
		expect(result.lane_results[0]?.status).toBe('failed');
		expect(result.lane_results[0]?.error).toContain(
			'PR_REVIEW_COLLECTION_DEADLINE_EXCEEDED',
		);
		expect(result.lane_results[0]?.output_ref).toMatch(/^L1:/);
		expect(result.lane_results[0]?.transcript_incomplete).toBe(true);
		expect(result.lane_results[0]?.salvaged_workflow_lanes).toEqual([
			'intent-architecture',
		]);
		expect(result.lane_results[0]?.accepted_review_item_ids).toBeUndefined();
	});

	test('a late transport-validator resolution cannot recover a lane after waited deadline terminalization', async () => {
		const directory = makeTempDir();
		const batchId = 'review-late-validator';
		const correlationId = `${batchId}-session`;
		await recordPending({
			directory,
			batchId,
			correlationId,
			mode: 'swarm-pr-review:reviewer',
			workflowLane: 'review-lane',
			workspace: {
				directory,
				gitHead: 'head-1',
				dirtyHash: null,
				prHeadSha: 'head-1',
				scope: 'complete PR diff base-1...head-1',
			},
		});
		let resolveValidator: (() => void) | undefined;
		_internals.resolvePrWorkflowRevisionDigestAsync = async () => 'revision-1';
		_internals.validatePrWorkflowTransportRecovery = mock(async () => {
			return new Promise((resolve) => {
				resolveValidator = () => resolve({ ok: true });
			});
		});
		const status = mock(() => new Promise<never>(() => {}));
		const messages = mock(async () => ({
			data: [
				assistantMessage(
					'[REVIEWED] | R-1 | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale | probe | reviewer',
					{
						time: undefined,
						finish: 'stop',
					},
				),
			],
		}));
		_internals.getSessionOps = () => ({ ...baseOps(), status, messages });

		const result = await withTestDeadline(
			executeCollectLaneResults(
				{
					batch_id: batchId,
					wait: true,
					include_pending: true,
					timeout_ms: 25,
				},
				directory,
			),
		);

		expect(result.failed).toBe(1);
		expect(result.lane_results[0]?.status).toBe('failed');
		expect(result.lane_results[0]?.error).toContain(
			'transport recovery validation',
		);
		expect(settledRecord(directory, correlationId).status).toBe('error');

		resolveValidator?.();
		await Promise.resolve();
		await Promise.resolve();
		expect(settledRecord(directory, correlationId).status).toBe('error');
	});
});
