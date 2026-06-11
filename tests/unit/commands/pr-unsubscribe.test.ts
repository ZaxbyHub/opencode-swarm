import { afterEach, describe, expect, mock, test } from 'bun:test';
import { handlePrUnsubscribeCommand } from '../../../src/commands/pr-unsubscribe.js';

// ---------------------------------------------------------------------------
// Helper – minimal stubs so the mock.module factory satisfies ESM resolution
// ---------------------------------------------------------------------------
const voidFn = () => {};
const nullFn = () => null;
const identity = <T>(v: T) => v;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock pr-ref.ts exports
const mockParsePrRef = mock(() => null);
const mockLooksLikePrRef = mock(() => false);

mock.module('../../../src/commands/pr-ref.js', () => ({
	sanitizeUrl: identity,
	sanitizeInstructions: identity,
	hasNonAsciiHostname: () => false,
	isPrivateHost: () => false,
	validateAndSanitizeUrl: () => ({
		sanitized: 'https://github.com/owner/repo/pull/1',
	}),
	parsePrRef: mockParsePrRef,
	detectGitRemote: nullFn,
	parseGitRemoteUrl: nullFn,
	looksLikePrRef: mockLooksLikePrRef,
	resolvePrCommandInput: nullFn,
	_internals: { execSync: voidFn },
}));

// Mock pr-subscriptions.ts exports
const mockUnsubscribe = mock(() => Promise.resolve(null));

mock.module('../../../src/background/pr-subscriptions.js', () => ({
	unsubscribe: mockUnsubscribe,
	buildCorrelationId: (
		sessionID: string,
		repoFullName: string,
		prNumber: number,
	) => `${sessionID}::${repoFullName}::${prNumber}`,
	listActive: nullFn,
	updateSnapshot: nullFn,
	sweepStale: nullFn,
	subscribe: nullFn,
	setOnSubscriptionCreated: voidFn,
	PR_SUBSCRIPTIONS_FILE: 'pr-monitor/subscriptions.jsonl',
}));

afterEach(() => {
	mock.restore();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const SESSION_ID = 'test-session-abc';
const DIRECTORY = '/fake/project';

describe('handlePrUnsubscribeCommand', () => {
	test('1. No args → returns usage message', async () => {
		const result = await handlePrUnsubscribeCommand(DIRECTORY, [], SESSION_ID);
		expect(result).toContain('Usage: /swarm pr unsubscribe');
		expect(result).toContain('<pr-url|owner/repo#N|N>');
	});

	test('2. Invalid PR ref → returns error', async () => {
		// looksLikePrRef returns false for something obviously not a PR ref
		mockLooksLikePrRef.mockReturnValueOnce(false);
		mockParsePrRef.mockReturnValueOnce(null);

		const result = await handlePrUnsubscribeCommand(
			DIRECTORY,
			['not-a-pr-ref'],
			SESSION_ID,
		);
		expect(result).toContain('not a valid PR reference');
		expect(result).toContain('not-a-pr-ref');
	});

	test('3. Unresolvable PR ref (looksLikePrRef=true but parsePrRef=null) → returns resolution error', async () => {
		// looksLikePrRef returns true (looks like a PR ref)
		mockLooksLikePrRef.mockReturnValueOnce(true);
		// but parsePrRef returns null (could not resolve it)
		mockParsePrRef.mockReturnValueOnce(null);

		const result = await handlePrUnsubscribeCommand(
			DIRECTORY,
			['owner/repo#999'],
			SESSION_ID,
		);
		expect(result).toContain('Could not resolve PR reference');
		expect(result).toContain('owner/repo#999');
	});

	test('4. Valid PR ref but no active subscription → Not subscribed message', async () => {
		mockLooksLikePrRef.mockReturnValueOnce(true);
		mockParsePrRef.mockReturnValueOnce({
			owner: 'owner',
			repo: 'repo',
			number: 42,
		});
		// unsubscribe returns null → no active subscription found
		mockUnsubscribe.mockReturnValueOnce(Promise.resolve(null));

		const result = await handlePrUnsubscribeCommand(
			DIRECTORY,
			['owner/repo#42'],
			SESSION_ID,
		);
		expect(result).toContain('Not subscribed');
		expect(result).toContain('owner/repo#42');
		expect(mockUnsubscribe).toHaveBeenCalledWith(
			DIRECTORY,
			`${SESSION_ID}::owner/repo::42`,
		);
	});

	test('5. Valid PR ref + active subscription → calls unsubscribe and returns success', async () => {
		mockLooksLikePrRef.mockReturnValueOnce(true);
		mockParsePrRef.mockReturnValueOnce({
			owner: 'owner',
			repo: 'repo',
			number: 42,
		});
		const correlationId = `${SESSION_ID}::owner/repo::42`;
		const mockRecord = {
			correlationId,
			sessionID: SESSION_ID,
			prNumber: 42,
			repoFullName: 'owner/repo',
			prUrl: 'https://github.com/owner/repo/pull/42',
			lastCheckedAt: Date.now(),
			isWatching: true,
			hasUnaddressedEvents: false,
			status: 'removed' as const,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			errorCount: 0,
		};
		mockUnsubscribe.mockReturnValueOnce(Promise.resolve(mockRecord));

		const result = await handlePrUnsubscribeCommand(
			DIRECTORY,
			['owner/repo#42'],
			SESSION_ID,
		);
		expect(mockUnsubscribe).toHaveBeenCalledWith(DIRECTORY, correlationId);
		expect(result).toContain('Unsubscribed from');
		expect(result).toContain('owner/repo#42');
		expect(result).toContain(SESSION_ID);
	});

	test('6. Unsubscribe throws error → returns error message', async () => {
		mockLooksLikePrRef.mockReturnValueOnce(true);
		mockParsePrRef.mockReturnValueOnce({
			owner: 'owner',
			repo: 'repo',
			number: 42,
		});
		mockUnsubscribe.mockRejectedValueOnce(new Error(' filesystem error'));

		const result = await handlePrUnsubscribeCommand(
			DIRECTORY,
			['owner/repo#42'],
			SESSION_ID,
		);
		expect(result).toContain('Error: Failed to unsubscribe');
		expect(result).toContain('filesystem error');
	});

	test('7. Registry entry exists for "pr unsubscribe"', async () => {
		// Dynamic import to avoid top-level import of registry (which wires the whole plugin)
		const { COMMAND_REGISTRY } = await import(
			'../../../src/commands/registry.js'
		);
		expect(COMMAND_REGISTRY['pr unsubscribe']).toBeDefined();
		expect(typeof COMMAND_REGISTRY['pr unsubscribe'].handler).toBe('function');
	});
});
