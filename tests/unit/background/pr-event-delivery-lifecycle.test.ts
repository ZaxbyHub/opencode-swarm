import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	noteSessionIdle,
	registerPrEventDelivery,
	unregisterPrEventDelivery,
} from '../../../src/background/pr-event-delivery.js';
import type { PrFeedbackMonitorEvent } from '../../../src/background/pr-feedback-event-queue.js';
import type { PrMonitorConfig } from '../../../src/config/schema.js';
import type { PrWorkflowGateState } from '../../../src/hooks/pr-workflow-gate.js';

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
};

let directory = '';
let savedInternals: typeof _internals;

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

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	throw new Error('timed out waiting for idle delivery');
}

beforeEach(() => {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'pr-delivery-life-')),
	);
	savedInternals = { ..._internals };
	_internals.log = mock(() => {}) as typeof _internals.log;
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
	Object.assign(_internals, savedInternals);
	unregisterPrEventDelivery();
	await fs.rm(directory, { recursive: true, force: true });
});

describe('PR event delivery lifecycle intake', () => {
	test('activates a guarded feedback workflow before delivering an authorized queued event', async () => {
		let gateReads = 0;
		const readGate = mock(async () =>
			gateReads++ === 0 ? null : feedbackState(),
		);
		const activate = mock(async () => feedbackState());
		const send = mock(async () => true);
		const claim = mock(async () => [
			{
				...EVENT,
				claimedWorkflowInstanceId: 'feedback-workflow',
				claimedAt: '2026-08-01T00:01:00.000Z',
			},
		]);
		_internals.readPrFeedbackMonitorQueue = mock(async () => queueRecord());
		_internals.readPrWorkflowGateState = readGate;
		_internals.activatePrWorkflow = activate;
		_internals.sendWakePrompt = send;
		_internals.claimPrFeedbackMonitorEvents = claim;

		noteSessionIdle(SESSION_ID);
		await waitFor(() => claim.mock.calls.length === 1);

		expect(activate).toHaveBeenCalledWith(
			directory,
			SESSION_ID,
			'PR_FEEDBACK',
			{ requireCheckoutPreflight: true, prUrl: PR_URL },
		);
		expect(send.mock.calls[0]?.[1]).toEqual([
			expect.objectContaining({ dedupToken: EVENT.dedupToken, prUrl: PR_URL }),
		]);
		expect(claim).toHaveBeenCalledWith(
			directory,
			SESSION_ID,
			'feedback-workflow',
			PR_URL,
			[EVENT.dedupToken],
		);
	});

	test('does not activate an unauthorized queued event without explicit feedback state', async () => {
		const activate = mock(async () => feedbackState());
		const send = mock(async () => true);
		_internals.readPrFeedbackMonitorQueue = mock(async () =>
			queueRecord({ ...EVENT, authorized: false }),
		);
		_internals.readPrWorkflowGateState = mock(async () => null);
		_internals.activatePrWorkflow = activate;
		_internals.sendWakePrompt = send;
		_internals.claimPrFeedbackMonitorEvents = mock(async () => []);

		noteSessionIdle(SESSION_ID);
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(activate).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
	});

	test('leaves queued events untouched while PR_REVIEW owns the session', async () => {
		const activate = mock(async () => feedbackState());
		const send = mock(async () => true);
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
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(activate).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
		expect(claim).not.toHaveBeenCalled();
	});

	test('does not claim or deliver when guarded activation fails', async () => {
		const send = mock(async () => true);
		const claim = mock(async () => []);
		_internals.readPrFeedbackMonitorQueue = mock(async () => queueRecord());
		_internals.readPrWorkflowGateState = mock(async () => null);
		_internals.activatePrWorkflow = mock(async () => {
			throw new Error('manual Git recovery required');
		});
		_internals.sendWakePrompt = send;
		_internals.claimPrFeedbackMonitorEvents = claim;

		noteSessionIdle(SESSION_ID);
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(send).not.toHaveBeenCalled();
		expect(claim).not.toHaveBeenCalled();
	});
});
