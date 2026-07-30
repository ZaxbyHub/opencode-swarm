/**
 * Extended PR event subscriber tests (first-class swarm-pr-subscribe).
 *
 * Covers the six newly wired event types (pr.ci.passed, pr.review.*,
 * pr.merged, pr.closed, pr.merge.conflict_resolved), their config gates,
 * prompt-mode dispatch to the wake deliverer with advisory fallback, and
 * the hasUnaddressedEvents clear on successful delivery.
 *
 * Uses the _internals DI seam — no mock.module, no cross-file pollution.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	type PrEventSubscriberOptions,
	registerPrEventSubscribers,
} from '../../../src/background/pr-event-subscribers';
import type { PrSubscriptionRecord } from '../../../src/background/pr-subscriptions';

const TEST_DIR = path.join(os.tmpdir(), 'pr-event-subscribers-ext-test');

function makeConfig(
	overrides: Record<string, unknown> = {},
): PrEventSubscriberOptions['config'] {
	return {
		notify_ci_failure: true,
		notify_new_comments: true,
		notify_merge_conflict: true,
		notify_review_activity: true,
		notify_merged: true,
		notify_closed: true,
		notify_ci_success: false,
		auto_pr_feedback: false,
		event_delivery: 'advisory',
		...overrides,
	} as PrEventSubscriberOptions['config'];
}

function makeSubscription(
	overrides: Partial<PrSubscriptionRecord> = {},
): PrSubscriptionRecord {
	return {
		correlationId: 'sess1::owner/repo::42',
		sessionID: 'sess1',
		prNumber: 42,
		repoFullName: 'owner/repo',
		prUrl: 'https://github.com/owner/repo/pull/42',
		lastCheckedAt: Date.now() - 60_000,
		isWatching: true,
		hasUnaddressedEvents: true,
		status: 'active',
		createdAt: Date.now() - 120_000,
		updatedAt: Date.now() - 60_000,
		errorCount: 0,
		...overrides,
	};
}

function makeMockSession(sessionID: string): {
	sessionID: string;
	pendingAdvisoryMessages: string[];
} {
	return { sessionID, pendingAdvisoryMessages: [] };
}

let saved: typeof _internals;
let mocks: {
	listActive: ReturnType<typeof mock>;
	getAgentSession: ReturnType<typeof mock>;
	log: ReturnType<typeof mock>;
	getGlobalEventBus: ReturnType<typeof mock>;
	deliverPrActivity: ReturnType<typeof mock>;
	isPrEventDeliveryRegistered: ReturnType<typeof mock>;
	scheduleClearUnaddressed: ReturnType<typeof mock>;
	busSubscribe: ReturnType<typeof mock>;
};

beforeEach(() => {
	saved = { ..._internals };
	mocks = {
		listActive: mock(() => Promise.resolve([])),
		getAgentSession: mock(() => undefined),
		log: mock(() => {}),
		getGlobalEventBus: mock(() => ({ subscribe: mocks.busSubscribe })),
		deliverPrActivity: mock(() => Promise.resolve(true)),
		isPrEventDeliveryRegistered: mock(() => false),
		scheduleClearUnaddressed: mock(() => {}),
		busSubscribe: mock(() => () => {}),
	};
	_internals.listActive = mocks.listActive as typeof _internals.listActive;
	_internals.getAgentSession =
		mocks.getAgentSession as typeof _internals.getAgentSession;
	_internals.log = mocks.log as typeof _internals.log;
	_internals.getGlobalEventBus =
		mocks.getGlobalEventBus as typeof _internals.getGlobalEventBus;
	_internals.deliverPrActivity =
		mocks.deliverPrActivity as typeof _internals.deliverPrActivity;
	_internals.isPrEventDeliveryRegistered =
		mocks.isPrEventDeliveryRegistered as typeof _internals.isPrEventDeliveryRegistered;
	_internals.scheduleClearUnaddressed =
		mocks.scheduleClearUnaddressed as typeof _internals.scheduleClearUnaddressed;
});

afterEach(() => {
	_internals.listActive = saved.listActive;
	_internals.getAgentSession = saved.getAgentSession;
	_internals.log = saved.log;
	_internals.getGlobalEventBus = saved.getGlobalEventBus;
	_internals.deliverPrActivity = saved.deliverPrActivity;
	_internals.isPrEventDeliveryRegistered = saved.isPrEventDeliveryRegistered;
	_internals.scheduleClearUnaddressed = saved.scheduleClearUnaddressed;
	_internals.updateSnapshot = saved.updateSnapshot;
	_internals.clearUnaddressedDelayMs = saved.clearUnaddressedDelayMs;
});

// ── Registration gating for the new event types ─────────────────────

describe('registration gating — new event types', () => {
	test('all nine event types register when every flag is enabled', () => {
		registerPrEventSubscribers({
			directory: TEST_DIR,
			config: makeConfig({ notify_ci_success: true }),
		});
		const types = mocks.busSubscribe.mock.calls.map((c: unknown[]) => c[0]);
		expect(types).toHaveLength(9);
		for (const t of [
			'pr.ci.failed',
			'pr.ci.passed',
			'pr.new.comment',
			'pr.merge.conflict',
			'pr.merge.conflict_resolved',
			'pr.review.changes_requested',
			'pr.review.approved',
			'pr.merged',
			'pr.closed',
		]) {
			expect(types).toContain(t);
		}
	});

	test('pr.ci.passed is skipped by default (notify_ci_success defaults false)', () => {
		registerPrEventSubscribers({ directory: TEST_DIR, config: makeConfig() });
		const types = mocks.busSubscribe.mock.calls.map((c: unknown[]) => c[0]);
		expect(types).not.toContain('pr.ci.passed');
		expect(types).toHaveLength(8);
	});

	test('notify_review_activity=false skips both review event types', () => {
		registerPrEventSubscribers({
			directory: TEST_DIR,
			config: makeConfig({ notify_review_activity: false }),
		});
		const types = mocks.busSubscribe.mock.calls.map((c: unknown[]) => c[0]);
		expect(types).not.toContain('pr.review.changes_requested');
		expect(types).not.toContain('pr.review.approved');
	});

	test('notify_merged=false / notify_closed=false skip terminal event types', () => {
		registerPrEventSubscribers({
			directory: TEST_DIR,
			config: makeConfig({ notify_merged: false, notify_closed: false }),
		});
		const types = mocks.busSubscribe.mock.calls.map((c: unknown[]) => c[0]);
		expect(types).not.toContain('pr.merged');
		expect(types).not.toContain('pr.closed');
	});

	test('pr.merge.conflict_resolved is gated by notify_merge_conflict', () => {
		registerPrEventSubscribers({
			directory: TEST_DIR,
			config: makeConfig({ notify_merge_conflict: false }),
		});
		const types = mocks.busSubscribe.mock.calls.map((c: unknown[]) => c[0]);
		expect(types).not.toContain('pr.merge.conflict');
		expect(types).not.toContain('pr.merge.conflict_resolved');
	});
});

// ── Formatting of the new event types (advisory channel) ────────────

describe('formatAdvisory — new event types', () => {
	async function deliver(
		type: string,
		payload: Record<string, unknown>,
	): Promise<string[]> {
		const session = makeMockSession('sess1');
		mocks.listActive.mockResolvedValueOnce([makeSubscription()]);
		mocks.getAgentSession.mockReturnValue(session as never);
		await _internals.handlePrEvent(
			{
				type,
				payload: { prNumber: 42, repoFullName: 'owner/repo', ...payload },
			},
			TEST_DIR,
			makeConfig(),
		);
		return session.pendingAdvisoryMessages;
	}

	test('pr.ci.passed includes dedup token and check count', async () => {
		const msgs = await deliver('pr.ci.passed', {
			prUrl: 'https://github.com/owner/repo/pull/42',
			checkCount: 7,
		});
		expect(msgs).toHaveLength(1);
		expect(msgs[0]).toContain('[pr-monitor:pr.ci.passed:owner/repo#42]');
		expect(msgs[0]).toContain('CI checks passed');
		expect(msgs[0]).toContain('7 passing');
	});

	test('pr.review.changes_requested includes review state', async () => {
		const msgs = await deliver('pr.review.changes_requested', {
			prUrl: 'https://github.com/owner/repo/pull/42',
			reviewDecision: 'CHANGES_REQUESTED',
		});
		expect(msgs).toHaveLength(1);
		// B8 (issue #1976): review events carry a per-event identity suffix,
		// so assert the stable token PREFIX.
		expect(msgs[0]).toContain(
			'[pr-monitor:pr.review.changes_requested:owner/repo#42',
		);
		expect(msgs[0]).toContain('changes requested');
		expect(msgs[0]).toContain('CHANGES_REQUESTED');
	});

	test('pr.review.approved includes review state', async () => {
		const msgs = await deliver('pr.review.approved', {
			prUrl: 'https://github.com/owner/repo/pull/42',
			reviewDecision: 'APPROVED',
		});
		expect(msgs).toHaveLength(1);
		// B8 (issue #1976): review events carry a per-event identity suffix.
		expect(msgs[0]).toContain('[pr-monitor:pr.review.approved:owner/repo#42');
		expect(msgs[0]).toContain('Review: approved');
		expect(msgs[0]).toContain('APPROVED');
	});

	test('pr.merged is marked TERMINAL with monitoring-ends instruction', async () => {
		const msgs = await deliver('pr.merged', {
			prUrl: 'https://github.com/owner/repo/pull/42',
			headRefOid: 'abc123',
		});
		expect(msgs).toHaveLength(1);
		expect(msgs[0]).toContain('[pr-monitor:pr.merged:owner/repo#42]');
		expect(msgs[0]).toContain('TERMINAL');
		expect(msgs[0]).toContain('Monitoring ends');
	});

	test('pr.closed is marked TERMINAL with monitoring-ends instruction', async () => {
		const msgs = await deliver('pr.closed', {
			prUrl: 'https://github.com/owner/repo/pull/42',
		});
		expect(msgs).toHaveLength(1);
		expect(msgs[0]).toContain('[pr-monitor:pr.closed:owner/repo#42]');
		expect(msgs[0]).toContain('closed without merge');
		expect(msgs[0]).toContain('TERMINAL');
	});

	test('pr.merge.conflict_resolved includes mergeable state', async () => {
		const msgs = await deliver('pr.merge.conflict_resolved', {
			prUrl: 'https://github.com/owner/repo/pull/42',
			mergeableState: 'MERGEABLE',
		});
		expect(msgs).toHaveLength(1);
		expect(msgs[0]).toContain(
			'[pr-monitor:pr.merge.conflict_resolved:owner/repo#42]',
		);
		expect(msgs[0]).toContain('Merge conflict resolved');
		expect(msgs[0]).toContain('MERGEABLE');
	});
});

// ── Prompt-mode dispatch + fallback + hasUnaddressedEvents clear ─────

describe('prompt-mode wake dispatch', () => {
	const event = {
		type: 'pr.ci.failed',
		payload: {
			prNumber: 42,
			repoFullName: 'owner/repo',
			prUrl: 'https://github.com/owner/repo/pull/42',
			checkName: 'ci/build',
			checkState: 'failure',
		},
	};

	test('dispatches to the wake deliverer and skips the advisory push on success', async () => {
		const session = makeMockSession('sess1');
		mocks.listActive.mockResolvedValueOnce([makeSubscription()]);
		mocks.getAgentSession.mockReturnValue(session as never);
		mocks.isPrEventDeliveryRegistered.mockReturnValue(true);
		mocks.deliverPrActivity.mockResolvedValueOnce(true);

		await _internals.handlePrEvent(
			event,
			TEST_DIR,
			makeConfig({ event_delivery: 'prompt' }),
		);

		expect(mocks.deliverPrActivity).toHaveBeenCalledTimes(1);
		const [sessionID, events] = mocks.deliverPrActivity.mock.calls[0] as [
			string,
			Array<Record<string, unknown>>,
		];
		expect(sessionID).toBe('sess1');
		expect(events).toHaveLength(1);
		expect(events[0].type).toBe('pr.ci.failed');
		expect(events[0].dedupToken).toBe(
			'[pr-monitor:pr.ci.failed:owner/repo#42]',
		);
		expect(events[0].prUrl).toBe('https://github.com/owner/repo/pull/42');
		// Exactly one channel: no advisory pushed
		expect(session.pendingAdvisoryMessages).toHaveLength(0);
	});

	test('falls back to the advisory push when the wake fails (exactly one channel)', async () => {
		const session = makeMockSession('sess1');
		mocks.listActive.mockResolvedValueOnce([makeSubscription()]);
		mocks.getAgentSession.mockReturnValue(session as never);
		mocks.isPrEventDeliveryRegistered.mockReturnValue(true);
		mocks.deliverPrActivity.mockResolvedValueOnce(false);

		await _internals.handlePrEvent(
			event,
			TEST_DIR,
			makeConfig({ event_delivery: 'prompt' }),
		);

		expect(mocks.deliverPrActivity).toHaveBeenCalledTimes(1);
		expect(session.pendingAdvisoryMessages).toHaveLength(1);
		expect(session.pendingAdvisoryMessages[0]).toContain(
			'[pr-monitor:pr.ci.failed:owner/repo#42]',
		);
		expect(mocks.scheduleClearUnaddressed).toHaveBeenCalledWith(
			TEST_DIR,
			'sess1::owner/repo::42',
		);
	});

	test('falls back to advisory when deliverPrActivity throws', async () => {
		const session = makeMockSession('sess1');
		mocks.listActive.mockResolvedValueOnce([makeSubscription()]);
		mocks.getAgentSession.mockReturnValue(session as never);
		mocks.isPrEventDeliveryRegistered.mockReturnValue(true);
		mocks.deliverPrActivity.mockRejectedValueOnce(new Error('boom'));

		await _internals.handlePrEvent(
			event,
			TEST_DIR,
			makeConfig({ event_delivery: 'prompt' }),
		);

		expect(session.pendingAdvisoryMessages).toHaveLength(1);
	});

	test('uses the advisory channel when no deliverer is registered', async () => {
		const session = makeMockSession('sess1');
		mocks.listActive.mockResolvedValueOnce([makeSubscription()]);
		mocks.getAgentSession.mockReturnValue(session as never);
		mocks.isPrEventDeliveryRegistered.mockReturnValue(false);

		await _internals.handlePrEvent(
			event,
			TEST_DIR,
			makeConfig({ event_delivery: 'prompt' }),
		);

		expect(mocks.deliverPrActivity).not.toHaveBeenCalled();
		expect(session.pendingAdvisoryMessages).toHaveLength(1);
	});

	test('advisory mode never dispatches to the deliverer even when registered', async () => {
		const session = makeMockSession('sess1');
		mocks.listActive.mockResolvedValueOnce([makeSubscription()]);
		mocks.getAgentSession.mockReturnValue(session as never);
		mocks.isPrEventDeliveryRegistered.mockReturnValue(true);

		await _internals.handlePrEvent(
			event,
			TEST_DIR,
			makeConfig({ event_delivery: 'advisory' }),
		);

		expect(mocks.deliverPrActivity).not.toHaveBeenCalled();
		expect(session.pendingAdvisoryMessages).toHaveLength(1);
	});
});

describe('hasUnaddressedEvents clear on delivery', () => {
	const event = {
		type: 'pr.new.comment',
		payload: {
			prNumber: 42,
			repoFullName: 'owner/repo',
			prUrl: 'https://github.com/owner/repo/pull/42',
			author: 'reviewer',
			body: 'ping',
		},
	};

	test('schedules a clear after successful wake delivery', async () => {
		mocks.listActive.mockResolvedValueOnce([makeSubscription()]);
		mocks.isPrEventDeliveryRegistered.mockReturnValue(true);
		mocks.deliverPrActivity.mockResolvedValueOnce(true);

		await _internals.handlePrEvent(
			event,
			TEST_DIR,
			makeConfig({ event_delivery: 'prompt' }),
		);

		expect(mocks.scheduleClearUnaddressed).toHaveBeenCalledWith(
			TEST_DIR,
			'sess1::owner/repo::42',
		);
	});

	test('schedules a clear after a successful advisory push', async () => {
		const session = makeMockSession('sess1');
		mocks.listActive.mockResolvedValueOnce([makeSubscription()]);
		mocks.getAgentSession.mockReturnValue(session as never);

		await _internals.handlePrEvent(event, TEST_DIR, makeConfig());

		expect(session.pendingAdvisoryMessages).toHaveLength(1);
		expect(mocks.scheduleClearUnaddressed).toHaveBeenCalledWith(
			TEST_DIR,
			'sess1::owner/repo::42',
		);
	});

	test('does NOT schedule a clear when no session receives the event', async () => {
		mocks.listActive.mockResolvedValueOnce([makeSubscription()]);
		mocks.getAgentSession.mockReturnValue(undefined);

		await _internals.handlePrEvent(event, TEST_DIR, makeConfig());

		expect(mocks.scheduleClearUnaddressed).not.toHaveBeenCalled();
	});

	test('deferred clear invokes updateSnapshot with hasUnaddressedEvents=false', async () => {
		// Use the REAL scheduleClearUnaddressed with a zero delay and a
		// mocked store write.
		_internals.scheduleClearUnaddressed = saved.scheduleClearUnaddressed;
		_internals.clearUnaddressedDelayMs = 0;
		const updateSnapshot = mock(() => Promise.resolve(null));
		_internals.updateSnapshot =
			updateSnapshot as unknown as typeof _internals.updateSnapshot;

		const session = makeMockSession('sess1');
		mocks.listActive.mockResolvedValueOnce([makeSubscription()]);
		mocks.getAgentSession.mockReturnValue(session as never);

		await _internals.handlePrEvent(event, TEST_DIR, makeConfig());

		// Wait for the zero-delay timer + the promise chain to run.
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(updateSnapshot).toHaveBeenCalledWith(
			TEST_DIR,
			'sess1::owner/repo::42',
			{ hasUnaddressedEvents: false },
		);
	});

	test('deferred clear refreshes the timer for repeated deliveries', async () => {
		// Previous code deduped pending clears by correlationId without
		// refreshing the timer, so a second delivery could still clear the
		// subscription before the worker's later snapshot write landed.
		_internals.scheduleClearUnaddressed = saved.scheduleClearUnaddressed;
		_internals.clearUnaddressedDelayMs = 40;
		const updateSnapshot = mock(() => Promise.resolve(null));
		_internals.updateSnapshot =
			updateSnapshot as unknown as typeof _internals.updateSnapshot;

		saved.scheduleClearUnaddressed(TEST_DIR, 'sess1::owner/repo::42');
		await new Promise((resolve) => setTimeout(resolve, 25));
		saved.scheduleClearUnaddressed(TEST_DIR, 'sess1::owner/repo::42');
		await new Promise((resolve) => setTimeout(resolve, 25));

		expect(updateSnapshot).not.toHaveBeenCalled();

		await new Promise((resolve) => setTimeout(resolve, 35));
		expect(updateSnapshot).toHaveBeenCalledTimes(1);
		expect(updateSnapshot).toHaveBeenCalledWith(
			TEST_DIR,
			'sess1::owner/repo::42',
			{ hasUnaddressedEvents: false },
		);
	});
});
