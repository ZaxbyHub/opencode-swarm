import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import {
	_internals,
	noteSessionIdle,
	registerPrEventDelivery,
	unregisterPrEventDelivery,
} from '../../../src/background/pr-event-delivery.js';
import type { PrFeedbackMonitorEvent } from '../../../src/background/pr-feedback-event-queue.js';
import type { PrMonitorConfig } from '../../../src/config/schema.js';
import type { PrWorkflowGateState } from '../../../src/hooks/pr-workflow-gate.js';
import { acquirePrFeedbackBackgroundLease } from '../../../tests/helpers/pr-feedback-background-lease';
import { canonicalMkdtemp } from '../../../tests/helpers/tmpdir';

const SESSION_ID = 'monitor-lifecycle-session';
const PR_URL = 'https://github.com/owner/repo/pull/42';
const EVENT: PrFeedbackMonitorEvent = {
	type: 'pr.ci.failed',
	repoFullName: 'owner/repo',
	prNumber: 42,
	prUrl: PR_URL,
	message: '[pr-monitor:pr.ci.failed:owner/repo#42] CI failed',
	dedupToken: '[pr-monitor:pr.ci.failed:owner/repo#42]',
	authorized: true,
	queuedAt: '2026-08-01T00:00:00.000Z',
	headRefOid: 'head-42',
};

let directory = '';
let savedInternals: typeof _internals;
let notify: ReturnType<typeof mock>;
let releaseBackground: (() => void) | null = null;

function feedbackState(): PrWorkflowGateState {
	return {
		schemaVersion: 1,
		revision: 0,
		sessionID: SESSION_ID,
		mode: 'PR_FEEDBACK',
		workflowInstanceId: 'feedback-workflow',
		activatedAt: '2026-08-01T00:00:00.000Z',
		prFeedbackTargetUrl: PR_URL,
	};
}

function queueRecord(event: PrFeedbackMonitorEvent = EVENT) {
	return {
		schemaVersion: 1 as const,
		revision: 1,
		sessionID: SESSION_ID,
		events: [event],
	};
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

beforeEach(async () => {
	releaseBackground = await acquirePrFeedbackBackgroundLease();
	directory = canonicalMkdtemp('pr-delivery-life-');
	savedInternals = { ..._internals };
	_internals.log = mock(() => {}) as typeof _internals.log;
	notify = mock(() => {});
	_internals.notifyPrFeedbackLoop = notify;
	unregisterPrEventDelivery();
	registerPrEventDelivery({
		client: { session: {} } as never,
		directory,
		config: {
			enabled: true,
			event_delivery: 'prompt',
			auto_pr_feedback: true,
		} as PrMonitorConfig,
	});
});

afterEach(async () => {
	try {
		Object.assign(_internals, savedInternals);
		unregisterPrEventDelivery();
		await fs.rm(directory, { recursive: true, force: true });
	} finally {
		releaseBackground?.();
		releaseBackground = null;
	}
});

describe('PR event delivery lifecycle intake', () => {
	test('delivers queued activity as a later wake without activating or claiming', async () => {
		const readGate = mock(async () => feedbackState());
		const activate = mock(async () => feedbackState());
		const wake = deferred();
		const notified = deferred();
		notify = mock(() => {
			notified.resolve();
		});
		_internals.notifyPrFeedbackLoop = notify;
		const send = mock(async () => {
			wake.resolve();
			return true;
		});
		const claim = mock(async () => []);
		_internals.readPrFeedbackMonitorQueue = mock(async () => queueRecord());
		_internals.readPrWorkflowGateState = readGate;
		_internals.activatePrWorkflow = activate;
		_internals.sendWakePrompt = send;
		_internals.claimPrFeedbackMonitorEvents = claim;

		noteSessionIdle(SESSION_ID);
		await Promise.all([wake.promise, notified.promise]);

		expect(activate).not.toHaveBeenCalled();
		expect(claim).not.toHaveBeenCalled();
		expect(send.mock.calls[0]?.[1]).toEqual([
			expect.objectContaining({
				dedupToken: EVENT.dedupToken,
				prUrl: PR_URL,
				disposition: 'queued-for-later',
			}),
		]);
		expect(notify).toHaveBeenCalledWith(directory, SESSION_ID);
	});

	test('delivers an unauthorized queued event only as a later wake notice', async () => {
		const activate = mock(async () => feedbackState());
		const wake = deferred();
		const send = mock(async () => {
			wake.resolve();
			return true;
		});
		_internals.readPrFeedbackMonitorQueue = mock(async () =>
			queueRecord({ ...EVENT, authorized: false }),
		);
		_internals.readPrWorkflowGateState = mock(async () => feedbackState());
		_internals.activatePrWorkflow = activate;
		_internals.sendWakePrompt = send;
		_internals.claimPrFeedbackMonitorEvents = mock(async () => []);

		noteSessionIdle(SESSION_ID);
		await wake.promise;

		expect(activate).not.toHaveBeenCalled();
		expect(send.mock.calls[0]?.[1]).toEqual([
			expect.objectContaining({
				dedupToken: EVENT.dedupToken,
				disposition: 'queued-for-later',
			}),
		]);
		expect(_internals.claimPrFeedbackMonitorEvents).not.toHaveBeenCalled();
	});

	test('wakes PR_REVIEW with a later notice without settling its workflow', async () => {
		const activate = mock(async () => feedbackState());
		const wake = deferred();
		const send = mock(async () => {
			wake.resolve();
			return true;
		});
		const claim = mock(async () => []);
		_internals.readPrFeedbackMonitorQueue = mock(async () => queueRecord());
		_internals.readPrWorkflowGateState = mock(async () => ({
			...feedbackState(),
			mode: 'PR_REVIEW' as const,
		}));
		_internals.activatePrWorkflow = activate;
		_internals.sendWakePrompt = send;
		_internals.claimPrFeedbackMonitorEvents = claim;

		noteSessionIdle(SESSION_ID);
		await wake.promise;

		expect(activate).not.toHaveBeenCalled();
		expect(send.mock.calls[0]?.[1]).toEqual([
			expect.objectContaining({
				dedupToken: EVENT.dedupToken,
				disposition: 'queued-for-later',
			}),
		]);
		expect(notify).not.toHaveBeenCalled();
		expect(claim).not.toHaveBeenCalled();
	});

	test('preserves the durable queue when the workflow gate read fails (FB-002)', async () => {
		// A gate read failure must not authorize settlement. The queued event can
		// still be shown as a later wake notice, but no loop notification or claim
		// may follow the failed read.
		const readGate = mock(async () => {
			throw new Error('disk error');
		});
		const activate = mock(async () => feedbackState());
		const wake = deferred();
		const send = mock(async () => {
			wake.resolve();
			return true;
		});
		const claim = mock(async () => []);
		_internals.readPrFeedbackMonitorQueue = mock(async () => queueRecord());
		_internals.readPrWorkflowGateState = readGate;
		_internals.activatePrWorkflow = activate;
		_internals.sendWakePrompt = send;
		_internals.claimPrFeedbackMonitorEvents = claim;

		noteSessionIdle(SESSION_ID);
		await wake.promise;

		expect(activate).not.toHaveBeenCalled();
		expect(send.mock.calls[0]?.[1]).toEqual([
			expect.objectContaining({ disposition: 'queued-for-later' }),
		]);
		expect(notify).not.toHaveBeenCalled();
		expect(claim).not.toHaveBeenCalled();
	});

	test('does not settle or claim when the later wake transport fails', async () => {
		const wake = deferred();
		const send = mock(async () => {
			wake.resolve();
			return false;
		});
		const claim = mock(async () => []);
		_internals.readPrFeedbackMonitorQueue = mock(async () => queueRecord());
		_internals.readPrWorkflowGateState = mock(async () => feedbackState());
		_internals.activatePrWorkflow = mock(async () => feedbackState());
		_internals.sendWakePrompt = send;
		_internals.claimPrFeedbackMonitorEvents = claim;

		noteSessionIdle(SESSION_ID);
		await wake.promise;

		expect(send).toHaveBeenCalledTimes(1);
		expect(claim).not.toHaveBeenCalled();
		expect(_internals.activatePrWorkflow).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
	});
});
