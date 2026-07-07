import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	_internals,
	handlePrMonitorStatusCommand,
} from '../../../src/commands/pr-monitor-status.js';
import { COMMAND_REGISTRY } from '../../../src/commands/registry.js';

const { formatRelativeTime } = _internals;
const fixedNow = 1_700_000_000_000;

function withFixedNow<T>(callback: () => T): T {
	const originalNow = Date.now;
	Date.now = () => fixedNow;
	try {
		return callback();
	} finally {
		Date.now = originalNow;
	}
}

// ---------------------------------------------------------------------------
// Mock listActive via _internals DI seam — no mock.module needed
// ---------------------------------------------------------------------------
const mockListActive = mock(() => Promise.resolve([]));

// ---------------------------------------------------------------------------
// Temp directory
// ---------------------------------------------------------------------------
let tempDir: string;
let savedInternals: typeof _internals;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), 'pr-status-test-'));
	savedInternals = { ..._internals };
	_internals.listActive = mockListActive;
	mockListActive.mockReset();
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
	mockListActive.mockReset();
	_internals.listActive = savedInternals.listActive;
});

// ---------------------------------------------------------------------------
// formatRelativeTime tests
// ---------------------------------------------------------------------------
describe('formatRelativeTime', () => {
	test('returns "just now" for timestamps within the last 5 seconds', () => {
		withFixedNow(() => {
			expect(formatRelativeTime(fixedNow)).toBe('just now');
			expect(formatRelativeTime(fixedNow - 1000)).toBe('just now');
			expect(formatRelativeTime(fixedNow - 4999)).toBe('just now');
		});
	});

	test('returns "just now" for future timestamps', () => {
		withFixedNow(() => {
			expect(formatRelativeTime(fixedNow + 1000)).toBe('just now');
		});
	});

	test('returns seconds ago for timestamps under 60 seconds', () => {
		withFixedNow(() => {
			expect(formatRelativeTime(fixedNow - 5000)).toBe('5 seconds ago');
			expect(formatRelativeTime(fixedNow - 30000)).toBe('30 seconds ago');
			expect(formatRelativeTime(fixedNow - 59000)).toBe('59 seconds ago');
		});
	});

	test('returns singular "minute" for 1 minute', () => {
		withFixedNow(() => {
			expect(formatRelativeTime(fixedNow - 60_000)).toBe('1 minute ago');
		});
	});

	test('returns plural "minutes" for multiple minutes', () => {
		withFixedNow(() => {
			expect(formatRelativeTime(fixedNow - 120_000)).toBe('2 minutes ago');
			expect(formatRelativeTime(fixedNow - 300_000)).toBe('5 minutes ago');
			expect(formatRelativeTime(fixedNow - 3_599_000)).toBe('59 minutes ago');
		});
	});

	test('returns singular "hour" for 1 hour', () => {
		withFixedNow(() => {
			expect(formatRelativeTime(fixedNow - 3_600_000)).toBe('1 hour ago');
		});
	});

	test('returns plural "hours" for multiple hours', () => {
		withFixedNow(() => {
			expect(formatRelativeTime(fixedNow - 7_200_000)).toBe('2 hours ago');
			expect(formatRelativeTime(fixedNow - 86_399_000)).toBe('23 hours ago');
		});
	});

	test('returns singular "day" for 1 day', () => {
		withFixedNow(() => {
			expect(formatRelativeTime(fixedNow - 86_400_000)).toBe('1 day ago');
		});
	});

	test('returns plural "days" for multiple days', () => {
		withFixedNow(() => {
			expect(formatRelativeTime(fixedNow - 172_800_000)).toBe('2 days ago');
			expect(formatRelativeTime(fixedNow - 604_800_000)).toBe('7 days ago');
		});
	});
});

// ---------------------------------------------------------------------------
// handlePrMonitorStatusCommand tests
// ---------------------------------------------------------------------------
describe('handlePrMonitorStatusCommand', () => {
	describe('no subscriptions', () => {
		test('returns no-subscriptions message when listActive returns empty', async () => {
			mockListActive.mockImplementation(() => Promise.resolve([]));

			const result = await handlePrMonitorStatusCommand(
				tempDir,
				[],
				'session-1',
			);

			expect(result).toBe('No active PR subscriptions for this session.');
		});

		test('returns no-subscriptions message when session has no subs but other sessions do', async () => {
			mockListActive.mockImplementation(() =>
				Promise.resolve([
					{
						correlationId: 'other-session::owner/repo::1',
						sessionID: 'other-session',
						prNumber: 1,
						repoFullName: 'owner/repo',
						prUrl: 'https://github.com/owner/repo/pull/1',
						lastCheckedAt: Date.now() - 60_000,
						isWatching: true,
						hasUnaddressedEvents: false,
						status: 'active' as const,
						createdAt: Date.now() - 120_000,
						updatedAt: Date.now() - 60_000,
						errorCount: 0,
					},
				]),
			);

			const result = await handlePrMonitorStatusCommand(
				tempDir,
				[],
				'session-1',
			);

			expect(result).toBe('No active PR subscriptions for this session.');
		});
	});

	describe('session has 1 subscription', () => {
		test('returns formatted output with PR details', async () => {
			const lastCheckedAt = Date.now() - 90_000;
			mockListActive.mockImplementation(() =>
				Promise.resolve([
					{
						correlationId: 'session-1::owner/repo::42',
						sessionID: 'session-1',
						prNumber: 42,
						repoFullName: 'owner/repo',
						prUrl: 'https://github.com/owner/repo/pull/42',
						lastCheckedAt,
						isWatching: true,
						hasUnaddressedEvents: false,
						status: 'active' as const,
						createdAt: Date.now() - 300_000,
						updatedAt: lastCheckedAt,
						errorCount: 0,
					},
				]),
			);

			const result = await handlePrMonitorStatusCommand(
				tempDir,
				[],
				'session-1',
			);

			expect(result).toContain('PR Monitor Status — Session: session-1');
			expect(result).toContain('Active subscriptions (1):');
			expect(result).toContain('  1. owner/repo#42');
			expect(result).toContain('URL: https://github.com/owner/repo/pull/42');
			expect(result).toContain('Last checked: 1 minute ago');
			expect(result).toContain('Watching: yes');
			expect(result).toContain('Errors: 0');
		});

		test('shows "Watching: no" when isWatching is false', async () => {
			mockListActive.mockImplementation(() =>
				Promise.resolve([
					{
						correlationId: 'session-1::owner/repo::1',
						sessionID: 'session-1',
						prNumber: 1,
						repoFullName: 'owner/repo',
						prUrl: 'https://github.com/owner/repo/pull/1',
						lastCheckedAt: Date.now() - 30_000,
						isWatching: false,
						hasUnaddressedEvents: false,
						status: 'active' as const,
						createdAt: Date.now() - 60_000,
						updatedAt: Date.now() - 30_000,
						errorCount: 2,
					},
				]),
			);

			const result = await handlePrMonitorStatusCommand(
				tempDir,
				[],
				'session-1',
			);

			expect(result).toContain('Watching: no');
			expect(result).toContain('Errors: 2');
		});
	});

	describe('session has multiple subscriptions', () => {
		test('lists all subscriptions with correct numbering', async () => {
			mockListActive.mockImplementation(() =>
				Promise.resolve([
					{
						correlationId: 'session-1::owner/repo::1',
						sessionID: 'session-1',
						prNumber: 1,
						repoFullName: 'owner/repo',
						prUrl: 'https://github.com/owner/repo/pull/1',
						lastCheckedAt: Date.now() - 60_000,
						isWatching: true,
						hasUnaddressedEvents: false,
						status: 'active' as const,
						createdAt: Date.now() - 120_000,
						updatedAt: Date.now() - 60_000,
						errorCount: 0,
					},
					{
						correlationId: 'session-1::other/repo::2',
						sessionID: 'session-1',
						prNumber: 2,
						repoFullName: 'other/repo',
						prUrl: 'https://github.com/other/repo/pull/2',
						lastCheckedAt: Date.now() - 120_000,
						isWatching: true,
						hasUnaddressedEvents: false,
						status: 'active' as const,
						createdAt: Date.now() - 180_000,
						updatedAt: Date.now() - 120_000,
						errorCount: 0,
					},
					{
						correlationId: 'session-1::third/repo::3',
						sessionID: 'session-1',
						prNumber: 3,
						repoFullName: 'third/repo',
						prUrl: 'https://github.com/third/repo/pull/3',
						lastCheckedAt: Date.now() - 300_000,
						isWatching: false,
						hasUnaddressedEvents: true,
						status: 'active' as const,
						createdAt: Date.now() - 360_000,
						updatedAt: Date.now() - 300_000,
						errorCount: 1,
					},
				]),
			);

			const result = await handlePrMonitorStatusCommand(
				tempDir,
				[],
				'session-1',
			);

			expect(result).toContain('Active subscriptions (3):');
			expect(result).toContain('  1. owner/repo#1');
			expect(result).toContain('  2. other/repo#2');
			expect(result).toContain('  3. third/repo#3');
			// Verify each has its own details section
			expect(result).toContain('URL: https://github.com/owner/repo/pull/1');
			expect(result).toContain('URL: https://github.com/other/repo/pull/2');
			expect(result).toContain('URL: https://github.com/third/repo/pull/3');
		});

		test('structure is correct for 1 subscription', async () => {
			mockListActive.mockImplementation(() =>
				Promise.resolve([
					{
						correlationId: 'session-1::owner/repo::1',
						sessionID: 'session-1',
						prNumber: 1,
						repoFullName: 'owner/repo',
						prUrl: 'https://github.com/owner/repo/pull/1',
						lastCheckedAt: Date.now() - 60_000,
						isWatching: true,
						hasUnaddressedEvents: false,
						status: 'active' as const,
						createdAt: Date.now() - 120_000,
						updatedAt: Date.now() - 60_000,
						errorCount: 0,
					},
				]),
			);

			const result = await handlePrMonitorStatusCommand(
				tempDir,
				[],
				'session-1',
			);

			// Verify structure: header, blank, active count, sub block, blank, total
			const lines = result.split('\n');
			expect(lines[0]).toBe('PR Monitor Status — Session: session-1');
			expect(lines[1]).toBe('');
			expect(lines[2]).toBe('Active subscriptions (1):');
			expect(lines[3]).toBe('  1. owner/repo#1');
			expect(lines[7]).toBe('     Errors: 0');
			// Blank after last sub before total
			expect(lines[8]).toBe('');
			// No total line shown when session count equals total (1 === 1)
			expect(lines[9]).toBeUndefined();
		});
	});

	describe('filters to current session only', () => {
		test('does not include other sessions subscriptions in output', async () => {
			mockListActive.mockImplementation(() =>
				Promise.resolve([
					{
						correlationId: 'session-1::owner/repo::1',
						sessionID: 'session-1',
						prNumber: 1,
						repoFullName: 'owner/repo',
						prUrl: 'https://github.com/owner/repo/pull/1',
						lastCheckedAt: Date.now() - 60_000,
						isWatching: true,
						hasUnaddressedEvents: false,
						status: 'active' as const,
						createdAt: Date.now() - 120_000,
						updatedAt: Date.now() - 60_000,
						errorCount: 0,
					},
					{
						correlationId: 'other-session::other/repo::2',
						sessionID: 'other-session',
						prNumber: 2,
						repoFullName: 'other/repo',
						prUrl: 'https://github.com/other/repo/pull/2',
						lastCheckedAt: Date.now() - 60_000,
						isWatching: true,
						hasUnaddressedEvents: false,
						status: 'active' as const,
						createdAt: Date.now() - 120_000,
						updatedAt: Date.now() - 60_000,
						errorCount: 0,
					},
					{
						correlationId: 'third-session::third/repo::3',
						sessionID: 'third-session',
						prNumber: 3,
						repoFullName: 'third/repo',
						prUrl: 'https://github.com/third/repo/pull/3',
						lastCheckedAt: Date.now() - 60_000,
						isWatching: true,
						hasUnaddressedEvents: false,
						status: 'active' as const,
						createdAt: Date.now() - 120_000,
						updatedAt: Date.now() - 60_000,
						errorCount: 0,
					},
				]),
			);

			const result = await handlePrMonitorStatusCommand(
				tempDir,
				[],
				'session-1',
			);

			// Only session-1's subscription should appear
			expect(result).toContain('Active subscriptions (1):');
			expect(result).toContain('owner/repo#1');
			// Other sessions should not appear
			expect(result).not.toContain('other/repo#2');
			expect(result).not.toContain('third/repo#3');
			expect(result).not.toContain('other-session');
			expect(result).not.toContain('third-session');
		});
	});

	describe('cross-session total', () => {
		test('shows cross-session total when different from session count', async () => {
			mockListActive.mockImplementation(() =>
				Promise.resolve([
					{
						correlationId: 'session-1::owner/repo::1',
						sessionID: 'session-1',
						prNumber: 1,
						repoFullName: 'owner/repo',
						prUrl: 'https://github.com/owner/repo/pull/1',
						lastCheckedAt: Date.now() - 60_000,
						isWatching: true,
						hasUnaddressedEvents: false,
						status: 'active' as const,
						createdAt: Date.now() - 120_000,
						updatedAt: Date.now() - 60_000,
						errorCount: 0,
					},
					{
						correlationId: 'other-session::other/repo::2',
						sessionID: 'other-session',
						prNumber: 2,
						repoFullName: 'other/repo',
						prUrl: 'https://github.com/other/repo/pull/2',
						lastCheckedAt: Date.now() - 60_000,
						isWatching: true,
						hasUnaddressedEvents: false,
						status: 'active' as const,
						createdAt: Date.now() - 120_000,
						updatedAt: Date.now() - 60_000,
						errorCount: 0,
					},
				]),
			);

			const result = await handlePrMonitorStatusCommand(
				tempDir,
				[],
				'session-1',
			);

			expect(result).toContain('Active subscriptions (1):');
			expect(result).toContain('Total active across all sessions: 2');
		});

		test('omits cross-session total when session count equals total', async () => {
			mockListActive.mockImplementation(() =>
				Promise.resolve([
					{
						correlationId: 'session-1::owner/repo::1',
						sessionID: 'session-1',
						prNumber: 1,
						repoFullName: 'owner/repo',
						prUrl: 'https://github.com/owner/repo/pull/1',
						lastCheckedAt: Date.now() - 60_000,
						isWatching: true,
						hasUnaddressedEvents: false,
						status: 'active' as const,
						createdAt: Date.now() - 120_000,
						updatedAt: Date.now() - 60_000,
						errorCount: 0,
					},
				]),
			);

			const result = await handlePrMonitorStatusCommand(
				tempDir,
				[],
				'session-1',
			);

			expect(result).not.toContain('Total active across all sessions');
		});
	});
	// Regression for issue #1484: the CLI `run pr status` path has no session
	// context (sessionID ''), so a session filter falsely reported "no
	// subscriptions". With source 'cli', list every active subscription across
	// sessions; all other callers stay session-scoped.
	describe('CLI source (source="cli") — cross-session listing', () => {
		test('lists subscriptions from all sessions with per-record session id', async () => {
			mockListActive.mockImplementation(() =>
				Promise.resolve([
					{
						correlationId: 'ses_real::owner/repo::1',
						sessionID: 'ses_real',
						prNumber: 1,
						repoFullName: 'owner/repo',
						prUrl: 'https://github.com/owner/repo/pull/1',
						lastCheckedAt: Date.now() - 60_000,
						isWatching: true,
						hasUnaddressedEvents: false,
						status: 'active' as const,
						createdAt: Date.now() - 120_000,
						updatedAt: Date.now() - 60_000,
						errorCount: 0,
					},
					{
						correlationId: 'ses_other::other/repo::2',
						sessionID: 'ses_other',
						prNumber: 2,
						repoFullName: 'other/repo',
						prUrl: 'https://github.com/other/repo/pull/2',
						lastCheckedAt: Date.now() - 60_000,
						isWatching: true,
						hasUnaddressedEvents: false,
						status: 'active' as const,
						createdAt: Date.now() - 120_000,
						updatedAt: Date.now() - 60_000,
						errorCount: 0,
					},
				]),
			);

			// CLI passes sessionID '' — pre-fix this filtered to zero rows.
			const result = await handlePrMonitorStatusCommand(tempDir, [], '', 'cli');

			expect(result).toContain('PR Monitor Status — all sessions');
			expect(result).toContain('Active subscriptions (2):');
			expect(result).toContain('owner/repo#1');
			expect(result).toContain('other/repo#2');
			// Cross-session listing discloses the owning session per record.
			expect(result).toContain('Session: ses_real');
			expect(result).toContain('Session: ses_other');
			// Session-scoped artifacts must not appear in the CLI listing.
			expect(result).not.toContain('Total active across all sessions');
		});

		test('empty store returns the generic no-subscriptions message', async () => {
			mockListActive.mockImplementation(() => Promise.resolve([]));

			const result = await handlePrMonitorStatusCommand(tempDir, [], '', 'cli');

			expect(result).toBe('No active PR subscriptions.');
		});

		test('non-CLI source with empty sessionID stays session-scoped (no leak)', async () => {
			mockListActive.mockImplementation(() =>
				Promise.resolve([
					{
						correlationId: 'ses_other::other/repo::2',
						sessionID: 'ses_other',
						prNumber: 2,
						repoFullName: 'other/repo',
						prUrl: 'https://github.com/other/repo/pull/2',
						lastCheckedAt: Date.now() - 60_000,
						isWatching: true,
						hasUnaddressedEvents: false,
						status: 'active' as const,
						createdAt: Date.now() - 120_000,
						updatedAt: Date.now() - 60_000,
						errorCount: 0,
					},
				]),
			);

			// e.g. the agent `swarm_command` tool path (source 'chat') with an
			// empty sessionID must NOT receive a cross-session dump.
			const result = await handlePrMonitorStatusCommand(
				tempDir,
				[],
				'',
				'chat',
			);

			expect(result).toBe('No active PR subscriptions for this session.');
			expect(result).not.toContain('other/repo#2');
		});
	});
});

// ---------------------------------------------------------------------------
// Registry entry tests
// ---------------------------------------------------------------------------
describe('Registry entry for pr status', () => {
	test('pr status is registered in COMMAND_REGISTRY', () => {
		expect(Object.hasOwn(COMMAND_REGISTRY, 'pr status')).toBe(true);
	});

	test('pr status entry has the correct handler and description', () => {
		const entry = COMMAND_REGISTRY['pr status'];
		expect(typeof entry.handler).toBe('function');
		expect(entry.description).toContain('PR monitor subscription status');
		expect(entry.category).toBe('agent');
	});

	test('pr status handler calls handlePrMonitorStatusCommand with correct args', async () => {
		mockListActive.mockImplementation(() => Promise.resolve([]));
		const entry = COMMAND_REGISTRY['pr status'];
		// @ts-expect-error — handler is typed as (ctx: CommandContext) => CommandResult
		const result = await entry.handler({
			directory: tempDir,
			args: [],
			sessionID: 'test-session',
		});

		expect(mockListActive).toHaveBeenCalledTimes(1);
		expect(mockListActive).toHaveBeenCalledWith(tempDir);
		expect(result).toBe('No active PR subscriptions for this session.');
	});
});
