/**
 * Tests for benchmark.ts graceful handling of corrupt evidence files.
 *
 * Verifies that the try/catch in handleBenchmarkCommand's cumulative loop
 * catches exceptions from loadEvidence and skips corrupt/unreadable files.
 */

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	vi,
} from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EvidenceBundle } from '../config/evidence-schema';
import { handleBenchmarkCommand } from './benchmark';

let tempDir: string;

beforeEach(() => {
	tempDir = require('node:fs').realpathSync(
		require('node:fs').mkdtempSync(
			path.join(os.tmpdir(), 'benchmark-error-handling-test-'),
		),
	);
	mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	mkdirSync(path.join(tempDir, '.swarm', 'evidence'), { recursive: true });
	mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
	mock.restore();
});

function createValidBundle(taskId: string): EvidenceBundle {
	const now = new Date().toISOString();
	return {
		schema_version: '1.0.0',
		task_id: taskId,
		entries: [],
		created_at: now,
		updated_at: now,
	};
}

describe('handleBenchmarkCommand corrupt evidence handling', () => {
	it('should skip corrupt (invalid JSON) evidence file without throwing', async () => {
		// Create a corrupt evidence directory (invalid JSON)
		const corruptDir = path.join(tempDir, '.swarm', 'evidence', 'corrupt-task');
		mkdirSync(corruptDir, { recursive: true });
		writeFileSync(
			path.join(corruptDir, 'evidence.json'),
			'{ this is not valid json !!!',
		);

		// Create a valid evidence directory
		const validDir = path.join(tempDir, '.swarm', 'evidence', 'valid-task');
		mkdirSync(validDir, { recursive: true });
		writeFileSync(
			path.join(validDir, 'evidence.json'),
			JSON.stringify(createValidBundle('valid-task')),
		);

		// Should complete without throwing in cumulative mode
		const result = await handleBenchmarkCommand(tempDir, ['--ci-gate']);

		expect(result).toBeDefined();
		expect(typeof result).toBe('string');

		// Should contain benchmark output markers
		expect(result).toContain('## Swarm Benchmark');
		expect(result).toContain('[BENCHMARK_JSON]');

		// corrupt-task should NOT appear in the output (skipped)
		expect(result).not.toContain('corrupt-task');
	});

	it('should handle multiple corrupt files mixed with valid files', async () => {
		// Create corrupt directory 1
		const corrupt1Dir = path.join(tempDir, '.swarm', 'evidence', 'bad-file-1');
		mkdirSync(corrupt1Dir, { recursive: true });
		writeFileSync(path.join(corrupt1Dir, 'evidence.json'), '{ broken');

		// Create valid evidence directory
		const validDir = path.join(tempDir, '.swarm', 'evidence', 'good-file');
		mkdirSync(validDir, { recursive: true });
		writeFileSync(
			path.join(validDir, 'evidence.json'),
			JSON.stringify(createValidBundle('good-file')),
		);

		// Create corrupt directory 2
		const corrupt2Dir = path.join(tempDir, '.swarm', 'evidence', 'bad-file-2');
		mkdirSync(corrupt2Dir, { recursive: true });
		writeFileSync(
			path.join(corrupt2Dir, 'evidence.json'),
			'not json at all!!!',
		);

		// Should complete successfully in cumulative mode
		const result = await handleBenchmarkCommand(tempDir, ['--ci-gate']);

		expect(result).toBeDefined();
		expect(typeof result).toBe('string');
		expect(result).toContain('## Swarm Benchmark');

		// Corrupt files should not appear
		expect(result).not.toContain('bad-file-1');
		expect(result).not.toContain('bad-file-2');
	});

	it('should handle all files being corrupt gracefully', async () => {
		// Create multiple corrupt directories
		for (let i = 1; i <= 3; i++) {
			const corruptDir = path.join(
				tempDir,
				'.swarm',
				'evidence',
				`corrupt-${i}`,
			);
			mkdirSync(corruptDir, { recursive: true });
			writeFileSync(path.join(corruptDir, 'evidence.json'), `{ invalid ${i}`);
		}

		// Should complete without throwing even with all corrupt files
		const result = await handleBenchmarkCommand(tempDir, ['--ci-gate']);

		expect(result).toBeDefined();
		expect(typeof result).toBe('string');
		expect(result).toContain('## Swarm Benchmark');
		expect(result).toContain('[BENCHMARK_JSON]');
	});

	it('should handle directory with missing evidence.json file', async () => {
		// Create an evidence directory WITHOUT an evidence.json file
		const emptyDir = path.join(tempDir, '.swarm', 'evidence', 'empty-task');
		mkdirSync(emptyDir, { recursive: true });
		// Note: no evidence.json created in this directory

		// Create valid evidence directory
		const validDir = path.join(tempDir, '.swarm', 'evidence', 'valid-task');
		mkdirSync(validDir, { recursive: true });
		writeFileSync(
			path.join(validDir, 'evidence.json'),
			JSON.stringify(createValidBundle('valid-task')),
		);

		const result = await handleBenchmarkCommand(tempDir, ['--ci-gate']);

		expect(result).toBeDefined();
		expect(result).toContain('## Swarm Benchmark');
	});

	it('should handle directory with empty evidence.json file', async () => {
		// Create directory with empty file
		const emptyDir = path.join(tempDir, '.swarm', 'evidence', 'empty-file');
		mkdirSync(emptyDir, { recursive: true });
		writeFileSync(path.join(emptyDir, 'evidence.json'), '');

		// Create valid evidence directory
		const validDir = path.join(tempDir, '.swarm', 'evidence', 'valid-task');
		mkdirSync(validDir, { recursive: true });
		writeFileSync(
			path.join(validDir, 'evidence.json'),
			JSON.stringify(createValidBundle('valid-task')),
		);

		const result = await handleBenchmarkCommand(tempDir, ['--ci-gate']);

		// Should complete without throwing and skip empty file
		expect(result).toBeDefined();
		expect(result).toContain('## Swarm Benchmark');
		expect(result).toContain('[BENCHMARK_JSON]');
	});

	it('should handle deeply nested corrupt data that parses but fails schema', async () => {
		// Create a file that is valid JSON but wrong schema (missing required fields)
		const corruptDir = path.join(tempDir, '.swarm', 'evidence', 'wrong-schema');
		mkdirSync(corruptDir, { recursive: true });
		writeFileSync(
			path.join(corruptDir, 'evidence.json'),
			JSON.stringify({ wrong: 'schema', fields: 'here' }),
		);

		// Create valid evidence directory
		const validDir = path.join(tempDir, '.swarm', 'evidence', 'valid-task');
		mkdirSync(validDir, { recursive: true });
		writeFileSync(
			path.join(validDir, 'evidence.json'),
			JSON.stringify(createValidBundle('valid-task')),
		);

		const result = await handleBenchmarkCommand(tempDir, ['--ci-gate']);

		// Should complete without throwing
		expect(result).toBeDefined();
		expect(result).toContain('## Swarm Benchmark');
		expect(result).toContain('[BENCHMARK_JSON]');
	});

	it('should handle --cumulative flag with corrupt evidence', async () => {
		// Create corrupt evidence directory
		const corruptDir = path.join(tempDir, '.swarm', 'evidence', 'corrupt-task');
		mkdirSync(corruptDir, { recursive: true });
		writeFileSync(
			path.join(corruptDir, 'evidence.json'),
			'completely broken json {',
		);

		// Should complete without throwing using --cumulative flag
		const result = await handleBenchmarkCommand(tempDir, ['--cumulative']);

		expect(result).toBeDefined();
		expect(typeof result).toBe('string');
		expect(result).toContain('## Swarm Benchmark');
		expect(result).toContain('mode: cumulative');
		expect(result).toContain('[BENCHMARK_JSON]');
	});

	it('should handle empty evidence directory', async () => {
		// No evidence directories created - .swarm/evidence is empty

		const result = await handleBenchmarkCommand(tempDir, ['--ci-gate']);

		expect(result).toBeDefined();
		expect(typeof result).toBe('string');
		expect(result).toContain('## Swarm Benchmark');
		expect(result).toContain('[BENCHMARK_JSON]');

		// Should show no evidence data
		expect(result).toContain('No evidence data found');
	});

	it('should handle non-cumulative mode without crashing on corrupt files', async () => {
		// Create a corrupt evidence directory
		const corruptDir = path.join(tempDir, '.swarm', 'evidence', 'corrupt-task');
		mkdirSync(corruptDir, { recursive: true });
		writeFileSync(path.join(corruptDir, 'evidence.json'), '{ invalid json');

		// In non-cumulative mode, the cumulative loop is not entered,
		// so corrupt files should not affect the output
		const result = await handleBenchmarkCommand(tempDir, []);

		expect(result).toBeDefined();
		expect(typeof result).toBe('string');
		expect(result).toContain('## Swarm Benchmark');
		expect(result).toContain('mode: in-memory');
		expect(result).toContain('[BENCHMARK_JSON]');
	});
});

describe('handleBenchmarkCommand warn() logging when loadEvidence throws', () => {
	const originalEnv = process.env;
	let warnCalls: Array<{ message: string; data: unknown }> = [];

	beforeEach(() => {
		process.env = { ...originalEnv, OPENCODE_SWARM_DEBUG: '1' };
		warnCalls = [];
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it('should call warn() with correct task ID (tid) when loadEvidence throws', async () => {
		const tid = 'benchmark-warn-task';

		// Create a valid bundle so listEvidenceTaskIds returns our task
		const validDir = path.join(tempDir, '.swarm', 'evidence', tid);
		mkdirSync(validDir, { recursive: true });
		writeFileSync(
			path.join(validDir, 'evidence.json'),
			JSON.stringify(createValidBundle(tid)),
		);

		const originalWarn = console.warn;
		console.warn = (message: string, data?: unknown) => {
			warnCalls.push({ message, data });
		};

		// Mock the evidence manager module to make loadEvidence throw
		await mock.module('../evidence/manager', () => {
			return {
				loadEvidence: async () => {
					throw new Error('Simulated read failure');
				},
				listEvidenceTaskIds: async () => [tid],
				isValidEvidenceType: () => true,
			};
		});

		const { handleBenchmarkCommand: mockedHandleBenchmarkCommand } =
			await import('./benchmark');

		await mockedHandleBenchmarkCommand(tempDir, ['--cumulative']);

		console.warn = originalWarn;

		// Verify warn was called with the correct message and tid
		expect(warnCalls.length).toBeGreaterThan(0);
		const foundCall = warnCalls.find(
			(call) =>
				call.message.includes(
					'benchmark: skipping corrupt or unreadable evidence for task',
				) && call.data === tid,
		);
		expect(foundCall).toBeDefined();
		expect(foundCall!.data).toBe(tid);
	});

	it('should call warn() for multiple tasks when loadEvidence throws on each', async () => {
		const tid1 = 'bench-corrupt-1';
		const tid2 = 'bench-corrupt-2';

		// Create valid bundles so listEvidenceTaskIds returns both tasks
		const validDir1 = path.join(tempDir, '.swarm', 'evidence', tid1);
		mkdirSync(validDir1, { recursive: true });
		writeFileSync(
			path.join(validDir1, 'evidence.json'),
			JSON.stringify(createValidBundle(tid1)),
		);

		const validDir2 = path.join(tempDir, '.swarm', 'evidence', tid2);
		mkdirSync(validDir2, { recursive: true });
		writeFileSync(
			path.join(validDir2, 'evidence.json'),
			JSON.stringify(createValidBundle(tid2)),
		);

		const originalWarn = console.warn;
		console.warn = (message: string, data?: unknown) => {
			warnCalls.push({ message, data });
		};

		// Mock the evidence manager module to make loadEvidence throw for all tasks
		await mock.module('../evidence/manager', () => {
			return {
				loadEvidence: async () => {
					throw new Error('Simulated read failure');
				},
				listEvidenceTaskIds: async () => [tid1, tid2],
				isValidEvidenceType: () => true,
			};
		});

		const { handleBenchmarkCommand: mockedHandleBenchmarkCommand } =
			await import('./benchmark');

		await mockedHandleBenchmarkCommand(tempDir, ['--cumulative']);

		console.warn = originalWarn;

		// Verify warn was called for both tasks
		const skipCalls = warnCalls.filter((call) =>
			call.message.includes(
				'benchmark: skipping corrupt or unreadable evidence for task',
			),
		);
		expect(skipCalls.length).toBe(2);
		expect(skipCalls.some((call) => call.data === tid1)).toBe(true);
		expect(skipCalls.some((call) => call.data === tid2)).toBe(true);
	});
});
