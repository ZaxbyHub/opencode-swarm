/**
 * Phase 1 PR Event Subscribers tests.
 *
 * Tests: handlePrEvent deduplication and edge cases.
 * Uses _internals DI seam for full mock isolation â€” no cross-file pollution.
 *
 * The _internals seam is added to pr-event-subscribers.ts specifically for
 * testing: it exposes handlePrEvent, getGlobalEventBus, listActive,
 * getAgentSession, and log so tests can replace them with mocks.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as path from 'node:path';
import { _internals } from '../../../src/background/pr-event-subscribers';
import type { PrSubscriptionRecord } from '../../../src/background/pr-subscriptions';
import { acquirePrFeedbackBackgroundLease } from '../../../tests/helpers/pr-feedback-background-lease';
import { canonicalTmpDir as canonicalTempRoot } from '../../../tests/helpers/tmpdir';

// â”€â”€ Test Fixtures â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const TEST_DIR = path.join(canonicalTempRoot(), 'pr-event-subscribers-test');

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
	const repoFullName = overrides.repoFullName ?? 'owner/repo';
	const prNumber = overrides.prNumber ?? 42;
	return {
		correlationId: 'sess1::owner/repo::42',
		sessionID: 'sess1',
		prNumber,
		repoFullName,
		prUrl: `https://github.com/${repoFullName}/pull/${prNumber}`,
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
let releaseBackground: (() => void) | null = null;

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

describe('handlePrEvent', () => {
	beforeEach(async () => {
		releaseBackground = await acquirePrFeedbackBackgroundLease();
		setupMocks();
	});

	afterEach(() => {
		try {
			restoreInternals();
		} finally {
			releaseBackground?.();
			releaseBackground = null;
		}
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
