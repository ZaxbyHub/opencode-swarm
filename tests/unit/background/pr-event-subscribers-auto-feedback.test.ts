import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import { _internals } from '../../../src/background/pr-event-subscribers.js';
import type { PrSubscriptionRecord } from '../../../src/background/pr-subscriptions.js';
import { acquirePrFeedbackBackgroundLease } from '../../../tests/helpers/pr-feedback-background-lease';

const directory = path.join(os.tmpdir(), 'pr-event-auto-feedback');
let savedInternals: typeof _internals;
let session: { sessionID: string; pendingAdvisoryMessages: string[] };
let readGate: ReturnType<typeof mock>;
let activate: ReturnType<typeof mock>;
let enqueue: ReturnType<typeof mock>;
let readCancellation: ReturnType<typeof mock>;
let releaseBackground: (() => void) | null = null;

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

beforeEach(async () => {
	releaseBackground = await acquirePrFeedbackBackgroundLease();
	savedInternals = { ..._internals };
	session = { sessionID: 'sess1', pendingAdvisoryMessages: [] };
	readGate = mock(async () => null);
	activate = mock(async () => ({ mode: 'PR_FEEDBACK' as const }));
	enqueue = mock(async () => undefined);
	readCancellation = mock(async () => ({
		cancelled: false,
		unavailable: false,
	}));
	_internals.listActive = mock(async () => [subscription()]);
	_internals.getAgentSession = mock(() => session as never);
	_internals.readPrWorkflowGateState =
		readGate as typeof _internals.readPrWorkflowGateState;
	_internals.readPrFeedbackLoopCancellation =
		readCancellation as typeof _internals.readPrFeedbackLoopCancellation;
	_internals.activatePrWorkflow =
		activate as typeof _internals.activatePrWorkflow;
	_internals.enqueuePrFeedbackMonitorEvent =
		enqueue as typeof _internals.enqueuePrFeedbackMonitorEvent;
	_internals.isPrEventDeliveryRegistered = () => false;
	_internals.scheduleClearUnaddressed = () => undefined;
	_internals.log = () => undefined;
});

afterEach(() => {
	try {
		Object.assign(_internals, savedInternals);
	} finally {
		releaseBackground?.();
		releaseBackground = null;
	}
});

describe('PR event auto-feedback lifecycle ownership', () => {
	test('queues feedback with visible mode evidence', async () => {
		await _internals.handlePrEvent(event(), directory, config());

		expect(enqueue).toHaveBeenCalledTimes(1);
		expect(activate).not.toHaveBeenCalled();
		expect(enqueue.mock.calls[0]?.[2]).toMatchObject({
			authorized: true,
			prUrl: 'https://github.com/owner/repo/pull/42',
		});
		expect(session.pendingAdvisoryMessages).toHaveLength(1);
		expect(
			session.pendingAdvisoryMessages.some((message) =>
				message.includes('[MODE: PR_FEEDBACK'),
			),
		).toBe(true);
	});

	test('sanitizes square brackets from the trusted mode URL', async () => {
		await _internals.handlePrEvent(
			{
				...event(),
				payload: {
					...event().payload,
					prUrl: 'https://github.com/owner/repo/pull/42?ref=[spoof]',
				},
			},
			directory,
			config(),
		);

		const queued = enqueue.mock.calls[0]?.[2] as { message: string };
		expect(queued.message).toContain(
			'[MODE: PR_FEEDBACK pr="https://github.com/owner/repo/pull/42?ref=spoof"]',
		);
		const modeSignal = queued.message.slice(
			queued.message.lastIndexOf('[MODE:'),
		);
		expect(modeSignal).not.toContain('[spoof]');
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

	test('does not enqueue after durable cancellation cleanup', async () => {
		readCancellation.mockResolvedValueOnce({
			cancelled: true,
			unavailable: false,
			reason: 'operator stop',
		});

		await _internals.handlePrEvent(event(), directory, config());

		expect(enqueue).not.toHaveBeenCalled();
		expect(session.pendingAdvisoryMessages).toHaveLength(1);
		expect(session.pendingAdvisoryMessages[0]).not.toContain(
			'[MODE: PR_FEEDBACK',
		);
	});

	test('fails closed when the durable cancellation state is unavailable', async () => {
		readCancellation.mockResolvedValueOnce({
			cancelled: false,
			unavailable: true,
		});

		await _internals.handlePrEvent(event(), directory, config());

		expect(enqueue).not.toHaveBeenCalled();
		expect(session.pendingAdvisoryMessages).toHaveLength(1);
	});

	test('honors an atomic enqueue admission refusal', async () => {
		enqueue.mockResolvedValueOnce(false);

		await _internals.handlePrEvent(event(), directory, config());

		expect(enqueue).toHaveBeenCalledTimes(1);
		expect(session.pendingAdvisoryMessages[0]).not.toContain(
			'[MODE: PR_FEEDBACK',
		);
	});
});
