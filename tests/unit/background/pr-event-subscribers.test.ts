/**
 * Phase 1 PR Event Subscribers tests.
 *
 * Tests: registerPrEventSubscribers, handlePrEvent, formatAdvisory.
 * Uses _internals DI seam for full mock isolation â€” no cross-file pollution.
 *
 * The _internals seam is added to pr-event-subscribers.ts specifically for
 * testing: it exposes handlePrEvent, getGlobalEventBus, listActive,
 * getAgentSession, and log so tests can replace them with mocks.
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

// â”€â”€ Test Fixtures â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const TEST_DIR = path.join(os.tmpdir(), 'pr-event-subscribers-test');

function makeConfig(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		notify_ci_failure: true,
		notify_new_comments: true,
		notify_merge_conflict: true,
		auto_pr_feedback: false,
		...overrides,
	};
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
		lastCheckedAt: 940_000,
		isWatching: true,
		hasUnaddressedEvents: false,
		status: 'active',
		createdAt: 880_000,
		updatedAt: 940_000,
		errorCount: 0,
		...overrides,
	};
}

// â”€â”€ Mock State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface MockState {
	listActive: ReturnType<typeof mock>;
	getAgentSession: ReturnType<typeof mock>;
	readPrWorkflowGateState: ReturnType<typeof mock>;
	activatePrWorkflow: ReturnType<typeof mock>;
	enqueuePrFeedbackMonitorEvent: ReturnType<typeof mock>;
	log: ReturnType<typeof mock>;
	getGlobalEventBus: ReturnType<typeof mock>;
	scheduleClearUnaddressed: ReturnType<typeof mock>;
	busInstance: {
		subscribe: ReturnType<typeof mock>;
	};
}

let mockState: MockState;
let savedInternals: typeof _internals;

function setupMocks(): void {
	savedInternals = { ..._internals };

	mockState = {
		listActive: mock(() => Promise.resolve([])),
		getAgentSession: mock(() => undefined),
		readPrWorkflowGateState: mock(() => Promise.resolve(null)),
		activatePrWorkflow: mock(() =>
			Promise.resolve({ mode: 'PR_FEEDBACK', prFeedbackInventory: undefined }),
		),
		enqueuePrFeedbackMonitorEvent: mock(() => Promise.resolve(undefined)),
		log: mock(() => {}),
		getGlobalEventBus: mock(() => mockState.busInstance),
		scheduleClearUnaddressed: mock(() => {}),
		busInstance: {
			subscribe: mock(() => () => {}),
		},
	};

	_internals.listActive = mockState.listActive as typeof _internals.listActive;
	_internals.getAgentSession =
		mockState.getAgentSession as typeof _internals.getAgentSession;
	_internals.readPrWorkflowGateState =
		mockState.readPrWorkflowGateState as typeof _internals.readPrWorkflowGateState;
	_internals.activatePrWorkflow =
		mockState.activatePrWorkflow as typeof _internals.activatePrWorkflow;
	_internals.enqueuePrFeedbackMonitorEvent =
		mockState.enqueuePrFeedbackMonitorEvent as typeof _internals.enqueuePrFeedbackMonitorEvent;
	_internals.log = mockState.log as typeof _internals.log;
	_internals.getGlobalEventBus =
		mockState.getGlobalEventBus as typeof _internals.getGlobalEventBus;
	// No-op the deferred hasUnaddressedEvents clear so these tests never
	// schedule real timers / store writes.
	_internals.scheduleClearUnaddressed =
		mockState.scheduleClearUnaddressed as typeof _internals.scheduleClearUnaddressed;
}

function restoreInternals(): void {
	if (savedInternals) {
		_internals.listActive = savedInternals.listActive;
		_internals.getAgentSession = savedInternals.getAgentSession;
		_internals.readPrWorkflowGateState = savedInternals.readPrWorkflowGateState;
		_internals.activatePrWorkflow = savedInternals.activatePrWorkflow;
		_internals.enqueuePrFeedbackMonitorEvent =
			savedInternals.enqueuePrFeedbackMonitorEvent;
		_internals.log = savedInternals.log;
		_internals.getGlobalEventBus = savedInternals.getGlobalEventBus;
		_internals.scheduleClearUnaddressed =
			savedInternals.scheduleClearUnaddressed;
	}
}

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Create a mock session object that tracks pendingAdvisoryMessages.
 */
function makeMockSession(sessionId: string): {
	sessionID: string;
	pendingAdvisoryMessages: string[];
} {
	return {
		sessionID: sessionId,
		pendingAdvisoryMessages: [],
	};
}

// â”€â”€ Tests â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('PrEventSubscriberOptions â€” construction', () => {
	test('has expected shape', () => {
		const opts: PrEventSubscriberOptions = {
			directory: TEST_DIR,
			config: makeConfig() as PrEventSubscriberOptions['config'],
		};
		expect(opts.directory).toBe(TEST_DIR);
		expect(opts.config).toBeDefined();
	});
});

describe('registerPrEventSubscribers', () => {
	beforeEach(() => {
		setupMocks();
	});

	afterEach(() => {
		restoreInternals();
	});

	test('registers subscribers for all enabled event types', () => {
		const cleanup = registerPrEventSubscribers({
			directory: TEST_DIR,
			config: makeConfig() as PrEventSubscriberOptions['config'],
		});

		// The legacy 3 flags gate 4 event types: notify_merge_conflict also
		// gates pr.merge.conflict_resolved. The other flags (review/merged/
		// closed/ci_success) are unset in makeConfig â†’ skipped.
		expect(mockState.busInstance.subscribe).toHaveBeenCalledTimes(4);
		expect(mockState.busInstance.subscribe).toHaveBeenCalledWith(
			'pr.ci.failed',
			expect.any(Function),
		);
		expect(mockState.busInstance.subscribe).toHaveBeenCalledWith(
			'pr.new.comment',
			expect.any(Function),
		);
		expect(mockState.busInstance.subscribe).toHaveBeenCalledWith(
			'pr.merge.conflict',
			expect.any(Function),
		);
		expect(mockState.busInstance.subscribe).toHaveBeenCalledWith(
			'pr.merge.conflict_resolved',
			expect.any(Function),
		);

		cleanup();
	});

	test('skips subscriber when notify_ci_failure config flag is false', () => {
		registerPrEventSubscribers({
			directory: TEST_DIR,
			config: makeConfig({
				notify_ci_failure: false,
			}) as PrEventSubscriberOptions['config'],
		});

		// 3 event types subscribed (new_comment + merge_conflict + conflict_resolved)
		expect(mockState.busInstance.subscribe).toHaveBeenCalledTimes(3);

		const subscribedTypes = mockState.busInstance.subscribe.mock.calls.map(
			(c: unknown[]) => c[0],
		);
		expect(subscribedTypes).not.toContain('pr.ci.failed');
		expect(subscribedTypes).toContain('pr.new.comment');
		expect(subscribedTypes).toContain('pr.merge.conflict');
		expect(subscribedTypes).toContain('pr.merge.conflict_resolved');
	});

	test('skips subscriber when notify_new_comments config flag is false', () => {
		registerPrEventSubscribers({
			directory: TEST_DIR,
			config: makeConfig({
				notify_new_comments: false,
			}) as PrEventSubscriberOptions['config'],
		});

		expect(mockState.busInstance.subscribe).toHaveBeenCalledTimes(3);
		const subscribedTypes = mockState.busInstance.subscribe.mock.calls.map(
			(c: unknown[]) => c[0],
		);
		expect(subscribedTypes).toContain('pr.ci.failed');
		expect(subscribedTypes).not.toContain('pr.new.comment');
		expect(subscribedTypes).toContain('pr.merge.conflict');
		expect(subscribedTypes).toContain('pr.merge.conflict_resolved');
	});

	test('skips subscriber when notify_merge_conflict config flag is false', () => {
		registerPrEventSubscribers({
			directory: TEST_DIR,
			config: makeConfig({
				notify_merge_conflict: false,
			}) as PrEventSubscriberOptions['config'],
		});

		expect(mockState.busInstance.subscribe).toHaveBeenCalledTimes(2);
		const subscribedTypes = mockState.busInstance.subscribe.mock.calls.map(
			(c: unknown[]) => c[0],
		);
		expect(subscribedTypes).toContain('pr.ci.failed');
		expect(subscribedTypes).toContain('pr.new.comment');
		expect(subscribedTypes).not.toContain('pr.merge.conflict');
		expect(subscribedTypes).not.toContain('pr.merge.conflict_resolved');
	});

	test('skips all subscribers when all config flags are false', () => {
		registerPrEventSubscribers({
			directory: TEST_DIR,
			config: makeConfig({
				notify_ci_failure: false,
				notify_new_comments: false,
				notify_merge_conflict: false,
			}) as PrEventSubscriberOptions['config'],
		});

		expect(mockState.busInstance.subscribe).not.toHaveBeenCalled();
	});

	test('cleanup function unsubscribes all listeners', () => {
		const mockUnsubscribe1 = mock(() => {});
		const mockUnsubscribe2 = mock(() => {});
		const mockUnsubscribe3 = mock(() => {});

		mockState.busInstance.subscribe
			.mockReturnValueOnce(mockUnsubscribe1)
			.mockReturnValueOnce(mockUnsubscribe2)
			.mockReturnValueOnce(mockUnsubscribe3);

		const cleanup = registerPrEventSubscribers({
			directory: TEST_DIR,
			config: makeConfig() as PrEventSubscriberOptions['config'],
		});

		cleanup();

		expect(mockUnsubscribe1).toHaveBeenCalledTimes(1);
		expect(mockUnsubscribe2).toHaveBeenCalledTimes(1);
		expect(mockUnsubscribe3).toHaveBeenCalledTimes(1);
	});
});

describe('handlePrEvent', () => {
	beforeEach(() => {
		setupMocks();
	});

	afterEach(() => {
		restoreInternals();
	});

	test('delivers pr.ci.failed advisory to subscribed session', async () => {
		const session = makeMockSession('sess1');
		mockState.listActive.mockResolvedValueOnce([
			makeSubscription({ sessionID: 'sess1' }),
		]);
		mockState.getAgentSession.mockReturnValue(session as any);

		await _internals.handlePrEvent(
			{
				type: 'pr.ci.failed',
				payload: {
					prNumber: 42,
					repoFullName: 'owner/repo',
					prUrl: 'https://github.com/owner/repo/pull/42',
					checkName: 'ci/build',
					checkState: 'failure',
					errorMessage: 'test error',
				},
			},
			TEST_DIR,
			makeConfig(),
		);

		expect(session.pendingAdvisoryMessages).toHaveLength(1);
		expect(session.pendingAdvisoryMessages[0]).toContain('pr.ci.failed');
		expect(session.pendingAdvisoryMessages[0]).toContain('ci/build');
		expect(session.pendingAdvisoryMessages[0]).toContain('failed');
		expect(session.pendingAdvisoryMessages[0]).toContain(
			'[pr-monitor:pr.ci.failed:owner/repo#42]',
		);
	});

	test('delivers pr.new.comment advisory to subscribed session', async () => {
		const session = makeMockSession('sess2');
		mockState.listActive.mockResolvedValueOnce([
			makeSubscription({
				sessionID: 'sess2',
				prNumber: 99,
				repoFullName: 'org/repo',
				correlationId: 'sess2::org/repo::99',
			}),
		]);
		mockState.getAgentSession.mockReturnValue(session as any);

		await _internals.handlePrEvent(
			{
				type: 'pr.new.comment',
				payload: {
					prNumber: 99,
					repoFullName: 'org/repo',
					prUrl: 'https://github.com/org/repo/pull/99',
					author: 'reviewer',
					body: 'LGTM!',
				},
			},
			TEST_DIR,
			makeConfig(),
		);

		expect(session.pendingAdvisoryMessages).toHaveLength(1);
		expect(session.pendingAdvisoryMessages[0]).toContain('pr.new.comment');
		expect(session.pendingAdvisoryMessages[0]).toContain('@reviewer');
		expect(session.pendingAdvisoryMessages[0]).toContain('LGTM!');
		// B8 (issue #1976): content events carry a per-event identity suffix.
		expect(session.pendingAdvisoryMessages[0]).toContain(
			'[pr-monitor:pr.new.comment:org/repo#99',
		);
	});

	test('issue #1976 B8: N distinct comments on one PR produce N advisories (not 1)', async () => {
		// The legacy per-PR dedup token collapsed all comments on a PR to a single
		// advisory (N comments â†’ 1 advisory, Nâˆ’1 silently dropped). The per-event
		// identity suffix (@author:content-hash) lets distinct comments survive.
		const session = makeMockSession('sess-b8');
		mockState.listActive.mockResolvedValue([
			makeSubscription({ sessionID: 'sess-b8' }),
		]);
		mockState.getAgentSession.mockReturnValue(session as any);

		const comments = [
			{ author: 'alice', body: 'looks good' },
			{ author: 'bob', body: 'please fix the typo' },
			{ author: 'alice', body: 'fixed, rebased' },
		];
		for (const c of comments) {
			await _internals.handlePrEvent(
				{
					type: 'pr.new.comment',
					payload: {
						prNumber: 42,
						repoFullName: 'owner/repo',
						prUrl: 'https://github.com/owner/repo/pull/42',
						author: c.author,
						body: c.body,
					},
				},
				TEST_DIR,
				makeConfig(),
			);
		}

		// Three distinct comments â†’ three distinct per-event tokens â†’ three advisories.
		expect(session.pendingAdvisoryMessages).toHaveLength(3);
	});

	test('issue #1976 B8: an identical re-delivered comment is deduped', async () => {
		// Per-event identity still suppresses a byte-identical re-delivery of the
		// SAME comment (same author + same body â†’ same token).
		const session = makeMockSession('sess-b8b');
		mockState.listActive.mockResolvedValue([
			makeSubscription({ sessionID: 'sess-b8b' }),
		]);
		mockState.getAgentSession.mockReturnValue(session as any);

		const payload = {
			prNumber: 42,
			repoFullName: 'owner/repo',
			prUrl: 'https://github.com/owner/repo/pull/42',
			author: 'alice',
			body: 'same comment twice',
		};
		await _internals.handlePrEvent(
			{ type: 'pr.new.comment', payload },
			TEST_DIR,
			makeConfig(),
		);
		await _internals.handlePrEvent(
			{ type: 'pr.new.comment', payload },
			TEST_DIR,
			makeConfig(),
		);

		expect(session.pendingAdvisoryMessages).toHaveLength(1);
	});

	test('delivers pr.merge.conflict advisory to subscribed session', async () => {
		const session = makeMockSession('sess3');
		mockState.listActive.mockResolvedValueOnce([
			makeSubscription({
				sessionID: 'sess3',
				prNumber: 10,
				repoFullName: 'myorg/myrepo',
				correlationId: 'sess3::myorg/myrepo::10',
			}),
		]);
		mockState.getAgentSession.mockReturnValue(session as any);

		await _internals.handlePrEvent(
			{
				type: 'pr.merge.conflict',
				payload: {
					prNumber: 10,
					repoFullName: 'myorg/myrepo',
					prUrl: 'https://github.com/myorg/myrepo/pull/10',
				},
			},
			TEST_DIR,
			makeConfig(),
		);

		expect(session.pendingAdvisoryMessages).toHaveLength(1);
		expect(session.pendingAdvisoryMessages[0]).toContain('pr.merge.conflict');
		expect(session.pendingAdvisoryMessages[0]).toContain(
			'Merge conflict detected',
		);
		expect(session.pendingAdvisoryMessages[0]).toContain('CONFLICTING');
		expect(session.pendingAdvisoryMessages[0]).toContain(
			'[pr-monitor:pr.merge.conflict:myorg/myrepo#10]',
		);
	});

	test('does not deliver when no matching subscription exists', async () => {
		mockState.listActive.mockResolvedValueOnce([
			makeSubscription({
				prNumber: 999, // Different PR number
				repoFullName: 'other/repo',
			}),
		]);

		const session = makeMockSession('sess1');
		mockState.getAgentSession.mockReturnValue(session as any);

		await _internals.handlePrEvent(
			{
				type: 'pr.ci.failed',
				payload: {
					prNumber: 42,
					repoFullName: 'owner/repo',
				},
			},
			TEST_DIR,
			makeConfig(),
		);

		expect(session.pendingAdvisoryMessages).toHaveLength(0);
	});

	test('does not deliver when session not found', async () => {
		mockState.listActive.mockResolvedValueOnce([
			makeSubscription({ sessionID: 'sess1' }),
		]);
		mockState.getAgentSession.mockReturnValue(undefined);

		// Should not throw, should not add any messages
		await _internals.handlePrEvent(
			{
				type: 'pr.ci.failed',
				payload: {
					prNumber: 42,
					repoFullName: 'owner/repo',
				},
			},
			TEST_DIR,
			makeConfig(),
		);

		expect(mockState.log).toHaveBeenCalledWith(
			expect.stringContaining('Session sess1 not found'),
		);
	});

	test('deduplicates repeated events for same PR+type', async () => {
		const session = makeMockSession('sess1');
		mockState.listActive.mockReturnValue([
			makeSubscription({ sessionID: 'sess1' }),
		]);
		mockState.getAgentSession.mockReturnValue(session as any);

		// First event
		await _internals.handlePrEvent(
			{
				type: 'pr.ci.failed',
				payload: {
					prNumber: 42,
					repoFullName: 'owner/repo',
					checkName: 'ci/build',
					checkState: 'failure',
				},
			},
			TEST_DIR,
			makeConfig(),
		);

		expect(session.pendingAdvisoryMessages).toHaveLength(1);

		// Same event again â€” should be deduplicated
		await _internals.handlePrEvent(
			{
				type: 'pr.ci.failed',
				payload: {
					prNumber: 42,
					repoFullName: 'owner/repo',
					checkName: 'ci/build',
					checkState: 'failure',
				},
			},
			TEST_DIR,
			makeConfig(),
		);

		// Still only 1 message (second was deduped)
		expect(session.pendingAdvisoryMessages).toHaveLength(1);
	});

	test('dedup works correctly with interleaved different event types', async () => {
		const session = makeMockSession('sess1');
		mockState.listActive.mockReturnValue([
			makeSubscription({ sessionID: 'sess1' }),
		]);
		mockState.getAgentSession.mockReturnValue(session as any);

		// 1. Deliver pr.ci.failed â†’ expect advisory delivered
		await _internals.handlePrEvent(
			{
				type: 'pr.ci.failed',
				payload: {
					prNumber: 42,
					repoFullName: 'owner/repo',
					checkName: 'ci/build',
					checkState: 'failure',
				},
			},
			TEST_DIR,
			makeConfig(),
		);

		expect(session.pendingAdvisoryMessages).toHaveLength(1);
		expect(session.pendingAdvisoryMessages[0]).toContain('pr.ci.failed');

		// 2. Deliver pr.new.comment â†’ expect advisory delivered (different type)
		await _internals.handlePrEvent(
			{
				type: 'pr.new.comment',
				payload: {
					prNumber: 42,
					repoFullName: 'owner/repo',
					prUrl: 'https://github.com/owner/repo/pull/42',
					author: 'reviewer',
					body: 'LGTM',
				},
			},
			TEST_DIR,
			makeConfig(),
		);

		// Both messages should be present (different event types)
		expect(session.pendingAdvisoryMessages).toHaveLength(2);
		expect(session.pendingAdvisoryMessages[1]).toContain('pr.new.comment');

		// 3. Deliver pr.ci.failed again â†’ expect DEDUPED (same type+PR, scanned from all messages)
		await _internals.handlePrEvent(
			{
				type: 'pr.ci.failed',
				payload: {
					prNumber: 42,
					repoFullName: 'owner/repo',
					checkName: 'ci/build',
					checkState: 'failure',
				},
			},
			TEST_DIR,
			makeConfig(),
		);

		// Still only 2 messages â€” the second ci.failed was deduped
		expect(session.pendingAdvisoryMessages).toHaveLength(2);
	});

	test('delivers to multiple sessions subscribed to same PR', async () => {
		const session1 = makeMockSession('sess1');
		const session2 = makeMockSession('sess2');
		const session3 = makeMockSession('sess3');

		mockState.listActive.mockResolvedValueOnce([
			makeSubscription({ sessionID: 'sess1' }),
			makeSubscription({
				sessionID: 'sess2',
				correlationId: 'sess2::owner/repo::42',
			}),
			makeSubscription({
				sessionID: 'sess3',
				correlationId: 'sess3::owner/repo::42',
			}),
		]);

		mockState.getAgentSession
			.mockReturnValueOnce(session1 as any)
			.mockReturnValueOnce(session2 as any)
			.mockReturnValueOnce(session3 as any);

		await _internals.handlePrEvent(
			{
				type: 'pr.merge.conflict',
				payload: {
					prNumber: 42,
					repoFullName: 'owner/repo',
					prUrl: 'https://github.com/owner/repo/pull/42',
				},
			},
			TEST_DIR,
			makeConfig(),
		);

		expect(session1.pendingAdvisoryMessages).toHaveLength(1);
		expect(session2.pendingAdvisoryMessages).toHaveLength(1);
		expect(session3.pendingAdvisoryMessages).toHaveLength(1);
	});

	test('handles event payload with missing fields gracefully', async () => {
		mockState.listActive.mockResolvedValueOnce([
			makeSubscription({ sessionID: 'sess1' }),
		]);
		const session = makeMockSession('sess1');
		mockState.getAgentSession.mockReturnValue(session as any);

		// Payload with only partial fields (prUrl missing, checkName missing)
		await _internals.handlePrEvent(
			{
				type: 'pr.ci.failed',
				payload: {
					prNumber: 42,
					repoFullName: 'owner/repo',
					// prUrl, checkName, errorMessage all missing
				},
			},
			TEST_DIR,
			makeConfig(),
		);

		// Should still deliver a message with 'unknown' defaults
		expect(session.pendingAdvisoryMessages).toHaveLength(1);
		expect(session.pendingAdvisoryMessages[0]).toContain('unknown');
		expect(session.pendingAdvisoryMessages[0]).toContain('owner/repo');
	});

	test('handles event payload with missing prNumber', async () => {
		mockState.listActive.mockResolvedValueOnce([
			makeSubscription({ sessionID: 'sess1' }),
		]);
		const session = makeMockSession('sess1');
		mockState.getAgentSession.mockReturnValue(session as any);

		// prNumber missing
		await _internals.handlePrEvent(
			{
				type: 'pr.ci.failed',
				payload: {
					repoFullName: 'owner/repo',
				},
			},
			TEST_DIR,
			makeConfig(),
		);

		// Should return early without delivering
		expect(session.pendingAdvisoryMessages).toHaveLength(0);
	});

	test('handles event payload with missing repoFullName', async () => {
		mockState.listActive.mockResolvedValueOnce([
			makeSubscription({ sessionID: 'sess1' }),
		]);
		const session = makeMockSession('sess1');
		mockState.getAgentSession.mockReturnValue(session as any);

		// repoFullName missing
		await _internals.handlePrEvent(
			{
				type: 'pr.ci.failed',
				payload: {
					prNumber: 42,
				},
			},
			TEST_DIR,
			makeConfig(),
		);

		expect(session.pendingAdvisoryMessages).toHaveLength(0);
	});

	test('does not dedupe different event types for same PR', async () => {
		const session = makeMockSession('sess1');
		// Use mockReturnValue (not mockResolvedValueOnce) because handlePrEvent
		// is called twice in this test and listActive must return subscriptions both times
		mockState.listActive.mockReturnValue([
			makeSubscription({ sessionID: 'sess1' }),
		]);
		mockState.getAgentSession.mockReturnValue(session as any);

		// First event: ci.failed
		await _internals.handlePrEvent(
			{
				type: 'pr.ci.failed',
				payload: {
					prNumber: 42,
					repoFullName: 'owner/repo',
					checkName: 'ci/build',
					checkState: 'failure',
				},
			},
			TEST_DIR,
			makeConfig(),
		);

		expect(session.pendingAdvisoryMessages).toHaveLength(1);

		// Different event type: merge.conflict for same PR â€” should NOT be deduped
		await _internals.handlePrEvent(
			{
				type: 'pr.merge.conflict',
				payload: {
					prNumber: 42,
					repoFullName: 'owner/repo',
					prUrl: 'https://github.com/owner/repo/pull/42',
				},
			},
			TEST_DIR,
			makeConfig(),
		);

		// Both messages should be present
		expect(session.pendingAdvisoryMessages).toHaveLength(2);
		const types = session.pendingAdvisoryMessages.map((m: string) =>
			m.includes('pr.ci.failed')
				? 'pr.ci.failed'
				: m.includes('pr.merge.conflict')
					? 'pr.merge.conflict'
					: 'other',
		);
		expect(types).toContain('pr.ci.failed');
		expect(types).toContain('pr.merge.conflict');
	});

	test('comment body is truncated to 200 characters', async () => {
		const session = makeMockSession('sess1');
		mockState.listActive.mockResolvedValueOnce([
			makeSubscription({ sessionID: 'sess1' }),
		]);
		mockState.getAgentSession.mockReturnValue(session as any);

		const longComment = 'A'.repeat(500);

		await _internals.handlePrEvent(
			{
				type: 'pr.new.comment',
				payload: {
					prNumber: 42,
					repoFullName: 'owner/repo',
					prUrl: 'https://github.com/owner/repo/pull/42',
					author: 'reviewer',
					body: longComment,
				},
			},
			TEST_DIR,
			makeConfig(),
		);

		expect(session.pendingAdvisoryMessages).toHaveLength(1);
		// The message should contain only the first 200 chars of the comment
		const commentPart =
			session.pendingAdvisoryMessages[0].split('Comment: ')[1];
		expect(commentPart.length).toBe(200);
		expect(commentPart).toBe('A'.repeat(200));
	});
});

describe('formatAdvisory', () => {
	beforeEach(() => {
		setupMocks();
	});

	afterEach(() => {
		restoreInternals();
	});

	const ciFailedPayload = {
		prNumber: 42,
		repoFullName: 'owner/repo',
		prUrl: 'https://github.com/owner/repo/pull/42',
		checkName: 'ci/build',
		checkState: 'failure',
		errorMessage: 'Build failed',
	};

	const newCommentPayload = {
		prNumber: 42,
		repoFullName: 'owner/repo',
		prUrl: 'https://github.com/owner/repo/pull/42',
		author: 'reviewer',
		body: 'Looks good!',
	};

	const mergeConflictPayload = {
		prNumber: 42,
		repoFullName: 'owner/repo',
		prUrl: 'https://github.com/owner/repo/pull/42',
	};

	test('pr.ci.failed advisory contains dedup token', async () => {
		const session = makeMockSession('sess1');
		mockState.listActive.mockResolvedValueOnce([
			makeSubscription({ sessionID: 'sess1' }),
		]);
		mockState.getAgentSession.mockReturnValue(session as any);

		await _internals.handlePrEvent(
			{ type: 'pr.ci.failed', payload: ciFailedPayload },
			TEST_DIR,
			makeConfig(),
		);

		expect(session.pendingAdvisoryMessages[0]).toContain(
			'[pr-monitor:pr.ci.failed:owner/repo#42]',
		);
	});

	test('pr.new.comment advisory contains dedup token', async () => {
		const session = makeMockSession('sess1');
		mockState.listActive.mockResolvedValueOnce([
			makeSubscription({ sessionID: 'sess1' }),
		]);
		mockState.getAgentSession.mockReturnValue(session as any);

		await _internals.handlePrEvent(
			{ type: 'pr.new.comment', payload: newCommentPayload },
			TEST_DIR,
			makeConfig(),
		);

		// B8 (issue #1976): content events (comments/reviews) carry a per-event
		// identity suffix (@author:hash) before the closing bracket, so assert
		// the stable token PREFIX rather than the exact per-PR token.
		expect(session.pendingAdvisoryMessages[0]).toContain(
			'[pr-monitor:pr.new.comment:owner/repo#42',
		);
	});

	test('pr.merge.conflict advisory contains dedup token', async () => {
		const session = makeMockSession('sess1');
		mockState.listActive.mockResolvedValueOnce([
			makeSubscription({ sessionID: 'sess1' }),
		]);
		mockState.getAgentSession.mockReturnValue(session as any);

		await _internals.handlePrEvent(
			{ type: 'pr.merge.conflict', payload: mergeConflictPayload },
			TEST_DIR,
			makeConfig(),
		);

		expect(session.pendingAdvisoryMessages[0]).toContain(
			'[pr-monitor:pr.merge.conflict:owner/repo#42]',
		);
	});

	test('unknown event type returns null and does not deliver', async () => {
		const session = makeMockSession('sess1');
		mockState.listActive.mockResolvedValueOnce([
			makeSubscription({ sessionID: 'sess1' }),
		]);
		mockState.getAgentSession.mockReturnValue(session as any);

		await _internals.handlePrEvent(
			{
				type: 'pr.unknown.event',
				payload: { prNumber: 42, repoFullName: 'owner/repo' },
			},
			TEST_DIR,
			makeConfig(),
		);

		expect(session.pendingAdvisoryMessages).toHaveLength(0);
	});
});
