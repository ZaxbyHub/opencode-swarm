import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { _test_exports as autoWakeInternals } from '../../../src/hooks/pr-workflow-auto-wake.js';
import { _test_exports as workflowInternals } from '../../../src/hooks/pr-workflow-gate.js';
import { _internals as responseGateInternals } from '../../../src/hooks/pr-workflow-response-gate.js';
import {
	FakeScheduler,
	makeRecoveryRaceGate,
	originalObservePrWorkflowAutoWakeEvent,
	originalReadPrWorkflowGateState,
} from './pr-workflow-response-gate-recovery-race-helpers.js';
import {
	idleEventFor,
	makeTempDir,
	writeStateWithRevision,
} from './pr-workflow-response-gate-test-helpers.js';

let directory = '';

beforeEach(() => {
	directory = makeTempDir('pr-response-gate-idle-status-race-');
	responseGateInternals.readPrWorkflowGateState =
		originalReadPrWorkflowGateState;
	responseGateInternals.observePrWorkflowAutoWakeEvent =
		originalObservePrWorkflowAutoWakeEvent;
	workflowInternals.resetTrackedStateCache();
	autoWakeInternals.reset();
});

afterEach(async () => {
	responseGateInternals.readPrWorkflowGateState =
		originalReadPrWorkflowGateState;
	responseGateInternals.observePrWorkflowAutoWakeEvent =
		originalObservePrWorkflowAutoWakeEvent;
	workflowInternals.resetTrackedStateCache();
	autoWakeInternals.reset();
	await fs.rm(directory, { recursive: true, force: true });
});

describe('PR workflow response-gate idle/status ordering races', () => {
	test('does not recreate boundary state when session.removed lands while idle auto-wake observation is blocked', async () => {
		const scheduler = new FakeScheduler();
		const promptAsync = mock(async () => ({}));
		let releaseAutoWake!: () => void;
		let markAutoWakeStarted!: () => void;
		const autoWakeStarted = new Promise<void>((resolve) => {
			markAutoWakeStarted = resolve;
		});
		responseGateInternals.observePrWorkflowAutoWakeEvent = mock(
			async (gateDirectory, rawEvent) => {
				const event = rawEvent as { type?: string };
				if (event.type !== 'session.idle') {
					return originalObservePrWorkflowAutoWakeEvent(
						gateDirectory,
						rawEvent,
					);
				}
				markAutoWakeStarted();
				await new Promise<void>((resolve) => {
					releaseAutoWake = resolve;
				});
				return { suppressWake: false };
			},
		) as typeof responseGateInternals.observePrWorkflowAutoWakeEvent;
		const sessionID = 'idle-removed-race';
		const gate = makeRecoveryRaceGate(
			directory,
			scheduler,
			promptAsync,
			undefined,
		);
		await writeStateWithRevision(directory, sessionID, 0);
		const durableState = await originalReadPrWorkflowGateState(
			directory,
			sessionID,
		);
		responseGateInternals.readPrWorkflowGateState = mock(
			async () => durableState,
		) as typeof responseGateInternals.readPrWorkflowGateState;

		const idlePromise = gate.event(idleEventFor(sessionID));
		await autoWakeStarted;
		expect(gate._inspectBoundaryActivity(sessionID)).toMatchObject({
			lastHostStatus: 'idle',
		});

		await gate.event({
			event: {
				type: 'session.removed',
				properties: { sessionID },
			},
		});
		expect(gate._inspectBoundaryActivity(sessionID)).toBeUndefined();

		releaseAutoWake();
		await idlePromise;

		expect(promptAsync).not.toHaveBeenCalled();
		expect(
			autoWakeInternals.getPluginWakeMarkerCount(directory, sessionID),
		).toBe(0);
		expect(gate._inspectBoundaryActivity(sessionID)).toBeUndefined();
		expect(scheduler.pendingCount()).toBe(0);

		await scheduler.advance(100);
		expect(promptAsync).not.toHaveBeenCalled();
		expect(gate._inspectBoundaryActivity(sessionID)).toBeUndefined();
		expect(scheduler.pendingCount()).toBe(0);
	});

	test('swallows auto-wake observation failures without rejecting the idle event', async () => {
		const scheduler = new FakeScheduler();
		const promptAsync = mock(async () => ({}));
		const gate = makeRecoveryRaceGate(
			directory,
			scheduler,
			promptAsync,
			undefined,
		);
		const sessionID = 'idle-observe-failure';
		await writeStateWithRevision(directory, sessionID, 0);
		responseGateInternals.observePrWorkflowAutoWakeEvent = mock(async () => {
			throw new Error('simulated auto-wake observation failure');
		}) as typeof responseGateInternals.observePrWorkflowAutoWakeEvent;

		await expect(gate.event(idleEventFor(sessionID))).resolves.toBeUndefined();

		expect(promptAsync).not.toHaveBeenCalled();
		expect(gate._inspectBoundaryActivity(sessionID)?.lastHostStatus).toBe(
			'idle',
		);
		expect(scheduler.pendingCount()).toBe(0);
	});

	test('swallows wake-evaluation read failures without rejecting the idle event', async () => {
		const scheduler = new FakeScheduler();
		const promptAsync = mock(async () => ({}));
		const gate = makeRecoveryRaceGate(
			directory,
			scheduler,
			promptAsync,
			undefined,
		);
		const sessionID = 'idle-read-failure';
		await writeStateWithRevision(directory, sessionID, 0);
		responseGateInternals.observePrWorkflowAutoWakeEvent = mock(async () => ({
			suppressWake: false,
		})) as typeof responseGateInternals.observePrWorkflowAutoWakeEvent;
		responseGateInternals.readPrWorkflowGateState = mock(async () => {
			throw new Error('simulated wake-evaluation read failure');
		}) as typeof responseGateInternals.readPrWorkflowGateState;

		await expect(gate.event(idleEventFor(sessionID))).resolves.toBeUndefined();

		expect(promptAsync).not.toHaveBeenCalled();
		expect(gate._inspectBoundaryActivity(sessionID)?.lastHostStatus).toBe(
			'idle',
		);
		expect(scheduler.pendingCount()).toBe(0);
	});

	for (const newerStatus of ['busy', 'retry'] as const) {
		test(`publishes idle before awaits without overwriting a newer ${newerStatus} host-status event`, async () => {
			const scheduler = new FakeScheduler();
			const promptAsync = mock(async () => ({}));
			let releaseAutoWake!: () => void;
			let markAutoWakeStarted!: () => void;
			const autoWakeStarted = new Promise<void>((resolve) => {
				markAutoWakeStarted = resolve;
			});
			responseGateInternals.observePrWorkflowAutoWakeEvent = mock(
				async (gateDirectory, rawEvent) => {
					const event = rawEvent as { type?: string };
					if (event.type !== 'session.idle') {
						return originalObservePrWorkflowAutoWakeEvent(
							gateDirectory,
							rawEvent,
						);
					}
					markAutoWakeStarted();
					await new Promise<void>((resolve) => {
						releaseAutoWake = resolve;
					});
					return { suppressWake: false };
				},
			) as typeof responseGateInternals.observePrWorkflowAutoWakeEvent;
			const sessionID = `idle-race-${newerStatus}`;
			const gate = makeRecoveryRaceGate(
				directory,
				scheduler,
				promptAsync,
				undefined,
			);
			await writeStateWithRevision(directory, sessionID, 0);
			const durableState = await originalReadPrWorkflowGateState(
				directory,
				sessionID,
			);
			responseGateInternals.readPrWorkflowGateState = mock(
				async () => durableState,
			) as typeof responseGateInternals.readPrWorkflowGateState;

			const idlePromise = gate.event(idleEventFor(sessionID));
			await autoWakeStarted;
			expect(gate._inspectBoundaryActivity(sessionID)).toMatchObject({
				lastHostStatus: 'idle',
			});

			await gate.event({
				event: {
					type: 'session.status',
					properties: {
						sessionID,
						status: { type: newerStatus },
					},
				},
			});
			expect(gate._inspectBoundaryActivity(sessionID)).toMatchObject({
				lastHostStatus: newerStatus,
			});

			releaseAutoWake();
			await idlePromise;

			expect(promptAsync).not.toHaveBeenCalled();
			expect(gate._inspectBoundaryActivity(sessionID)).toMatchObject({
				lastHostStatus: newerStatus,
				hasTimer: true,
			});
			expect(scheduler.pendingCount()).toBe(1);

			await scheduler.advance(9);
			expect(promptAsync).not.toHaveBeenCalled();

			await gate.event({
				event: {
					type: 'session.status',
					properties: {
						sessionID,
						status: { type: 'idle' },
					},
				},
			});
			await scheduler.advance(20);

			expect(promptAsync).toHaveBeenCalledTimes(1);
			expect(gate._inspectBoundaryActivity(sessionID)).toMatchObject({
				lastHostStatus: 'idle',
				hasTimer: false,
			});
			expect(scheduler.pendingCount()).toBe(0);
		});
	}
});
