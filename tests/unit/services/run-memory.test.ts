/**
 * Verification tests for run-memory.ts service
 * Tests: append-only, getRunMemorySummary, token limits, fingerprint, filtering
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// Mock validateDirectory to a no-op so Windows absolute temp paths work in tests.
mock.module('../../../src/utils/path-security', () => ({
	containsPathTraversal: () => false,
	containsControlChars: () => false,
	validateDirectory: () => {},
}));

afterEach(() => mock.restore());

import {
	generateTaskFingerprint,
	getFailures,
	getRunMemorySummary,
	getTaskHistory,
	type RunMemoryEntry,
	recordOutcome,
} from '../../../src/services/run-memory';

describe('run-memory service verification tests', () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-memory-test-'));
		await fs.mkdir(path.join(tmpDir, '.swarm'), { recursive: true });
	});

	afterEach(async () => {
		try {
			await fs.rm(tmpDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	// ========== TEST 1: recordOutcome uses append-only ==========
	describe('Test 1: recordOutcome uses append-only behavior', () => {
		it('appends multiple entries without overwriting existing content', async () => {
			const entry1: RunMemoryEntry = {
				timestamp: '2024-01-01T10:00:00.000Z',
				taskId: '1.1',
				taskFingerprint: 'abc12345',
				agent: 'mega_coder',
				outcome: 'pass',
				attemptNumber: 1,
			};

			const entry2: RunMemoryEntry = {
				timestamp: '2024-01-01T10:05:00.000Z',
				taskId: '1.2',
				taskFingerprint: 'def67890',
				agent: 'mega_coder',
				outcome: 'fail',
				attemptNumber: 1,
				failureReason: 'Test failed',
			};

			// Record first entry
			await recordOutcome(tmpDir, entry1);

			// Record second entry
			await recordOutcome(tmpDir, entry2);

			// Read the file directly to verify both entries exist
			const filePath = path.join(tmpDir, '.swarm', 'run-memory.jsonl');
			const content = await fs.readFile(filePath, 'utf-8');
			const lines = content.split('\n').filter((l) => l.trim());

			expect(lines).toHaveLength(2);

			// Verify both entries are present
			const parsed1 = JSON.parse(lines[0]);
			const parsed2 = JSON.parse(lines[1]);

			expect(parsed1.taskId).toBe('1.1');
			expect(parsed2.taskId).toBe('1.2');

			// Verify entry1 is still present (not overwritten)
			expect(content).toContain('"taskId":"1.1"');
			expect(content).toContain('"taskId":"1.2"');
		});

		it('does not read existing content before writing (append-only)', async () => {
			// Write initial content manually to simulate pre-existing data
			const filePath = path.join(tmpDir, '.swarm', 'run-memory.jsonl');
			await fs.writeFile(
				filePath,
				'{"timestamp":"2024-01-01T09:00:00.000Z","taskId":"0.1","taskFingerprint":"xyz00000","agent":"test","outcome":"skip","attemptNumber":1}\n',
			);

			// Now append new entries
			await recordOutcome(tmpDir, {
				timestamp: '2024-01-01T10:00:00.000Z',
				taskId: '1.1',
				taskFingerprint: 'abc12345',
				agent: 'mega_coder',
				outcome: 'pass',
				attemptNumber: 1,
			});

			// Verify original content is preserved
			const content = await fs.readFile(filePath, 'utf-8');
			const lines = content.split('\n').filter((l) => l.trim());

			expect(lines).toHaveLength(2);

			// First line should be original
			const parsed0 = JSON.parse(lines[0]);
			expect(parsed0.taskId).toBe('0.1');
			expect(parsed0.outcome).toBe('skip');
		});
	});

	// ========== TEST 2: getRunMemorySummary returns null when no failures ==========
	describe('Test 2: getRunMemorySummary returns null when no failures', () => {
		it('returns null when file does not exist', async () => {
			const result = await getRunMemorySummary(tmpDir);
			expect(result).toBeNull();
		});

		it('returns null when all entries are passes', async () => {
			// Record only pass entries
			await recordOutcome(tmpDir, {
				timestamp: '2024-01-01T10:00:00.000Z',
				taskId: '1.1',
				taskFingerprint: 'abc12345',
				agent: 'mega_coder',
				outcome: 'pass',
				attemptNumber: 1,
			});

			await recordOutcome(tmpDir, {
				timestamp: '2024-01-01T10:05:00.000Z',
				taskId: '1.2',
				taskFingerprint: 'def67890',
				agent: 'mega_coder',
				outcome: 'pass',
				attemptNumber: 1,
			});

			const result = await getRunMemorySummary(tmpDir);
			expect(result).toBeNull();
		});

		it('returns null when only skip entries exist', async () => {
			await recordOutcome(tmpDir, {
				timestamp: '2024-01-01T10:00:00.000Z',
				taskId: '1.1',
				taskFingerprint: 'abc12345',
				agent: 'mega_coder',
				outcome: 'skip',
				attemptNumber: 1,
			});

			const result = await getRunMemorySummary(tmpDir);
			expect(result).toBeNull();
		});

		it('returns summary when fail entries exist', async () => {
			await recordOutcome(tmpDir, {
				timestamp: '2024-01-01T10:00:00.000Z',
				taskId: '1.1',
				taskFingerprint: 'abc12345',
				agent: 'mega_coder',
				outcome: 'fail',
				attemptNumber: 1,
				failureReason: 'Test error',
			});

			const result = await getRunMemorySummary(tmpDir);
			expect(result).not.toBeNull();
			expect(result).toContain('Task 1.1');
		});
	});

	// ========== TEST 3: getRunMemorySummary stays under 500 tokens ==========
	describe('Test 3: getRunMemorySummary stays under 500 tokens', () => {
		it('stays under 500 tokens with normal content', async () => {
			// Add multiple failure entries
			for (let i = 1; i <= 10; i++) {
				await recordOutcome(tmpDir, {
					timestamp: new Date(2024, 0, i, 10, 0, 0).toISOString(),
					taskId: `${i}.1`,
					taskFingerprint: `fp${i}0000`,
					agent: 'mega_coder',
					outcome: 'fail',
					attemptNumber: 1,
					failureReason: `Error in task ${i}.1 with some additional context`,
				});
			}

			const result = await getRunMemorySummary(tmpDir);
			expect(result).not.toBeNull();

			// Estimate tokens (chars * 0.33)
			const estimatedTokens = Math.ceil((result?.length ?? 0) * 0.33);
			expect(estimatedTokens).toBeLessThanOrEqual(500);
		});

		it('stays under 500 tokens with many entries (truncation)', async () => {
			// Add many failure entries to trigger truncation
			for (let i = 1; i <= 50; i++) {
				await recordOutcome(tmpDir, {
					timestamp: new Date(2024, 0, i, 10, 0, 0).toISOString(),
					taskId: `${i}.1`,
					taskFingerprint: `fp${i}0000`,
					agent: 'mega_coder',
					outcome: 'fail',
					attemptNumber: 1,
					failureReason: `Long error message for task ${i}.1 - this is a detailed failure reason that adds content`,
				});
			}

			const result = await getRunMemorySummary(tmpDir);
			expect(result).not.toBeNull();

			// Estimate tokens (chars * 0.33)
			const estimatedTokens = Math.ceil((result?.length ?? 0) * 0.33);
			expect(estimatedTokens).toBeLessThanOrEqual(500);

			// Verify prefix and suffix are present
			expect(result).toContain('[FOR: architect, coder]');
			expect(result).toContain('Use this data');
		});

		it('includes prefix and suffix in token count', async () => {
			// Add a single failure
			await recordOutcome(tmpDir, {
				timestamp: '2024-01-01T10:00:00.000Z',
				taskId: '1.1',
				taskFingerprint: 'abc12345',
				agent: 'mega_coder',
				outcome: 'fail',
				attemptNumber: 1,
				failureReason: 'Error',
			});

			const result = await getRunMemorySummary(tmpDir);
			expect(result).not.toBeNull();

			// The prefix should be at the start
			expect(result?.startsWith('[FOR: architect, coder]')).toBe(true);
			// The suffix should be at the end
			expect(result?.endsWith('known failure patterns.')).toBe(true);

			// Overall token count should be under 500
			const estimatedTokens = Math.ceil((result?.length ?? 0) * 0.33);
			expect(estimatedTokens).toBeLessThanOrEqual(500);
		});
	});

	// ========== TEST 4: taskFingerprint is deterministic ==========
	describe('Test 4: taskFingerprint is deterministic', () => {
		it('produces same fingerprint for same inputs', () => {
			const taskId = '3.2';
			const files = ['src/a.ts', 'src/b.ts'];

			const fp1 = generateTaskFingerprint(taskId, files);
			const fp2 = generateTaskFingerprint(taskId, files);

			expect(fp1).toBe(fp2);
			expect(fp1).toHaveLength(8);
		});

		it('produces same fingerprint regardless of file order', () => {
			const taskId = '3.2';

			const fp1 = generateTaskFingerprint(taskId, ['src/a.ts', 'src/b.ts']);
			const fp2 = generateTaskFingerprint(taskId, ['src/b.ts', 'src/a.ts']);

			expect(fp1).toBe(fp2);
		});

		it('produces different fingerprints for different taskIds', () => {
			const files = ['src/a.ts'];

			const fp1 = generateTaskFingerprint('1.1', files);
			const fp2 = generateTaskFingerprint('1.2', files);

			expect(fp1).not.toBe(fp2);
		});

		it('produces different fingerprints for different files', () => {
			const taskId = '1.1';

			const fp1 = generateTaskFingerprint(taskId, ['src/a.ts']);
			const fp2 = generateTaskFingerprint(taskId, ['src/b.ts']);

			expect(fp1).not.toBe(fp2);
		});

		it('produces 8-character hex fingerprint', () => {
			const fp = generateTaskFingerprint('1.1', ['src/test.ts']);

			// Should be 8 hex characters
			expect(fp).toMatch(/^[0-9a-f]{8}$/);
		});
	});

	// ========== TEST 5: getTaskHistory filters by taskId correctly ==========
	describe('Test 5: getTaskHistory filters by taskId correctly', () => {
		it('returns entries matching the specified taskId', async () => {
			// Add entries for different tasks
			await recordOutcome(tmpDir, {
				timestamp: '2024-01-01T10:00:00.000Z',
				taskId: '1.1',
				taskFingerprint: 'abc12345',
				agent: 'mega_coder',
				outcome: 'pass',
				attemptNumber: 1,
			});

			await recordOutcome(tmpDir, {
				timestamp: '2024-01-01T10:05:00.000Z',
				taskId: '1.2',
				taskFingerprint: 'def67890',
				agent: 'mega_coder',
				outcome: 'fail',
				attemptNumber: 1,
				failureReason: 'Error',
			});

			await recordOutcome(tmpDir, {
				timestamp: '2024-01-01T10:10:00.000Z',
				taskId: '1.1',
				taskFingerprint: 'abc12345',
				agent: 'mega_coder',
				outcome: 'pass',
				attemptNumber: 2,
			});

			const history1 = await getTaskHistory(tmpDir, '1.1');
			const history2 = await getTaskHistory(tmpDir, '1.2');

			expect(history1).toHaveLength(2);
			expect(history1.every((e) => e.taskId === '1.1')).toBe(true);

			expect(history2).toHaveLength(1);
			expect(history2[0].taskId).toBe('1.2');
		});

		it('returns empty array when no matching taskId', async () => {
			await recordOutcome(tmpDir, {
				timestamp: '2024-01-01T10:00:00.000Z',
				taskId: '1.1',
				taskFingerprint: 'abc12345',
				agent: 'mega_coder',
				outcome: 'pass',
				attemptNumber: 1,
			});

			const history = await getTaskHistory(tmpDir, '99.99');
			expect(history).toHaveLength(0);
		});

		it('returns empty array when file does not exist', async () => {
			const history = await getTaskHistory(tmpDir, '1.1');
			expect(history).toHaveLength(0);
		});
	});

	// ========== TEST 6: getFailures returns only fail/retry entries ==========
	describe('Test 6: getFailures returns only fail/retry entries', () => {
		it('returns only fail entries', async () => {
			await recordOutcome(tmpDir, {
				timestamp: '2024-01-01T10:00:00.000Z',
				taskId: '1.1',
				taskFingerprint: 'abc12345',
				agent: 'mega_coder',
				outcome: 'pass',
				attemptNumber: 1,
			});

			await recordOutcome(tmpDir, {
				timestamp: '2024-01-01T10:05:00.000Z',
				taskId: '1.2',
				taskFingerprint: 'def67890',
				agent: 'mega_coder',
				outcome: 'fail',
				attemptNumber: 1,
				failureReason: 'Test failed',
			});

			await recordOutcome(tmpDir, {
				timestamp: '2024-01-01T10:10:00.000Z',
				taskId: '1.3',
				taskFingerprint: 'ghi11111',
				agent: 'mega_coder',
				outcome: 'skip',
				attemptNumber: 1,
			});

			const failures = await getFailures(tmpDir);

			expect(failures).toHaveLength(1);
			expect(failures[0].outcome).toBe('fail');
			expect(failures[0].taskId).toBe('1.2');
		});

		it('returns only retry entries', async () => {
			await recordOutcome(tmpDir, {
				timestamp: '2024-01-01T10:00:00.000Z',
				taskId: '1.1',
				taskFingerprint: 'abc12345',
				agent: 'mega_coder',
				outcome: 'retry',
				attemptNumber: 2,
				failureReason: 'Transient error',
			});

			const failures = await getFailures(tmpDir);

			expect(failures).toHaveLength(1);
			expect(failures[0].outcome).toBe('retry');
		});

		it('returns both fail and retry entries', async () => {
			await recordOutcome(tmpDir, {
				timestamp: '2024-01-01T10:00:00.000Z',
				taskId: '1.1',
				taskFingerprint: 'abc12345',
				agent: 'mega_coder',
				outcome: 'fail',
				attemptNumber: 1,
				failureReason: 'Failed',
			});

			await recordOutcome(tmpDir, {
				timestamp: '2024-01-01T10:05:00.000Z',
				taskId: '1.2',
				taskFingerprint: 'def67890',
				agent: 'mega_coder',
				outcome: 'retry',
				attemptNumber: 2,
				failureReason: 'Retrying',
			});

			const failures = await getFailures(tmpDir);

			expect(failures).toHaveLength(2);
			expect(failures.map((f) => f.outcome)).toContain('fail');
			expect(failures.map((f) => f.outcome)).toContain('retry');
		});

		it('excludes pass entries', async () => {
			await recordOutcome(tmpDir, {
				timestamp: '2024-01-01T10:00:00.000Z',
				taskId: '1.1',
				taskFingerprint: 'abc12345',
				agent: 'mega_coder',
				outcome: 'pass',
				attemptNumber: 1,
			});

			await recordOutcome(tmpDir, {
				timestamp: '2024-01-01T10:05:00.000Z',
				taskId: '1.2',
				taskFingerprint: 'def67890',
				agent: 'mega_coder',
				outcome: 'pass',
				attemptNumber: 1,
			});

			const failures = await getFailures(tmpDir);
			expect(failures).toHaveLength(0);
		});

		it('excludes skip entries', async () => {
			await recordOutcome(tmpDir, {
				timestamp: '2024-01-01T10:00:00.000Z',
				taskId: '1.1',
				taskFingerprint: 'abc12345',
				agent: 'mega_coder',
				outcome: 'skip',
				attemptNumber: 1,
			});

			const failures = await getFailures(tmpDir);
			expect(failures).toHaveLength(0);
		});

		it('returns empty array when file does not exist', async () => {
			const failures = await getFailures(tmpDir);
			expect(failures).toHaveLength(0);
		});
	});
});
