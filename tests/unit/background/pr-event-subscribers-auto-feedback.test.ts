import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import { _internals } from '../../../src/background/pr-event-subscribers.js';
import type { PrSubscriptionRecord } from '../../../src/background/pr-subscriptions.js';

const directory = path.join(os.tmpdir(), 'pr-event-auto-feedback');
let savedInternals: typeof _internals;
let session: { sessionID: string; pendingAdvisoryMessages: string[] };
let readGate: ReturnType<typeof mock>;
let activate: ReturnType<typeof mock>;
let enqueue: ReturnType<typeof mock>;

function subscription(): PrSubscriptionRecord {
	return {
		correlationId: 'sess1::owner/repo::42',
		sessionID: 'sess1',
		prNumber: 42,
		repoFullName: 'owner/repo',
		prUrl: 'https://github.com/owner/repo/pull/42',
		lastCheckedAt: 940_000,
		isWatching: true,
		hasUnaddressedEvents: false,
		status: 'active',
		createdAt: 880_000,
		updatedAt: 940_000,
		errorCount: 0,
	};
}

function config(overrides: Record<string, unknown> = {}) {
	return {
		notify_ci_failure: true,
		notify_new_comments: true,
		notify_merge_conflict: true,
		auto_pr_feedback: true,
		...overrides,
	};
}

function event(type = 'pr.ci.failed') {
	return {
		type,
		payload: {
			prNumber: 42,
			repoFullName: 'owner/repo',
			prUrl: 'https://github.com/owner/repo/pull/42',
			checkName: 'ci/build',
			checkState: 'failure',
		},
	};
}

beforeEach(() => {
	savedInternals = { ..._internals };
	session = { sessionID: 'sess1', pendingAdvisoryMessages: [] };
	readGate = mock(async () => null);
	activate = mock(async () => ({ mode: 'PR_FEEDBACK' as const }));
	enqueue = mock(async () => undefined);
	_internals.listActive = mock(async () => [subscription()]);
	_internals.getAgentSession = mock(() => session as never);
	_internals.readPrWorkflowGateState =
		readGate as typeof _internals.readPrWorkflowGateState;
	_internals.activatePrWorkflow =
		activate as typeof _internals.activatePrWorkflow;
	_internals.enqueuePrFeedbackMonitorEvent =
		enqueue as typeof _internals.enqueuePrFeedbackMonitorEvent;
	_internals.isPrEventDeliveryRegistered = () => false;
	_internals.scheduleClearUnaddressed = () => undefined;
	_internals.log = () => undefined;
});

afterEach(() => {
	Object.assign(_internals, savedInternals);
});

describe('PR event auto-feedback lifecycle ownership', () => {
	test('queues and mechanically activates feedback without a raw mode signal', async () => {
		await _internals.handlePrEvent(event(), directory, config());

		expect(enqueue).toHaveBeenCalledTimes(1);
		expect(activate).toHaveBeenCalledWith(directory, 'sess1', 'PR_FEEDBACK', {
			requireCheckoutPreflight: true,
			prUrl: 'https://github.com/owner/repo/pull/42',
		});
		expect(session.pendingAdvisoryMessages).toHaveLength(1);
		expect(
			session.pendingAdvisoryMessages.some((message) =>
				message.includes('[MODE: PR_FEEDBACK'),
			),
		).toBe(false);
	});

	test('does not arm feedback when auto feedback is disabled', async () => {
		await _internals.handlePrEvent(
			event(),
			directory,
			config({ auto_pr_feedback: false }),
		);

		expect(enqueue).not.toHaveBeenCalled();
		expect(activate).not.toHaveBeenCalled();
		expect(session.pendingAdvisoryMessages).toHaveLength(1);
	});

	test('does not arm feedback for a non-authorizing comment event', async () => {
		await _internals.handlePrEvent(
			{
				...event('pr.new.comment'),
				payload: { ...event().payload, commentAuthor: 'reviewer' },
			},
			directory,
			config(),
		);

		expect(enqueue).not.toHaveBeenCalled();
		expect(activate).not.toHaveBeenCalled();
	});

	test('queues feedback without mutating an active PR_REVIEW workflow', async () => {
		readGate.mockResolvedValueOnce({ mode: 'PR_REVIEW' });
		await _internals.handlePrEvent(
			event(),
			directory,
			config({ event_delivery: 'prompt' }),
		);

		expect(enqueue).toHaveBeenCalledTimes(1);
		expect(activate).not.toHaveBeenCalled();
		expect(session.pendingAdvisoryMessages).toHaveLength(1);
	});
});
