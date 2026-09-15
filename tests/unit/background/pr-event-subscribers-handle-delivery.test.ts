/**
 * Phase 1 PR Event Subscribers tests.
 *
 * Tests: handlePrEvent delivery and subscription matching.
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
});
