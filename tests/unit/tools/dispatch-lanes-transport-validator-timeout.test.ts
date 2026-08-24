import { afterEach, describe, expect, mock, test } from 'bun:test';
import { findByCorrelationId } from '../../../src/background/pending-delegations.js';
import {
	_internals,
	executeCollectLaneResults,
} from '../../../src/tools/dispatch-lanes.js';
import { createCollectLaneTimeoutFixture } from './dispatch-lanes-collect-host-timeout.fixtures';

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

describe('collect_lane_results — regression: transport-validator deadline remains bounded', () => {
	test('bounds a hung transport validator and still collects a later lane', async () => {
		// Prior bug: an unbounded transport validator await could stall the whole batch after messages were already readable.
		const directory = makeTempDir();
		const batchId = 'hung-transport-validator';
		await recordPending({
			directory,
			batchId,
			laneId: 'review-lane',
			correlationId: 'review-lane-session',
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
		await recordPending({
			directory,
			batchId,
			laneId: 'advisory-lane',
			correlationId: 'advisory-lane-session',
		});
		let resolveValidator: (() => void) | undefined;
		_internals.resolvePrWorkflowRevisionDigestAsync = async () => 'revision-1';
		_internals.validatePrWorkflowTransportRecovery = mock(
			async ({ record }) => {
				if (record.laneId === 'review-lane') {
					return new Promise((resolve) => {
						resolveValidator = () => resolve({ ok: true });
					});
				}
				return { ok: true };
			},
		);
		_internals.getSessionOps = () => ({
			...baseOps(),
			messages: mock(async ({ path }) => ({
				data:
					path.id === 'review-lane-session'
						? [
								assistantMessage(
									`[REVIEWED] | R-1 | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale | probe | reviewer ${'x'.repeat(21_000)}`,
								),
							]
						: [assistantMessage('later advisory output')],
			})),
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

		expect(result.completed).toBe(1);
		expect(result.pending).toBe(1);
		expect(
			result.lane_results.find((lane) => lane.id === 'advisory-lane')?.status,
		).toBe('completed');
		expect(
			result.lane_results.find((lane) => lane.id === 'review-lane')?.status,
		).toBe('pending');
		expect(result.errors?.join('; ')).toContain(
			'transport recovery validation for lane "review-lane"',
		);

		resolveValidator?.();
		await Promise.resolve();
		await Promise.resolve();
		expect(findByCorrelationId(directory, 'review-lane-session')?.status).toBe(
			'pending',
		);
	});

	test('fails closed when the transport validator throws without rejecting the batch', async () => {
		// Prior bug: validator/state-read throws escaped Promise.all settlement and rejected collection instead of failing one lane.
		const directory = makeTempDir();
		const batchId = 'throwing-transport-validator';
		await recordPending({
			directory,
			batchId,
			laneId: 'review-lane',
			correlationId: 'review-lane-session',
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
		await recordPending({
			directory,
			batchId,
			laneId: 'advisory-lane',
			correlationId: 'advisory-lane-session',
		});
		_internals.resolvePrWorkflowRevisionDigestAsync = async () => 'revision-1';
		_internals.validatePrWorkflowTransportRecovery = mock(
			async ({ record }) => {
				if (record.laneId === 'review-lane') {
					throw new Error('gate state unreadable');
				}
				return { ok: true };
			},
		);
		_internals.getSessionOps = () => ({
			...baseOps(),
			messages: mock(async ({ path }) => ({
				data:
					path.id === 'review-lane-session'
						? [
								assistantMessage(
									`[REVIEWED] | R-1 | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale | probe | reviewer ${'x'.repeat(21_000)}`,
								),
							]
						: [assistantMessage('later advisory output')],
			})),
		});

		const result = await executeCollectLaneResults(
			{
				batch_id: batchId,
				wait: false,
				include_pending: true,
				timeout_ms: 90,
			},
			directory,
		);

		expect(result.completed).toBe(1);
		expect(result.failed).toBe(1);
		expect(
			result.lane_results.find((lane) => lane.id === 'advisory-lane')?.status,
		).toBe('completed');
		expect(
			result.lane_results.find((lane) => lane.id === 'review-lane'),
		).toMatchObject({
			status: 'failed',
		});
		expect(
			result.lane_results.find((lane) => lane.id === 'review-lane')?.error,
		).toContain('gate state unreadable');
		expect(findByCorrelationId(directory, 'review-lane-session')?.status).toBe(
			'error',
		);
	});
});
