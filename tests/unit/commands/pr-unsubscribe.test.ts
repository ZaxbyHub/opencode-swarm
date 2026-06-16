import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
	_internals,
	handlePrUnsubscribeCommand,
} from '../../../src/commands/pr-unsubscribe';

// ---------------------------------------------------------------------------
// Mocks via _internals DI seam — no mock.module needed
// ---------------------------------------------------------------------------

const mockUnsubscribe = mock(() => Promise.resolve(null));
const mockBuildCorrelationId = mock(
	(sessionID: string, repoFullName: string, prNumber: number) =>
		`${sessionID}::${repoFullName}::${prNumber}`,
);
const mockParsePrRef = mock(() => null);
const mockLooksLikePrRef = mock(() => false);

let savedInternals: typeof _internals;

beforeEach(() => {
	savedInternals = { ..._internals };
	_internals.unsubscribe = mockUnsubscribe;
	_internals.buildCorrelationId = mockBuildCorrelationId;
	_internals.parsePrRef = mockParsePrRef;
	_internals.looksLikePrRef = mockLooksLikePrRef;
});

afterEach(() => {
	mockUnsubscribe.mockReset();
	mockParsePrRef.mockReset();
	mockLooksLikePrRef.mockReset();
	// mockBuildCorrelationId keeps its default implementation across tests;
	// only clear call history (mockClear), do NOT reset the implementation.
	mockBuildCorrelationId.mockClear();
	_internals.unsubscribe = savedInternals.unsubscribe;
	_internals.buildCorrelationId = savedInternals.buildCorrelationId;
	_internals.parsePrRef = savedInternals.parsePrRef;
	_internals.looksLikePrRef = savedInternals.looksLikePrRef;
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
