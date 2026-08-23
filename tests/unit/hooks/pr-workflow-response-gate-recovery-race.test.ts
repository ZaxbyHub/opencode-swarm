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
	directory = makeTempDir('pr-response-gate-recovery-race-');
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

describe('PR workflow response-gate recovery wake races', () => {
	test('fails closed when the session is removed during the initial durable read', async () => {
		const scheduler = new FakeScheduler();
		const promptAsync = mock(async () => ({}));
		await writeStateWithRevision(directory, 'race-removed-initial-read', 0);
		const durableState = await originalReadPrWorkflowGateState(
			directory,
			'race-removed-initial-read',
		);
		let releaseInitialRead!: () => void;
		let markInitialReadStarted!: () => void;
		const initialReadStarted = new Promise<void>((resolve) => {
			markInitialReadStarted = resolve;
		});
		const blockedInitialRead = new Promise<typeof durableState>((resolve) => {
			releaseInitialRead = () => resolve(durableState);
		});
		responseGateInternals.readPrWorkflowGateState = mock(async () => {
			markInitialReadStarted();
			return blockedInitialRead;
		}) as typeof responseGateInternals.readPrWorkflowGateState;
		const gate = makeRecoveryRaceGate(
			directory,
			scheduler,
			promptAsync,
			async () => ({
				data: { 'race-removed-initial-read': { type: 'idle' } },
			}),
		);

		const idlePromise = gate.event(idleEventFor('race-removed-initial-read'));
		await initialReadStarted;
		await gate.event({
			event: {
				type: 'session.removed',
				properties: { sessionID: 'race-removed-initial-read' },
			},
		});
		releaseInitialRead();
		await idlePromise;

		expect(promptAsync).not.toHaveBeenCalled();
		expect(
			autoWakeInternals.getPluginWakeMarkerCount(
				directory,
				'race-removed-initial-read',
			),
		).toBe(0);
		expect(gate._inspectBoundaryActivity('race-removed-initial-read')).toBe(
			undefined,
		);
	});

	test('fails closed when the durable gate clears while status is blocked', async () => {
		const scheduler = new FakeScheduler();
		const promptAsync = mock(async () => ({}));
		let releaseStatus!: () => void;
		const statusBlocked = new Promise<{
			data: Record<string, { type: string }>;
		}>((resolve) => {
			releaseStatus = () =>
				resolve({ data: { 'race-clear-session': { type: 'idle' } } });
		});
		const gate = makeRecoveryRaceGate(
			directory,
			scheduler,
			promptAsync,
			async () => statusBlocked,
		);
		await writeStateWithRevision(directory, 'race-clear-session', 0);
		const durableState = await originalReadPrWorkflowGateState(
			directory,
			'race-clear-session',
		);
		let gateCleared = false;
		responseGateInternals.readPrWorkflowGateState = mock(async () => {
			return gateCleared ? null : durableState;
		}) as typeof responseGateInternals.readPrWorkflowGateState;

		const idlePromise = gate.event(idleEventFor('race-clear-session'));
		await Promise.resolve();
		gateCleared = true;
		releaseStatus();
		await idlePromise;

		expect(promptAsync).not.toHaveBeenCalled();
		expect(
			autoWakeInternals.getPluginWakeMarkerCount(
				directory,
				'race-clear-session',
			),
		).toBe(0);
	});

	test('fails closed when an abort pause arrives while status is blocked', async () => {
		const scheduler = new FakeScheduler();
		const promptAsync = mock(async () => ({}));
		let releaseStatus!: () => void;
		const statusBlocked = new Promise<{
			data: Record<string, { type: string }>;
		}>((resolve) => {
			releaseStatus = () =>
				resolve({ data: { 'race-pause-session': { type: 'idle' } } });
		});
		const gate = makeRecoveryRaceGate(
			directory,
			scheduler,
			promptAsync,
			async () => statusBlocked,
		);
		await writeStateWithRevision(directory, 'race-pause-session', 0);

		const idlePromise = gate.event(idleEventFor('race-pause-session'));
		await Promise.resolve();
		await gate.event({
			event: {
				type: 'session.error',
				properties: {
					sessionID: 'race-pause-session',
					error: { name: 'MessageAbortedError' },
				},
			},
		});
		releaseStatus();
		await idlePromise;

		expect(promptAsync).not.toHaveBeenCalled();
		expect(
			autoWakeInternals.getPausePhase(directory, 'race-pause-session'),
		).toBe('awaiting-idle');
		expect(
			autoWakeInternals.getPluginWakeMarkerCount(
				directory,
				'race-pause-session',
			),
		).toBe(0);
	});

	test('defers the recovery wake when parent tool activity lands while status is blocked', async () => {
		const scheduler = new FakeScheduler();
		const promptAsync = mock(async () => ({}));
		let releaseStatus!: () => void;
		const statusBlocked = new Promise<{
			data: Record<string, { type: string }>;
		}>((resolve) => {
			releaseStatus = () =>
				resolve({ data: { 'race-activity-session': { type: 'idle' } } });
		});
		const gate = makeRecoveryRaceGate(
			directory,
			scheduler,
			promptAsync,
			async () => statusBlocked,
		);
		await writeStateWithRevision(directory, 'race-activity-session', 0);
		const durableState = await originalReadPrWorkflowGateState(
			directory,
			'race-activity-session',
		);
		responseGateInternals.readPrWorkflowGateState = mock(
			async () => durableState,
		) as typeof responseGateInternals.readPrWorkflowGateState;

		const idlePromise = gate.event(idleEventFor('race-activity-session'));
		await Promise.resolve();
		await gate.event({
			event: {
				type: 'message.part.updated',
				properties: {
					part: {
						type: 'tool',
						id: 'tool-race',
						sessionID: 'race-activity-session',
						state: { status: 'running' },
					},
				},
			},
		});
		releaseStatus();
		await idlePromise;

		expect(promptAsync).not.toHaveBeenCalled();
		expect(
			gate._inspectBoundaryActivity('race-activity-session'),
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
						id: 'tool-race',
						sessionID: 'race-activity-session',
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
			gate._inspectBoundaryActivity('race-activity-session'),
		).toMatchObject({
			activeToolPartCount: 0,
			hasTimer: false,
		});
	});

	test('retains a newer busy host-status event when the blocked status probe returns stale idle', async () => {
		const scheduler = new FakeScheduler();
		const promptAsync = mock(async () => ({}));
		let releaseStatus!: () => void;
		let markStatusStarted!: () => void;
		const statusStarted = new Promise<void>((resolve) => {
			markStatusStarted = resolve;
		});
		let statusCalls = 0;
		const statusBlocked = new Promise<{
			data: Record<string, { type: string }>;
		}>((resolve) => {
			releaseStatus = () =>
				resolve({ data: { 'race-busy-session': { type: 'idle' } } });
		});
		const gate = makeRecoveryRaceGate(
			directory,
			scheduler,
			promptAsync,
			async () => {
				statusCalls += 1;
				if (statusCalls === 1) markStatusStarted();
				return statusCalls === 1
					? statusBlocked
					: { data: { 'race-busy-session': { type: 'idle' } } };
			},
		);
		await writeStateWithRevision(directory, 'race-busy-session', 0);
		const durableState = await originalReadPrWorkflowGateState(
			directory,
			'race-busy-session',
		);
		responseGateInternals.readPrWorkflowGateState = mock(
			async () => durableState,
		) as typeof responseGateInternals.readPrWorkflowGateState;

		const idlePromise = gate.event(idleEventFor('race-busy-session'));
		await statusStarted;
		await gate.event({
			event: {
				type: 'session.status',
				properties: {
					sessionID: 'race-busy-session',
					status: { type: 'busy' },
				},
			},
		});
		releaseStatus();
		await idlePromise;

		expect(promptAsync).not.toHaveBeenCalled();
		expect(gate._inspectBoundaryActivity('race-busy-session')).toMatchObject({
			lastHostStatus: 'busy',
			hasTimer: true,
		});

		await scheduler.advance(9);
		expect(promptAsync).not.toHaveBeenCalled();

		await gate.event({
			event: {
				type: 'session.status',
				properties: {
					sessionID: 'race-busy-session',
					status: { type: 'idle' },
				},
			},
		});
		await scheduler.advance(20);

		expect(promptAsync).toHaveBeenCalledTimes(1);
	});

	const staleIdleRecoveryCases: Array<{
		label: string;
		makeStatus:
			| (() => Promise<{ data?: Record<string, { type: string }> }>)
			| undefined;
	}> = [
		{ label: 'an unavailable status API', makeStatus: undefined },
		{
			label: 'a status API error',
			makeStatus: async () => {
				throw new Error('status unavailable');
			},
		},
		{
			label: 'a status API response with no session data',
			makeStatus: async () => ({ data: {} }),
		},
	];

	for (const staleStatus of ['busy', 'retry'] as const) {
		for (const { label, makeStatus } of staleIdleRecoveryCases) {
			test(`session.idle supersedes stale ${staleStatus} host status when follow-up probes see ${label}`, async () => {
				const scheduler = new FakeScheduler();
				const promptAsync = mock(async () => ({}));
				const sessionID = `idle-supersedes-${staleStatus}-${label.replace(/[^a-z]+/gi, '-')}`;
				const gate = makeRecoveryRaceGate(
					directory,
					scheduler,
					promptAsync,
					makeStatus,
				);
				await writeStateWithRevision(directory, sessionID, 0);
				const durableState = await originalReadPrWorkflowGateState(
					directory,
					sessionID,
				);
				responseGateInternals.readPrWorkflowGateState = mock(
					async () => durableState,
				) as typeof responseGateInternals.readPrWorkflowGateState;

				await gate.event({
					event: {
						type: 'session.status',
						properties: {
							sessionID,
							status: { type: staleStatus },
						},
					},
				});
				expect(gate._inspectBoundaryActivity(sessionID)).toMatchObject({
					lastHostStatus: staleStatus,
				});

				await gate.event(idleEventFor(sessionID));

				expect(promptAsync).toHaveBeenCalledTimes(1);
				expect(scheduler.pendingCount()).toBe(0);
				expect(gate._inspectBoundaryActivity(sessionID)).toMatchObject({
					lastHostStatus: 'idle',
					hasTimer: false,
				});

				await scheduler.advance(100);
				expect(promptAsync).toHaveBeenCalledTimes(1);
				expect(scheduler.pendingCount()).toBe(0);
			});
		}
	}

	test('fails closed when the session is removed while status is blocked', async () => {
		const scheduler = new FakeScheduler();
		const promptAsync = mock(async () => ({}));
		let releaseStatus!: () => void;
		let markStatusStarted!: () => void;
		const statusStarted = new Promise<void>((resolve) => {
			markStatusStarted = resolve;
		});
		const statusBlocked = new Promise<{
			data: Record<string, { type: string }>;
		}>((resolve) => {
			releaseStatus = () =>
				resolve({ data: { 'race-removed-status-session': { type: 'idle' } } });
		});
		const gate = makeRecoveryRaceGate(
			directory,
			scheduler,
			promptAsync,
			async () => {
				markStatusStarted();
				return statusBlocked;
			},
		);
		await writeStateWithRevision(directory, 'race-removed-status-session', 0);
		const durableState = await originalReadPrWorkflowGateState(
			directory,
			'race-removed-status-session',
		);
		responseGateInternals.readPrWorkflowGateState = mock(
			async () => durableState,
		) as typeof responseGateInternals.readPrWorkflowGateState;

		const idlePromise = gate.event(idleEventFor('race-removed-status-session'));
		await statusStarted;
		await gate.event({
			event: {
				type: 'session.removed',
				properties: { sessionID: 'race-removed-status-session' },
			},
		});
		releaseStatus();
		await idlePromise;

		expect(promptAsync).not.toHaveBeenCalled();
		expect(
			autoWakeInternals.getPluginWakeMarkerCount(
				directory,
				'race-removed-status-session',
			),
		).toBe(0);
		expect(gate._inspectBoundaryActivity('race-removed-status-session')).toBe(
			undefined,
		);
	});
});
