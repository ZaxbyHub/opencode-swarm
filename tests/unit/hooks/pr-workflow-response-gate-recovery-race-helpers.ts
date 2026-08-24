import type { mock } from 'bun:test';
import {
	createPrWorkflowResponseGate,
	_internals as responseGateInternals,
} from '../../../src/hooks/pr-workflow-response-gate.js';

export class FakeScheduler {
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

export const originalReadPrWorkflowGateState =
	responseGateInternals.readPrWorkflowGateState;
export const originalObservePrWorkflowAutoWakeEvent =
	responseGateInternals.observePrWorkflowAutoWakeEvent;

export function makeRecoveryRaceGate(
	directory: string,
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
