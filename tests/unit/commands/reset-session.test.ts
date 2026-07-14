import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	handleResetSessionCommand,
} from '../../../src/commands/reset-session';
import {
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';

let testDir: string;

beforeEach(() => {
	resetSwarmState();
	testDir = mkdtempSync(path.join(os.tmpdir(), 'reset-session-test-'));
	mkdirSync(path.join(testDir, '.swarm', 'session'), { recursive: true });
});

afterEach(() => {
	try {
		rmSync(testDir, { recursive: true, force: true });
	} catch {
		// Ignore cleanup errors
	}
});

describe('handleResetSessionCommand', () => {
	it('deletes state.json when it exists', async () => {
		const stateFile = path.join(testDir, '.swarm', 'session', 'state.json');
		writeFileSync(stateFile, JSON.stringify({ test: 'data' }));
		expect(existsSync(stateFile)).toBe(true);

		const result = await handleResetSessionCommand(testDir, []);

		expect(existsSync(stateFile)).toBe(false);
		expect(result).toContain('Deleted .swarm/session/state.json');
	});

	it('auto-backs up session state before deletion (#1692)', async () => {
		const stateFile = path.join(testDir, '.swarm', 'session', 'state.json');
		writeFileSync(stateFile, JSON.stringify({ keep: 'me' }));

		const result = await handleResetSessionCommand(testDir, []);

		expect(result).toContain('📦 Backed up session state');
		// Original deleted, but a backup copy exists.
		expect(existsSync(stateFile)).toBe(false);
		const backupsRoot = path.join(testDir, '.swarm', 'reset-backups');
		expect(existsSync(backupsRoot)).toBe(true);
	});

	it('reset-session still completes when the auto-backup throws (fail-open, #1692)', async () => {
		const stateFile = path.join(testDir, '.swarm', 'session', 'state.json');
		writeFileSync(stateFile, JSON.stringify({ a: 1 }));
		const original = _internals.backupSwarmStateBeforeReset;
		_internals.backupSwarmStateBeforeReset = () => {
			throw new Error('boom');
		};
		try {
			const result = await handleResetSessionCommand(testDir, []);
			expect(result).toContain('Auto-backup failed');
			expect(existsSync(stateFile)).toBe(false);
		} finally {
			_internals.backupSwarmStateBeforeReset = original;
		}
	});

	it('handles missing state.json gracefully', async () => {
		const stateFile = path.join(testDir, '.swarm', 'session', 'state.json');
		expect(existsSync(stateFile)).toBe(false);

		const result = await handleResetSessionCommand(testDir, []);

		expect(result).toContain('state.json not found');
	});

	it('clears in-memory sessions', async () => {
		// Pre-populate agent sessions
		startAgentSession('session-1', 'coder');
		startAgentSession('session-2', 'reviewer');
		expect(swarmState.agentSessions.size).toBe(2);

		const result = await handleResetSessionCommand(testDir, []);

		expect(swarmState.agentSessions.size).toBe(0);
		expect(result).toContain('Cleared 2 in-memory agent session(s)');
	});

	it('clears in-memory sessions even when state.json does not exist', async () => {
		startAgentSession('session-1', 'coder');
		startAgentSession('session-2', 'architect');
		startAgentSession('session-3', 'reviewer');
		expect(swarmState.agentSessions.size).toBe(3);

		const result = await handleResetSessionCommand(testDir, []);

		expect(swarmState.agentSessions.size).toBe(0);
		expect(result).toContain('Cleared 3 in-memory agent session(s)');
		expect(result).toContain('state.json not found');
	});

	it('cleans other session files while preserving state.json', async () => {
		const sessionDir = path.join(testDir, '.swarm', 'session');
		const stateFile = path.join(sessionDir, 'state.json');
		const cacheFile = path.join(sessionDir, 'delegation-cache.json');
		const tempFile = path.join(sessionDir, 'temp-session.tmp');

		writeFileSync(stateFile, JSON.stringify({ agentSessions: {} }));
		writeFileSync(cacheFile, JSON.stringify({ chains: [] }));
		writeFileSync(tempFile, 'temporary data');

		expect(existsSync(stateFile)).toBe(true);
		expect(existsSync(cacheFile)).toBe(true);
		expect(existsSync(tempFile)).toBe(true);

		const result = await handleResetSessionCommand(testDir, []);

		// state.json should be deleted (primary cleanup)
		expect(existsSync(stateFile)).toBe(false);
		// Other session files should also be deleted
		expect(existsSync(cacheFile)).toBe(false);
		expect(existsSync(tempFile)).toBe(false);
		// Each additional file is reported individually (✓ Deleted <file>)
		// rather than as a single "Cleaned N additional session file(s)"
		// summary — see src/commands/reset-session.ts, which switched to
		// per-file reporting so a single EBUSY/locked file doesn't hide the
		// status of the others (FR-006 SC-010).
		expect(result).toContain('✓ Deleted delegation-cache.json');
		expect(result).toContain('✓ Deleted temp-session.tmp');
		const deletedOtherFiles = result
			.split('\n')
			.filter((line) => line.startsWith('✓ Deleted'));
		expect(deletedOtherFiles).toHaveLength(2);
	});

	it('reports zero additional files when session dir is empty or only has state.json', async () => {
		const sessionDir = path.join(testDir, '.swarm', 'session');
		const stateFile = path.join(sessionDir, 'state.json');
		writeFileSync(stateFile, JSON.stringify({ agentSessions: {} }));

		const result = await handleResetSessionCommand(testDir, []);

		expect(existsSync(stateFile)).toBe(false);
		// No additional files means no per-file "✓ Deleted <file>" lines are
		// emitted at all (see src/commands/reset-session.ts — the summary
		// count line was replaced with per-file reporting).
		const deletedOtherFiles = result
			.split('\n')
			.filter((line) => line.startsWith('✓ Deleted'));
		expect(deletedOtherFiles).toHaveLength(0);
	});

	// ─────────────────────────────────────────────────────────────────────
	// FR-004 stale worktree/branch reconciliation (task 3.2)
	// ─────────────────────────────────────────────────────────────────────

	it('FR-004: invokes cleanupOrphanedBranches with empty active list', async () => {
		const mockFn = mock(() =>
			Promise.resolve({ removed: [], skipped: [], errors: [] }),
		);
		const original = _internals.cleanupOrphanedBranches;
		_internals.cleanupOrphanedBranches = mockFn;

		try {
			await handleResetSessionCommand(testDir, []);

			expect(mockFn).toHaveBeenCalledTimes(1);
			expect(mockFn).toHaveBeenCalledWith(testDir, []);
		} finally {
			_internals.cleanupOrphanedBranches = original;
		}
	});

	it('FR-004: cleanup failure does NOT abort session-file reset — best-effort', async () => {
		const mockFn = mock(() => Promise.reject(new Error('git failed')));
		const original = _internals.cleanupOrphanedBranches;
		_internals.cleanupOrphanedBranches = mockFn;

		try {
			// Pre-populate session files
			const stateFile = path.join(testDir, '.swarm', 'session', 'state.json');
			writeFileSync(stateFile, JSON.stringify({ test: 'data' }));
			const cacheFile = path.join(
				testDir,
				'.swarm',
				'session',
				'delegation-cache.json',
			);
			writeFileSync(cacheFile, JSON.stringify({ chains: [] }));

			const result = await handleResetSessionCommand(testDir, []);

			// Session files must still be deleted despite cleanup failure
			expect(existsSync(stateFile)).toBe(false);
			expect(existsSync(cacheFile)).toBe(false);
			// Best-effort warning must appear in output
			expect(result).toContain('⚠️ Failed to cleanup orphan branches');
		} finally {
			_internals.cleanupOrphanedBranches = original;
		}
	});

	it('FR-004: successful orphan branch removal reported in output', async () => {
		const mockFn = mock(() =>
			Promise.resolve({
				removed: ['swarm-lane/sess-123/lane-1'],
				skipped: [],
				errors: [],
			}),
		);
		const original = _internals.cleanupOrphanedBranches;
		_internals.cleanupOrphanedBranches = mockFn;

		try {
			const result = await handleResetSessionCommand(testDir, []);

			expect(result).toContain('Removed 1 orphan swarm-lane branch(es)');
		} finally {
			_internals.cleanupOrphanedBranches = original;
		}
	});

	it('FR-004: in-memory agentSessions and delegationChains cleared even when cleanupOrphanedBranches throws', async () => {
		const mockFn = mock(() => Promise.reject(new Error('git exploded')));
		const original = _internals.cleanupOrphanedBranches;
		_internals.cleanupOrphanedBranches = mockFn;

		try {
			startAgentSession('sess-1', 'coder');
			startAgentSession('sess-2', 'reviewer');
			expect(swarmState.agentSessions.size).toBe(2);

			const result = await handleResetSessionCommand(testDir, []);

			// In-memory state cleared regardless of cleanup failure
			expect(swarmState.agentSessions.size).toBe(0);
			expect(result).toContain('Cleared 2 in-memory agent session(s)');
			expect(result).toContain('Cleared 0 delegation chain(s)');
		} finally {
			_internals.cleanupOrphanedBranches = original;
		}
	});
});
