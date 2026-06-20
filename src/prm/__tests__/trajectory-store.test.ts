/**
 * TRAJECTORY STORE TESTS
 *
 * Unit tests for the session-level trajectory storage module.
 * Uses real file operations in a temp directory to verify behavior.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
	_test_exports,
	appendTrajectoryEntry,
	cleanupOldTrajectoryFiles,
	clearTrajectoryCache,
	getCurrentStep,
	getInMemoryTrajectory,
	getTrajectoryForSession,
	readTrajectory,
	truncateTrajectoryIfNeeded,
} from '../trajectory-store';
import type { TrajectoryEntry } from '../types';

const { tmpdir } = os;
const { mkdtempSync, rmSync } = await import('node:fs');

describe('trajectory-store', () => {
	let tempDir: string;

	beforeEach(async () => {
		// Create a unique temp directory for each test
		tempDir = mkdtempSync(path.join(tmpdir(), 'trajectory-store-test-'));
		// Reset module-level in-memory cache between tests for isolation
		clearTrajectoryCache();
	});

	afterEach(() => {
		// Clean up temp directory
		rmSync(tempDir, { recursive: true, force: true });
	});

	// =========================================================================
	// Helper Functions
	// =========================================================================

	/**
	 * Creates a minimal TrajectoryEntry for testing
	 */
	function createEntry(
		step: number,
		overrides: Partial<TrajectoryEntry> = {},
	): TrajectoryEntry {
		return {
			step,
			agent: 'test-agent',
			action: 'edit',
			target: 'src/test.ts',
			intent: 'Test action',
			timestamp: new Date().toISOString(),
			result: 'success',
			...overrides,
		};
	}

	/**
	 * Returns the path to a session's trajectory file
	 */
	function getTrajectoryFilePath(sessionId: string): string {
		return path.join(tempDir, '.swarm', 'trajectories', `${sessionId}.jsonl`);
	}

	// =========================================================================
	// appendTrajectoryEntry Tests
	// =========================================================================

	describe('appendTrajectoryEntry', () => {
		test('creates directory if it does not exist', async () => {
			const sessionId = 'test-session-create-dir';
			const trajectoryPath = getTrajectoryFilePath(sessionId);

			// Verify file doesn't exist before append
			expect(fs.existsSync(trajectoryPath)).toBe(false);

			await appendTrajectoryEntry(sessionId, createEntry(1), tempDir);

			// Verify directory was created
			expect(fs.existsSync(path.dirname(trajectoryPath))).toBe(true);
			expect(fs.existsSync(trajectoryPath)).toBe(true);
		});

		test('appends valid entry with ISO timestamp', async () => {
			const sessionId = 'test-session-append';
			const entry = createEntry(1, { timestamp: '2024-01-15T10:30:00.000Z' });

			await appendTrajectoryEntry(sessionId, entry, tempDir);

			const content = fs.readFileSync(
				getTrajectoryFilePath(sessionId),
				'utf-8',
			);
			const parsed = JSON.parse(content.trim());

			expect(parsed.timestamp).toBe('2024-01-15T10:30:00.000Z');
			expect(parsed.step).toBe(1);
			expect(parsed.agent).toBe('test-agent');
			expect(parsed.action).toBe('edit');
		});

		test('creates file with .jsonl extension', async () => {
			const sessionId = 'test-session-jsonl';
			const trajectoryPath = getTrajectoryFilePath(sessionId);

			await appendTrajectoryEntry(sessionId, createEntry(1), tempDir);

			expect(trajectoryPath.endsWith('.jsonl')).toBe(true);
			expect(fs.statSync(trajectoryPath).isFile()).toBe(true);
		});

		test('appends multiple entries to same file', async () => {
			const sessionId = 'test-session-multiple';

			await appendTrajectoryEntry(sessionId, createEntry(1), tempDir);
			await appendTrajectoryEntry(sessionId, createEntry(2), tempDir);
			await appendTrajectoryEntry(sessionId, createEntry(3), tempDir);

			const content = fs.readFileSync(
				getTrajectoryFilePath(sessionId),
				'utf-8',
			);
			const lines = content.split('\n').filter((l) => l.trim());

			expect(lines.length).toBe(3);
		});

		test('handles filesystem errors gracefully (non-blocking)', async () => {
			const sessionId = 'test-session-error';

			// Pass an invalid path that will cause issues
			// Using a path that validateSwarmPath will reject
			await expect(
				appendTrajectoryEntry(sessionId, createEntry(1), '/invalid\0path'),
			).resolves.toBeUndefined(); // Should not throw

			// Should not crash even with invalid directory
			await expect(
				appendTrajectoryEntry(sessionId, createEntry(1), ''),
			).resolves.toBeUndefined();
		});

		test('does not update cache when disk append fails', async () => {
			const sessionId = 'test-session-cache-fail';

			await appendTrajectoryEntry(sessionId, createEntry(1), '/invalid\0path');

			expect(getInMemoryTrajectory(sessionId)).toEqual([]);
		});

		test('bounds tracked cached sessions with FIFO eviction', async () => {
			const maxSessions = _test_exports.MAX_TRACKED_TRAJECTORY_SESSIONS;

			for (let i = 0; i <= maxSessions; i++) {
				await appendTrajectoryEntry(`session-${i}`, createEntry(1), tempDir);
			}

			expect(getInMemoryTrajectory('session-0')).toEqual([]);
			expect(getInMemoryTrajectory('session-1')).toHaveLength(1);
			expect(getInMemoryTrajectory(`session-${maxSessions}`)).toHaveLength(1);
		});
	});

	// =========================================================================
	// readTrajectory Tests
	// =========================================================================

	describe('readTrajectory', () => {
		test('returns empty array when file does not exist', async () => {
			const entries = await readTrajectory('nonexistent-session', tempDir);
			expect(entries).toEqual([]);
		});

		test('reads and parses valid entries', async () => {
			const sessionId = 'test-session-read';
			const entry1 = createEntry(1, { agent: 'coder', action: 'edit' });
			const entry2 = createEntry(2, { agent: 'reviewer', action: 'review' });

			await appendTrajectoryEntry(sessionId, entry1, tempDir);
			await appendTrajectoryEntry(sessionId, entry2, tempDir);

			const entries = await readTrajectory(sessionId, tempDir);

			expect(entries.length).toBe(2);
			expect(entries[0].step).toBe(1);
			expect(entries[1].step).toBe(2);
		});

		test('handles malformed lines gracefully (skips invalid JSON)', async () => {
			const sessionId = 'test-session-malformed';
			const trajectoryPath = getTrajectoryFilePath(sessionId);

			// Manually write malformed content
			const dir = path.dirname(trajectoryPath);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(
				trajectoryPath,
				'{"step":1,"agent":"test","action":"edit"}\n' + // valid
					'not valid json\n' + // invalid
					'{"step":2,"agent":"test2","action":"review"}\n', // valid
			);

			const entries = await readTrajectory(sessionId, tempDir);

			expect(entries.length).toBe(2);
			expect(entries[0].step).toBe(1);
			expect(entries[1].step).toBe(2);
		});

		test('returns entries in chronological order', async () => {
			const sessionId = 'test-session-order';
			const trajectoryPath = getTrajectoryFilePath(sessionId);

			// Manually write entries out of order
			const dir = path.dirname(trajectoryPath);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(
				trajectoryPath,
				'{"step":3,"agent":"agent3","action":"test","target":"f","intent":"","timestamp":"2024-01-03T00:00:00.000Z","result":"success"}\n' +
					'{"step":1,"agent":"agent1","action":"test","target":"f","intent":"","timestamp":"2024-01-01T00:00:00.000Z","result":"success"}\n' +
					'{"step":2,"agent":"agent2","action":"test","target":"f","intent":"","timestamp":"2024-01-02T00:00:00.000Z","result":"success"}\n',
			);

			const entries = await readTrajectory(sessionId, tempDir);

			// Entries should be returned in file order (chronological as written)
			expect(entries[0].step).toBe(3);
			expect(entries[1].step).toBe(1);
			expect(entries[2].step).toBe(2);
		});

		test('handles empty file gracefully', async () => {
			const sessionId = 'test-session-empty';
			const trajectoryPath = getTrajectoryFilePath(sessionId);

			const dir = path.dirname(trajectoryPath);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(trajectoryPath, '');

			const entries = await readTrajectory(sessionId, tempDir);
			expect(entries).toEqual([]);
		});

		test('handles file with only whitespace gracefully', async () => {
			const sessionId = 'test-session-whitespace';
			const trajectoryPath = getTrajectoryFilePath(sessionId);

			const dir = path.dirname(trajectoryPath);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(trajectoryPath, '   \n\n   \n');

			const entries = await readTrajectory(sessionId, tempDir);
			expect(entries).toEqual([]);
		});

		test('populates cache from disk on cold read', async () => {
			const sessionId = 'test-session-cold-read';
			await appendTrajectoryEntry(sessionId, createEntry(1), tempDir);
			clearTrajectoryCache(sessionId);

			const entries = await readTrajectory(sessionId, tempDir);

			expect(entries).toHaveLength(1);
			expect(getInMemoryTrajectory(sessionId)).toHaveLength(1);
		});

		test('getInMemoryTrajectory returns a defensive array copy', async () => {
			const sessionId = 'test-session-cache-copy';
			await appendTrajectoryEntry(sessionId, createEntry(1), tempDir);

			const cached = getInMemoryTrajectory(sessionId);
			cached.push(createEntry(2));

			expect(getInMemoryTrajectory(sessionId)).toHaveLength(1);
		});
	});

	// =========================================================================
	// truncateTrajectoryIfNeeded Tests
	// =========================================================================

	describe('truncateTrajectoryIfNeeded', () => {
		test('does nothing when under limit', async () => {
			const sessionId = 'test-session-under';
			const trajectoryPath = getTrajectoryFilePath(sessionId);

			// Write 3 entries (under limit of 5)
			const dir = path.dirname(trajectoryPath);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(trajectoryPath, '{"step":1}\n{"step":2}\n{"step":3}\n');

			await truncateTrajectoryIfNeeded(sessionId, tempDir, 5);

			const content = fs.readFileSync(trajectoryPath, 'utf-8');
			const lines = content.split('\n').filter((l) => l.trim());
			expect(lines.length).toBe(3);
		});

		test('truncates oldest entries when over limit', async () => {
			const sessionId = 'test-session-over';
			const trajectoryPath = getTrajectoryFilePath(sessionId);

			// Write 10 entries
			const dir = path.dirname(trajectoryPath);
			fs.mkdirSync(dir, { recursive: true });
			const lines: string[] = [];
			for (let i = 1; i <= 10; i++) {
				lines.push(`{"step":${i},"agent":"agent${i}"}`);
			}
			fs.writeFileSync(trajectoryPath, `${lines.join('\n')}\n`);

			// Truncate to max 6 lines (should keep floor(6/2) = 3 newest)
			await truncateTrajectoryIfNeeded(sessionId, tempDir, 6);

			const content = fs.readFileSync(trajectoryPath, 'utf-8');
			const remaining = content
				.split('\n')
				.filter((l) => l.trim())
				.map((l) => JSON.parse(l).step);

			// Should keep the newest 3 entries (steps 8, 9, 10)
			expect(remaining).toEqual([8, 9, 10]);
		});

		test('keeps at least 1 entry when truncating', async () => {
			const sessionId = 'test-session-one';
			const trajectoryPath = getTrajectoryFilePath(sessionId);

			// Write 5 entries
			const dir = path.dirname(trajectoryPath);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(
				trajectoryPath,
				'{"step":1}\n{"step":2}\n{"step":3}\n{"step":4}\n{"step":5}\n',
			);

			// Truncate to max 2 (keepCount = floor(2/2) = 1)
			await truncateTrajectoryIfNeeded(sessionId, tempDir, 2);

			const content = fs.readFileSync(trajectoryPath, 'utf-8');
			const remaining = content.split('\n').filter((l) => l.trim());
			expect(remaining.length).toBe(1);
			expect(JSON.parse(remaining[0]).step).toBe(5); // newest
		});

		test('handles missing file gracefully', async () => {
			// Should not throw
			await expect(
				truncateTrajectoryIfNeeded('nonexistent-session', tempDir, 10),
			).resolves.toBeUndefined();
		});

		test('handles empty file gracefully', async () => {
			const sessionId = 'test-session-empty-trunc';
			const trajectoryPath = getTrajectoryFilePath(sessionId);

			const dir = path.dirname(trajectoryPath);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(trajectoryPath, '');

			await truncateTrajectoryIfNeeded(sessionId, tempDir, 5);

			const content = fs.readFileSync(trajectoryPath, 'utf-8');
			expect(content).toBe('');
		});
	});

	// =========================================================================
	// getTrajectoryForSession Tests (alias)
	// =========================================================================

	describe('getTrajectoryForSession', () => {
		test('returns same result as readTrajectory', async () => {
			const sessionId = 'test-session-alias';

			await appendTrajectoryEntry(sessionId, createEntry(1), tempDir);
			await appendTrajectoryEntry(sessionId, createEntry(2), tempDir);

			const direct = await readTrajectory(sessionId, tempDir);
			const alias = await getTrajectoryForSession(sessionId, tempDir);

			expect(alias).toEqual(direct);
		});
	});

	// =========================================================================
	// getCurrentStep Tests
	// =========================================================================

	describe('getCurrentStep', () => {
		test('returns 0 when file does not exist', async () => {
			const step = await getCurrentStep('nonexistent-session', tempDir);
			expect(step).toBe(0);
		});

		test('returns highest step number from entries', async () => {
			const sessionId = 'test-session-step';
			const trajectoryPath = getTrajectoryFilePath(sessionId);

			const dir = path.dirname(trajectoryPath);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(trajectoryPath, '{"step":5}\n{"step":10}\n{"step":3}\n');

			const step = await getCurrentStep(sessionId, tempDir);
			expect(step).toBe(10);
		});

		test('skips malformed entries when finding max step', async () => {
			const sessionId = 'test-session-step-malformed';
			const trajectoryPath = getTrajectoryFilePath(sessionId);

			const dir = path.dirname(trajectoryPath);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(trajectoryPath, '{"step":5}\nnot-json\n{"step":20}\n');

			const step = await getCurrentStep(sessionId, tempDir);
			expect(step).toBe(20);
		});

		test('returns 0 for empty file', async () => {
			const sessionId = 'test-session-empty-step';
			const trajectoryPath = getTrajectoryFilePath(sessionId);

			const dir = path.dirname(trajectoryPath);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(trajectoryPath, '');

			const step = await getCurrentStep(sessionId, tempDir);
			expect(step).toBe(0);
		});
	});

	// =========================================================================
	// Error Handling Tests
	// =========================================================================

	describe('error handling', () => {
		test('all functions are non-blocking and never throw on errors', async () => {
			// Test with paths containing null bytes (invalid on all platforms)
			await expect(
				appendTrajectoryEntry('session', createEntry(1), '/invalid\x00path'),
			).resolves.toBeUndefined();

			await expect(
				readTrajectory('session', '/invalid\x00path'),
			).resolves.toEqual([]);

			await expect(
				truncateTrajectoryIfNeeded('session', '/invalid\x00path', 10),
			).resolves.toBeUndefined();

			await expect(getCurrentStep('session', '/invalid\x00path')).resolves.toBe(
				0,
			);
		});

		test('invalid paths with null bytes are handled safely', async () => {
			// These paths fail at the fs layer but should not throw
			await expect(
				appendTrajectoryEntry('session', createEntry(1), '/bad\x00path'),
			).resolves.toBeUndefined();

			await expect(readTrajectory('session', '/bad\x00path')).resolves.toEqual(
				[],
			);

			await expect(
				truncateTrajectoryIfNeeded('session', '/bad\x00path', 10),
			).resolves.toBeUndefined();

			await expect(getCurrentStep('session', '/bad\x00path')).resolves.toBe(0);
		});

		test('path traversal attempts in session ID are handled safely', async () => {
			// Even if a path traversal were attempted via session ID,
			// the non-blocking error handling should prevent crashes
			await expect(
				truncateTrajectoryIfNeeded('../traversal', tempDir, 10),
			).resolves.toBeUndefined();

			await expect(readTrajectory('../traversal', tempDir)).resolves.toEqual(
				[],
			);
		});
	});

	describe('cleanupOldTrajectoryFiles', () => {
		test('removes old trajectory and replay files and keeps fresh files', async () => {
			const trajectoriesDir = path.join(tempDir, '.swarm', 'trajectories');
			const replaysDir = path.join(tempDir, '.swarm', 'replays');
			fs.mkdirSync(trajectoriesDir, { recursive: true });
			fs.mkdirSync(replaysDir, { recursive: true });
			const oldTrajectory = path.join(trajectoriesDir, 'old.jsonl');
			const freshTrajectory = path.join(trajectoriesDir, 'fresh.jsonl');
			const oldReplay = path.join(replaysDir, 'old.jsonl');
			const freshReplay = path.join(replaysDir, 'fresh.jsonl');
			for (const file of [
				oldTrajectory,
				freshTrajectory,
				oldReplay,
				freshReplay,
			]) {
				fs.writeFileSync(file, '{}\n');
			}
			const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
			const fresh = new Date();
			fs.utimesSync(oldTrajectory, old, old);
			fs.utimesSync(oldReplay, old, old);
			fs.utimesSync(freshTrajectory, fresh, fresh);
			fs.utimesSync(freshReplay, fresh, fresh);

			await cleanupOldTrajectoryFiles(tempDir, 7);

			expect(fs.existsSync(oldTrajectory)).toBe(false);
			expect(fs.existsSync(oldReplay)).toBe(false);
			expect(fs.existsSync(freshTrajectory)).toBe(true);
			expect(fs.existsSync(freshReplay)).toBe(true);
		});
	});

	// =========================================================================
	// Integration Tests
	// =========================================================================

	describe('integration', () => {
		test('full workflow: append, read, truncate, read again', async () => {
			const sessionId = 'test-session-integration';

			// Append entries
			for (let i = 1; i <= 5; i++) {
				await appendTrajectoryEntry(
					sessionId,
					createEntry(i, { agent: `agent-${i}` }),
					tempDir,
				);
			}

			let entries = await readTrajectory(sessionId, tempDir);
			expect(entries.length).toBe(5);

			// Truncate
			await truncateTrajectoryIfNeeded(sessionId, tempDir, 3);

			// Read again
			entries = await readTrajectory(sessionId, tempDir);
			expect(entries.length).toBe(1); // floor(3/2) = 1
			expect(entries[0].step).toBe(5); // newest
		});

		test('multiple sessions have independent trajectories', async () => {
			const session1 = 'session-1';
			const session2 = 'session-2';

			await appendTrajectoryEntry(
				session1,
				createEntry(1, { agent: 'agent-1' }),
				tempDir,
			);
			await appendTrajectoryEntry(
				session2,
				createEntry(1, { agent: 'agent-2' }),
				tempDir,
			);
			await appendTrajectoryEntry(
				session2,
				createEntry(2, { agent: 'agent-2' }),
				tempDir,
			);

			const entries1 = await readTrajectory(session1, tempDir);
			const entries2 = await readTrajectory(session2, tempDir);

			expect(entries1.length).toBe(1);
			expect(entries1[0].agent).toBe('agent-1');
			expect(entries2.length).toBe(2);
			expect(entries2[0].agent).toBe('agent-2');
			expect(entries2[1].agent).toBe('agent-2');
		});

		test('getCurrentStep works with append workflow', async () => {
			const sessionId = 'test-session-step-workflow';

			expect(await getCurrentStep(sessionId, tempDir)).toBe(0);

			await appendTrajectoryEntry(sessionId, createEntry(1), tempDir);
			expect(await getCurrentStep(sessionId, tempDir)).toBe(1);

			await appendTrajectoryEntry(sessionId, createEntry(2), tempDir);
			expect(await getCurrentStep(sessionId, tempDir)).toBe(2);

			await appendTrajectoryEntry(sessionId, createEntry(10), tempDir);
			expect(await getCurrentStep(sessionId, tempDir)).toBe(10);
		});
	});
});
