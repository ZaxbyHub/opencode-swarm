/**
 * Phase 1 PR Event Subscribers tests.
 *
 * Tests: registerPrEventSubscribers, handlePrEvent, formatAdvisory.
 * Uses _internals DI seam for full mock isolation — no cross-file pollution.
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

// ── Test Fixtures ──────────────────────────────────────────────────

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
		lastCheckedAt: Date.now() - 60_000,
		isWatching: true,
		hasUnaddressedEvents: false,
		status: 'active',
		createdAt: Date.now() - 120_000,
		updatedAt: Date.now() - 60_000,
		errorCount: 0,
		...overrides,
	};
}

// ── Mock State ─────────────────────────────────────────────────────

interface MockState {
	listActive: ReturnType<typeof mock>;
	getAgentSession: ReturnType<typeof mock>;
	log: ReturnType<typeof mock>;
	getGlobalEventBus: ReturnType<typeof mock>;
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
		log: mock(() => {}),
		getGlobalEventBus: mock(() => mockState.busInstance),
		busInstance: {
			subscribe: mock(() => () => {}),
		},
	};

	_internals.listActive = mockState.listActive as typeof _internals.listActive;
	_internals.getAgentSession =
		mockState.getAgentSession as typeof _internals.getAgentSession;
	_internals.log = mockState.log as typeof _internals.log;
	_internals.getGlobalEventBus =
		mockState.getGlobalEventBus as typeof _internals.getGlobalEventBus;
}

function restoreInternals(): void {
	if (savedInternals) {
		_internals.listActive = savedInternals.listActive;
		_internals.getAgentSession = savedInternals.getAgentSession;
		_internals.log = savedInternals.log;
		_internals.getGlobalEventBus = savedInternals.getGlobalEventBus;
	}
}

// ── Helpers ────────────────────────────────────────────────────────

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

// ── Tests ──────────────────────────────────────────────────────────

describe('PrEventSubscriberOptions — construction', () => {
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

		// Should have called subscribe for all 3 event types
		expect(mockState.busInstance.subscribe).toHaveBeenCalledTimes(3);
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

		cleanup();
	});

	test('skips subscriber when notify_ci_failure config flag is false', () => {
		registerPrEventSubscribers({
			directory: TEST_DIR,
			config: makeConfig({
				notify_ci_failure: false,
			}) as PrEventSubscriberOptions['config'],
		});

		// Only 2 event types subscribed (new_comment + merge_conflict)
		expect(mockState.busInstance.subscribe).toHaveBeenCalledTimes(2);

		const subscribedTypes = mockState.busInstance.subscribe.mock.calls.map(
			(c: unknown[]) => c[0],
		);
		expect(subscribedTypes).not.toContain('pr.ci.failed');
		expect(subscribedTypes).toContain('pr.new.comment');
		expect(subscribedTypes).toContain('pr.merge.conflict');
	});

	test('skips subscriber when notify_new_comments config flag is false', () => {
		registerPrEventSubscribers({
			directory: TEST_DIR,
			config: makeConfig({
				notify_new_comments: false,
			}) as PrEventSubscriberOptions['config'],
		});

		expect(mockState.busInstance.subscribe).toHaveBeenCalledTimes(2);
		const subscribedTypes = mockState.busInstance.subscribe.mock.calls.map(
			(c: unknown[]) => c[0],
		);
		expect(subscribedTypes).toContain('pr.ci.failed');
		expect(subscribedTypes).not.toContain('pr.new.comment');
		expect(subscribedTypes).toContain('pr.merge.conflict');
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
		expect(session.pendingAdvisoryMessages[0]).toContain(
			'[pr-monitor:pr.new.comment:org/repo#99]',
		);
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

		// Same event again — should be deduplicated
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

		// 1. Deliver pr.ci.failed → expect advisory delivered
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

		// 2. Deliver pr.new.comment → expect advisory delivered (different type)
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

		// 3. Deliver pr.ci.failed again → expect DEDUPED (same type+PR, scanned from all messages)
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

		// Still only 2 messages — the second ci.failed was deduped
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

		// Different event type: merge.conflict for same PR — should NOT be deduped
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

		expect(session.pendingAdvisoryMessages[0]).toContain(
			'[pr-monitor:pr.new.comment:owner/repo#42]',
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

// ── auto_pr_feedback MODE signal injection ───────────────────────────

describe('auto_pr_feedback MODE signal injection', () => {
	beforeEach(() => {
		setupMocks();
	});

	afterEach(() => {
		restoreInternals();
	});

	test('MODE signal injected when auto_pr_feedback=true and event is pr.ci.failed', async () => {
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
				},
			},
			TEST_DIR,
			makeConfig({ auto_pr_feedback: true }),
		);

		// Advisory should still be delivered
		expect(session.pendingAdvisoryMessages.length).toBeGreaterThanOrEqual(1);
		const modeSignal = session.pendingAdvisoryMessages.find((m: string) =>
			m.includes('[MODE: PR_FEEDBACK'),
		);
		expect(modeSignal).toBeDefined();
		expect(modeSignal).toBe(
			'[MODE: PR_FEEDBACK pr="https://github.com/owner/repo/pull/42"]',
		);
	});

	test('MODE signal injected when auto_pr_feedback=true and event is pr.merge.conflict', async () => {
		const session = makeMockSession('sess1');
		mockState.listActive.mockResolvedValueOnce([
			makeSubscription({ sessionID: 'sess1' }),
		]);
		mockState.getAgentSession.mockReturnValue(session as any);

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
			makeConfig({ auto_pr_feedback: true }),
		);

		const modeSignal = session.pendingAdvisoryMessages.find((m: string) =>
			m.includes('[MODE: PR_FEEDBACK'),
		);
		expect(modeSignal).toBeDefined();
		expect(modeSignal).toBe(
			'[MODE: PR_FEEDBACK pr="https://github.com/owner/repo/pull/42"]',
		);
	});

	test('NO MODE signal injected when auto_pr_feedback=false', async () => {
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
				},
			},
			TEST_DIR,
			makeConfig({ auto_pr_feedback: false }),
		);

		// Advisory still delivered
		expect(session.pendingAdvisoryMessages.length).toBe(1);
		const modeSignals = session.pendingAdvisoryMessages.filter((m: string) =>
			m.includes('[MODE: PR_FEEDBACK'),
		);
		expect(modeSignals).toHaveLength(0);
	});

	test('NO MODE signal for pr.new.comment event (not in AUTO_PR_FEEDBACK_EVENTS)', async () => {
		const session = makeMockSession('sess1');
		mockState.listActive.mockResolvedValueOnce([
			makeSubscription({ sessionID: 'sess1' }),
		]);
		mockState.getAgentSession.mockReturnValue(session as any);

		await _internals.handlePrEvent(
			{
				type: 'pr.new.comment',
				payload: {
					prNumber: 42,
					repoFullName: 'owner/repo',
					prUrl: 'https://github.com/owner/repo/pull/42',
					author: 'reviewer',
					body: 'LGTM!',
				},
			},
			TEST_DIR,
			makeConfig({ auto_pr_feedback: true }),
		);

		// Advisory still delivered
		expect(session.pendingAdvisoryMessages.length).toBe(1);
		const modeSignals = session.pendingAdvisoryMessages.filter((m: string) =>
			m.includes('[MODE: PR_FEEDBACK'),
		);
		expect(modeSignals).toHaveLength(0);
	});

	test('NO MODE signal when payload has no prUrl', async () => {
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
					checkName: 'ci/build',
					checkState: 'failure',
					// prUrl intentionally missing
				},
			},
			TEST_DIR,
			makeConfig({ auto_pr_feedback: true }),
		);

		// Advisory still delivered (prUrl is optional for advisory)
		expect(session.pendingAdvisoryMessages.length).toBe(1);
		const modeSignals = session.pendingAdvisoryMessages.filter((m: string) =>
			m.includes('[MODE: PR_FEEDBACK'),
		);
		expect(modeSignals).toHaveLength(0);
	});

	test('MODE signal format is exactly [MODE: PR_FEEDBACK pr="URL"]', async () => {
		const session = makeMockSession('sess1');
		mockState.listActive.mockResolvedValueOnce([
			makeSubscription({ sessionID: 'sess1', prNumber: 99 }),
		]);
		mockState.getAgentSession.mockReturnValue(session as any);

		const prUrl = 'https://github.com/owner/repo/pull/99';

		await _internals.handlePrEvent(
			{
				type: 'pr.merge.conflict',
				payload: {
					prNumber: 99,
					repoFullName: 'owner/repo',
					prUrl,
				},
			},
			TEST_DIR,
			makeConfig({ auto_pr_feedback: true }),
		);

		const modeSignal = session.pendingAdvisoryMessages.find((m: string) =>
			m.startsWith('[MODE: PR_FEEDBACK'),
		);
		expect(modeSignal).toBe(`[MODE: PR_FEEDBACK pr="${prUrl}"]`);
	});

	test('MODE signal escapes " and ] characters from prUrl', async () => {
		const session = makeMockSession('sess1');
		mockState.listActive.mockResolvedValueOnce([
			makeSubscription({ sessionID: 'sess1', prNumber: 99 }),
		]);
		mockState.getAgentSession.mockReturnValue(session as any);

		const maliciousUrl = 'https://github.com/owner/repo/pull/99"]INJECTION';

		await _internals.handlePrEvent(
			{
				type: 'pr.merge.conflict',
				payload: {
					prNumber: 99,
					repoFullName: 'owner/repo',
					prUrl: maliciousUrl,
				},
			},
			TEST_DIR,
			makeConfig({ auto_pr_feedback: true }),
		);

		const modeSignal = session.pendingAdvisoryMessages.find((m: string) =>
			m.startsWith('[MODE: PR_FEEDBACK'),
		);
		expect(modeSignal).toBeDefined();
		// The " and ] should be stripped
		expect(modeSignal).toBe(
			'[MODE: PR_FEEDBACK pr="https://github.com/owner/repo/pull/99INJECTION"]',
		);
		expect(modeSignal).not.toContain('"]INJECTION');
	});

	test('advisory is delivered alongside MODE signal', async () => {
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
					errorMessage: 'Build failed',
				},
			},
			TEST_DIR,
			makeConfig({ auto_pr_feedback: true }),
		);

		// Should have both advisory and MODE signal
		expect(session.pendingAdvisoryMessages.length).toBe(2);

		const advisory = session.pendingAdvisoryMessages.find((m: string) =>
			m.includes('[pr-monitor:pr.ci.failed'),
		);
		expect(advisory).toBeDefined();
		expect(advisory).toContain('ci/build');
		expect(advisory).toContain('failed');

		const modeSignal = session.pendingAdvisoryMessages.find((m: string) =>
			m.startsWith('[MODE: PR_FEEDBACK'),
		);
		expect(modeSignal).toBe(
			'[MODE: PR_FEEDBACK pr="https://github.com/owner/repo/pull/42"]',
		);
	});
});
