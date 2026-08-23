import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { _test_exports as autoWakeInternals } from '../../../src/hooks/pr-workflow-auto-wake.js';
import {
	activatePrWorkflow,
	_test_exports as workflowInternals,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	createPrWorkflowResponseGate,
	_internals as responseGateInternals,
} from '../../../src/hooks/pr-workflow-response-gate.js';
import {
	idleEventFor,
	makeTempDir,
	writeStateWithRevision,
} from './pr-workflow-response-gate-test-helpers.js';

class FakeScheduler {
	now = 1;
	private nextID = 0;
	private queue = new Map<
		number,
		{ at: number; callback: () => void; unrefCalled: boolean }
	>();

	schedule = (callback: () => void, delayMs: number) => {
		const id = ++this.nextID;
		const handle = {
			id,
			unref: () => {
				const pending = this.queue.get(id);
				if (pending) pending.unrefCalled = true;
			},
		};
		this.queue.set(id, {
			at: this.now + Math.max(0, delayMs),
			callback,
			unrefCalled: false,
		});
		return handle as unknown as ReturnType<typeof setTimeout>;
	};

	clear = (timer: ReturnType<typeof setTimeout>) => {
		const id = (timer as unknown as { id?: number }).id;
		if (typeof id === 'number') this.queue.delete(id);
	};

	pendingCount(): number {
		return this.queue.size;
	}

	async advance(ms: number): Promise<void> {
		const target = this.now + ms;
		while (true) {
			const next = [...this.queue.entries()]
				.sort((left, right) => left[1].at - right[1].at)
				.find(([, entry]) => entry.at <= target);
			if (!next) {
				this.now = target;
				await this.flush();
				const afterFlush = [...this.queue.entries()]
					.sort((left, right) => left[1].at - right[1].at)
					.find(([, entry]) => entry.at <= target);
				if (!afterFlush) break;
				continue;
			}
			const [id, entry] = next;
			this.queue.delete(id);
			this.now = entry.at;
			entry.callback();
			await this.flush();
		}
	}

	private async flush(): Promise<void> {
		for (let i = 0; i < 12; i++) {
			await Promise.resolve();
		}
	}
}

let directory = '';
const originalReadPrWorkflowGateState =
	responseGateInternals.readPrWorkflowGateState;

beforeEach(() => {
	directory = makeTempDir('pr-response-gate-boundary-');
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

function makeGate(
	scheduler: FakeScheduler,
	promptAsync: ReturnType<typeof mock>,
	statusImpl?: () => Promise<{ data?: Record<string, { type: string }> }>,
) {
	return createPrWorkflowResponseGate({
		directory,
		client: {
			session: {
				prompt: promptAsync,
				promptAsync,
				status: statusImpl,
			},
		},
		boundaryQuietMs: 10,
		boundaryWatchdogMs: 50,
		statusProbeTimeoutMs: 5,
		now: () => scheduler.now,
		scheduleTimer: scheduler.schedule,
		clearScheduledTimer: scheduler.clear,
	});
}

describe('PR workflow response-gate boundary lease', () => {
	test('defers and coalesces duplicate idles until the last running tool completes', async () => {
		const scheduler = new FakeScheduler();
		const promptAsync = mock(async () => ({}));
		const gate = makeGate(scheduler, promptAsync, async () => ({
			data: { 'lease-session': { type: 'idle' } },
		}));
		await activatePrWorkflow(directory, 'lease-session', 'PR_REVIEW');
		const leaseState = await originalReadPrWorkflowGateState(
			directory,
			'lease-session',
		);
		responseGateInternals.readPrWorkflowGateState = mock(
			async () => leaseState,
		) as typeof responseGateInternals.readPrWorkflowGateState;

		await gate.event({
			event: {
				type: 'message.updated',
				data: {
					info: {
						role: 'assistant',
						sessionID: 'lease-session',
						parts: [
							{
								type: 'tool',
								id: 'tool-1',
								state: { status: 'running' },
							},
						],
					},
				},
			},
		});

		await gate.event(idleEventFor('lease-session'));
		await gate.event(idleEventFor('lease-session'));

		expect(promptAsync).not.toHaveBeenCalled();
		expect(gate._inspectBoundaryActivity('lease-session')).toMatchObject({
			activeToolPartCount: 1,
			hasTimer: true,
		});

		await scheduler.advance(9);
		expect(promptAsync).not.toHaveBeenCalled();

		await gate.event({
			event: {
				type: 'message.part.updated',
				properties: {
					part: {
						type: 'tool',
						id: 'tool-1',
						sessionID: 'lease-session',
						state: { status: 'completed' },
					},
				},
			},
		});

		await scheduler.advance(9);
		expect(promptAsync).not.toHaveBeenCalled();

		await scheduler.advance(20);
		expect(promptAsync).toHaveBeenCalledTimes(1);
		expect(gate._inspectBoundaryActivity('lease-session')).toMatchObject({
			activeToolPartCount: 0,
			hasTimer: false,
		});
	});

	test('does not wake at the watchdog while a tool is still running, then wakes after terminal activity and the quiet lease', async () => {
		const scheduler = new FakeScheduler();
		const promptAsync = mock(async () => ({}));
		const gate = makeGate(scheduler, promptAsync, async () => ({
			data: { 'hung-session': { type: 'idle' } },
		}));
		await activatePrWorkflow(directory, 'hung-session', 'PR_REVIEW');
		const hungState = await originalReadPrWorkflowGateState(
			directory,
			'hung-session',
		);
		responseGateInternals.readPrWorkflowGateState = mock(
			async () => hungState,
		) as typeof responseGateInternals.readPrWorkflowGateState;

		await gate.event({
			event: {
				type: 'message.part.updated',
				properties: {
					part: {
						type: 'tool',
						id: 'tool-hung',
						sessionID: 'hung-session',
						state: { status: 'running' },
					},
				},
			},
		});
		await gate.event(idleEventFor('hung-session'));

		await scheduler.advance(10);
		expect(promptAsync).not.toHaveBeenCalled();

		await scheduler.advance(50);
		expect(promptAsync).not.toHaveBeenCalled();
		expect(gate._inspectBoundaryActivity('hung-session')).toMatchObject({
			activeToolPartCount: 1,
			hasTimer: true,
		});
		expect(scheduler.pendingCount()).toBe(1);

		await gate.event({
			event: {
				type: 'message.part.updated',
				properties: {
					part: {
						type: 'tool',
						id: 'tool-hung',
						sessionID: 'hung-session',
						state: { status: 'completed' },
					},
				},
			},
		});

		await scheduler.advance(9);
		expect(promptAsync).not.toHaveBeenCalled();

		await scheduler.advance(20);
		expect(promptAsync).toHaveBeenCalledTimes(1);
		expect(gate._inspectBoundaryActivity('hung-session')).toMatchObject({
			activeToolPartCount: 0,
			hasTimer: false,
		});
	});

	test('cancels the pending lease when the session is removed', async () => {
		const scheduler = new FakeScheduler();
		const promptAsync = mock(async () => ({}));
		const gate = makeGate(scheduler, promptAsync, async () => ({
			data: { 'removed-session': { type: 'idle' } },
		}));
		await activatePrWorkflow(directory, 'removed-session', 'PR_REVIEW');

		await gate.event({
			event: {
				type: 'message.part.updated',
				properties: {
					part: {
						type: 'tool',
						id: 'tool-remove',
						sessionID: 'removed-session',
						state: { status: 'running' },
					},
				},
			},
		});
		await gate.event(idleEventFor('removed-session'));
		expect(gate._inspectBoundaryActivity('removed-session')?.hasTimer).toBe(
			true,
		);

		await gate.event({
			event: {
				type: 'session.removed',
				properties: { sessionID: 'removed-session' },
			},
		});

		expect(gate._inspectBoundaryActivity('removed-session')).toBeUndefined();
		await scheduler.advance(100);
		expect(promptAsync).not.toHaveBeenCalled();
	});

	test('publishes tool activity before the first await so a racing idle defers instead of prompting', async () => {
		const scheduler = new FakeScheduler();
		const promptAsync = mock(async () => ({}));
		const gate = makeGate(scheduler, promptAsync, async () => ({
			data: { 'race-session': { type: 'idle' } },
		}));
		await writeStateWithRevision(directory, 'race-session', 0);

		const releasedState = await originalReadPrWorkflowGateState(
			directory,
			'race-session',
		);
		let releaseRead!: () => void;
		const blockedRead = new Promise<typeof releasedState>((resolve) => {
			releaseRead = () => resolve(releasedState);
		});
		let readCount = 0;
		responseGateInternals.readPrWorkflowGateState = mock(async () => {
			readCount += 1;
			return readCount === 1 ? blockedRead : releasedState;
		}) as typeof responseGateInternals.readPrWorkflowGateState;

		const idlePromise = gate.event(idleEventFor('race-session'));
		await Promise.resolve();

		await gate.event({
			event: {
				type: 'message.part.updated',
				properties: {
					part: {
						type: 'tool',
						id: 'tool-race',
						sessionID: 'race-session',
						state: { status: 'running' },
					},
				},
			},
		});

		releaseRead();
		await idlePromise;

		expect(promptAsync).not.toHaveBeenCalled();
		expect(gate._inspectBoundaryActivity('race-session')).toMatchObject({
			activeToolPartCount: 1,
			hasTimer: true,
		});
	});

	test('evicts and cancels the oldest pending lease when the session map reaches its bound', async () => {
		const scheduler = new FakeScheduler();
		const promptAsync = mock(async () => ({}));
		const gate = makeGate(scheduler, promptAsync);
		const durableState = {
			mode: 'PR_REVIEW',
			sessionID: 'placeholder',
			revision: 0,
		} as Awaited<ReturnType<typeof originalReadPrWorkflowGateState>>;
		responseGateInternals.readPrWorkflowGateState = mock(
			async () => durableState,
		) as typeof responseGateInternals.readPrWorkflowGateState;

		for (let index = 0; index <= 256; index += 1) {
			const sessionID = `bounded-session-${index}`;
			await gate.event({
				event: {
					type: 'message.part.updated',
					properties: {
						part: {
							type: 'tool',
							id: `tool-${index}`,
							sessionID,
							state: { status: 'running' },
						},
					},
				},
			});
			await gate.event(idleEventFor(sessionID));
		}

		expect(gate._inspectBoundaryActivity('bounded-session-0')).toBeUndefined();
		expect(gate._inspectBoundaryActivity('bounded-session-256')).toMatchObject({
			hasTimer: true,
		});
		expect(scheduler.pendingCount()).toBeLessThanOrEqual(256);
		expect(promptAsync).not.toHaveBeenCalled();
	});

	test('treats a missing status payload as unknown and waits for the quiet boundary', async () => {
		const scheduler = new FakeScheduler();
		const promptAsync = mock(async () => ({}));
		const gate = makeGate(scheduler, promptAsync, async () => ({}));
		await writeStateWithRevision(directory, 'unknown-session', 0);
		const durableState = await originalReadPrWorkflowGateState(
			directory,
			'unknown-session',
		);
		responseGateInternals.readPrWorkflowGateState = mock(
			async () => durableState,
		) as typeof responseGateInternals.readPrWorkflowGateState;

		await gate.event({
			event: {
				type: 'message.part.updated',
				data: {
					part: {
						type: 'text',
						id: 'text-progress',
						sessionID: 'unknown-session',
					},
				},
			},
		});
		await gate.event(idleEventFor('unknown-session'));

		expect(promptAsync).not.toHaveBeenCalled();
		expect(gate._inspectBoundaryActivity('unknown-session')).toMatchObject({
			lastHostStatus: 'idle',
			hasTimer: true,
		});
		await scheduler.advance(9);
		expect(promptAsync).not.toHaveBeenCalled();
		await scheduler.advance(20);
		expect(gate._inspectBoundaryActivity('unknown-session')).toMatchObject({
			hasTimer: false,
		});
		expect(promptAsync).toHaveBeenCalledTimes(1);
	});
});
