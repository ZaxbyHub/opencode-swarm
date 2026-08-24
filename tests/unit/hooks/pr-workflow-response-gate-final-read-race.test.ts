import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { _test_exports as autoWakeInternals } from '../../../src/hooks/pr-workflow-auto-wake.js';
import { _test_exports as workflowInternals } from '../../../src/hooks/pr-workflow-gate.js';
import { _internals as responseGateInternals } from '../../../src/hooks/pr-workflow-response-gate.js';
import {
	FakeScheduler,
	makeRecoveryRaceGate,
	originalReadPrWorkflowGateState,
} from './pr-workflow-response-gate-recovery-race-helpers.js';
import {
	idleEventFor,
	makeTempDir,
	writeStateWithRevision,
} from './pr-workflow-response-gate-test-helpers.js';

let directory = '';

beforeEach(() => {
	directory = makeTempDir('pr-response-gate-final-read-race-');
	responseGateInternals.readPrWorkflowGateState =
		originalReadPrWorkflowGateState;
	workflowInternals.resetTrackedStateCache();
	autoWakeInternals.reset();
});

afterEach(async () => {
	responseGateInternals.readPrWorkflowGateState =
		originalReadPrWorkflowGateState;
	workflowInternals.resetTrackedStateCache();
	autoWakeInternals.reset();
	await fs.rm(directory, { recursive: true, force: true });
});

describe('PR workflow response-gate final durable-read races', () => {
	test('defers when parent tool activity lands during the final pre-prompt durable read', async () => {
		const scheduler = new FakeScheduler();
		const promptAsync = mock(async () => ({}));
		const gate = makeRecoveryRaceGate(
			directory,
			scheduler,
			promptAsync,
			async () => ({
				data: { 'race-final-read-session': { type: 'idle' } },
			}),
		);
		await writeStateWithRevision(directory, 'race-final-read-session', 0);
		const durableState = await originalReadPrWorkflowGateState(
			directory,
			'race-final-read-session',
		);
		let releaseFinalRead!: () => void;
		const blockedFinalRead = new Promise<typeof durableState>((resolve) => {
			releaseFinalRead = () => resolve(durableState);
		});
		let readCount = 0;
		responseGateInternals.readPrWorkflowGateState = mock(async () => {
			readCount += 1;
			return readCount === 3 ? blockedFinalRead : durableState;
		}) as typeof responseGateInternals.readPrWorkflowGateState;

		const idlePromise = gate.event(idleEventFor('race-final-read-session'));
		await Promise.resolve();
		await gate.event({
			event: {
				type: 'message.part.updated',
				properties: {
					part: {
						type: 'tool',
						id: 'tool-final-race',
						sessionID: 'race-final-read-session',
						state: { status: 'running' },
					},
				},
			},
		});
		releaseFinalRead();
		await idlePromise;

		expect(promptAsync).not.toHaveBeenCalled();
		expect(
			gate._inspectBoundaryActivity('race-final-read-session'),
		).toMatchObject({
			activeToolPartCount: 1,
			hasTimer: true,
		});

		await gate.event({
			event: {
				type: 'message.part.updated',
				properties: {
					part: {
						type: 'tool',
						id: 'tool-final-race',
						sessionID: 'race-final-read-session',
						state: { status: 'completed' },
					},
				},
			},
		});

		await scheduler.advance(9);
		expect(promptAsync).not.toHaveBeenCalled();
		await scheduler.advance(20);
		expect(promptAsync).toHaveBeenCalledTimes(1);
		expect(
			gate._inspectBoundaryActivity('race-final-read-session'),
		).toMatchObject({
			activeToolPartCount: 0,
			hasTimer: false,
		});
	});

	test('fails closed when the session is removed during the final pre-prompt durable read', async () => {
		const scheduler = new FakeScheduler();
		const promptAsync = mock(async () => ({}));
		const gate = makeRecoveryRaceGate(
			directory,
			scheduler,
			promptAsync,
			async () => ({
				data: { 'race-removed-final-read-session': { type: 'idle' } },
			}),
		);
		await writeStateWithRevision(
			directory,
			'race-removed-final-read-session',
			0,
		);
		const durableState = await originalReadPrWorkflowGateState(
			directory,
			'race-removed-final-read-session',
		);
		let releaseFinalRead!: () => void;
		let markFinalReadStarted!: () => void;
		const finalReadStarted = new Promise<void>((resolve) => {
			markFinalReadStarted = resolve;
		});
		const blockedFinalRead = new Promise<typeof durableState>((resolve) => {
			releaseFinalRead = () => resolve(durableState);
		});
		let readCount = 0;
		responseGateInternals.readPrWorkflowGateState = mock(async () => {
			readCount += 1;
			if (readCount === 3) {
				markFinalReadStarted();
				return blockedFinalRead;
			}
			return durableState;
		}) as typeof responseGateInternals.readPrWorkflowGateState;

		const idlePromise = gate.event(
			idleEventFor('race-removed-final-read-session'),
		);
		await finalReadStarted;
		await gate.event({
			event: {
				type: 'session.removed',
				properties: { sessionID: 'race-removed-final-read-session' },
			},
		});
		releaseFinalRead();
		await idlePromise;

		expect(promptAsync).not.toHaveBeenCalled();
		expect(
			autoWakeInternals.getPluginWakeMarkerCount(
				directory,
				'race-removed-final-read-session',
			),
		).toBe(0);
		expect(
			gate._inspectBoundaryActivity('race-removed-final-read-session'),
		).toBeUndefined();
	});
});
