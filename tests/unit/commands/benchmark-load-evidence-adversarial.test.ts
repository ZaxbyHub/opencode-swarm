/**
 * Adversarial security testing for loadEvidence discriminated union in benchmark.ts
 *
 * Tests edge cases and adversarial inputs that could compromise system stability.
 * Uses real filesystem operations instead of module mocking to avoid
 * bun test runner module-registry contamination across test files.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleBenchmarkCommand } from '../../../src/commands/benchmark.js';
import { saveEvidence } from '../../../src/evidence/manager.js';
import { resultText } from '../../helpers/benchmark-result-text.js';

let testDir: string;

beforeEach(() => {
	testDir = require('node:fs').realpathSync(
		require('node:fs').mkdtempSync(
			path.join(os.tmpdir(), 'benchmark-adversarial-test-'),
		),
	);
	mkdirSync(path.join(testDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	rmSync(testDir, { recursive: true, force: true });
});

const mockDate = new Date().toISOString();

function mkEvidenceDir(taskId: string): string {
	const dir = path.join(testDir, '.swarm', 'evidence', taskId);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe('handleBenchmarkCommand - Adversarial Security Tests', () => {
	describe('Attack vector: loadEvidence returns invalid_schema (graceful skip)', () => {
		it('should skip task with invalid JSON (mimics loadEvidence internal failure)', async () => {
			// A corrupted evidence file returns 'invalid_schema' — benchmark should skip it
			const dir = mkEvidenceDir('1.1');
			writeFileSync(path.join(dir, 'evidence.json'), '{ invalid json !!!');

			const result = await handleBenchmarkCommand(testDir, ['--cumulative']);

			expect(resultText(result)).toContain('No evidence data found');
		});

		it('should skip multiple tasks with invalid evidence', async () => {
			const dir1 = mkEvidenceDir('1.1');
			writeFileSync(path.join(dir1, 'evidence.json'), 'not json at all');
			const dir2 = mkEvidenceDir('1.2');
			writeFileSync(path.join(dir2, 'evidence.json'), '{"broken": }');

			const result = await handleBenchmarkCommand(testDir, ['--cumulative']);

			expect(resultText(result)).toContain('No evidence data found');
		});

		it('should handle mix of valid and invalid evidence files', async () => {
			// Valid review evidence
			await saveEvidence(testDir, '1.1', {
				type: 'review',
				task_id: '1.1',
				timestamp: mockDate,
				agent: 'reviewer',
				verdict: 'approved',
				summary: 'LGTM',
				risk: 'low',
				issues: [],
			});
			// Invalid evidence
			const dir = mkEvidenceDir('1.2');
			writeFileSync(path.join(dir, 'evidence.json'), '{ bad json }');

			const result = await handleBenchmarkCommand(testDir, ['--cumulative']);

			// Only the valid evidence should be aggregated
			expect(resultText(result)).toContain('Review pass rate: 100%');
			expect(resultText(result)).toContain('(1)');
		});

		it('should handle partially valid JSON that fails schema validation', async () => {
			// Valid JSON but wrong schema — Zod returns 'invalid_schema'
			const dir = mkEvidenceDir('1.1');
			writeFileSync(
				path.join(dir, 'evidence.json'),
				JSON.stringify({
					schema_version: '1.0.0',
					task_id: '1.1',
					// entries is missing — Zod validation fails
					created_at: mockDate,
					updated_at: mockDate,
				}),
			);

			const result = await handleBenchmarkCommand(testDir, ['--cumulative']);

			// Invalid schema bundle is skipped
			expect(resultText(result)).toContain('No evidence data found');
		});
	});

	describe('Attack vector: bundle.entries edge cases', () => {
		it('should handle an empty bundle (no entries)', async () => {
			// saveEvidence creates a valid bundle with no entries initially
			await saveEvidence(testDir, '1.1', {
				type: 'note',
				task_id: '1.1',
				timestamp: mockDate,
				agent: 'test',
				verdict: 'info',
				summary: 'Empty note bundle',
			});

			const result = await handleBenchmarkCommand(testDir, ['--cumulative']);

			// No quality data → no Quality Signals section OR "No evidence data found"
			// The note type doesn't contribute to review/test quality metrics
			expect(resultText(result)).not.toContain('Review pass rate');
			expect(resultText(result)).not.toContain('Test pass rate');
		});
	});

	describe('Attack vector: directory argument edge cases', () => {
		it('should handle empty string directory gracefully', async () => {
			// Empty string → listEvidenceTaskIds returns [] (no .swarm dir)
			const result = await handleBenchmarkCommand('', ['--cumulative']);

			expect(resultText(result)).toContain('No evidence data found');
		});

		it('should handle non-existent directory gracefully', async () => {
			const nonExistentDir = path.join(
				os.tmpdir(),
				'definitely-does-not-exist-xyz123',
			);

			const result = await handleBenchmarkCommand(nonExistentDir, [
				'--cumulative',
			]);

			expect(resultText(result)).toContain('No evidence data found');
		});

		it('should handle directory with no .swarm subdirectory', async () => {
			// Create a real directory but without .swarm
			const emptyDir = require('node:fs').realpathSync(
				require('node:fs').mkdtempSync(
					path.join(os.tmpdir(), 'benchmark-empty-'),
				),
			);
			try {
				const result = await handleBenchmarkCommand(emptyDir, ['--cumulative']);
				expect(resultText(result)).toContain('No evidence data found');
			} finally {
				rmSync(emptyDir, { recursive: true, force: true });
			}
		});

		it('should handle null directory (throws at validation boundary)', async () => {
			// TypeScript prevents this at compile time; at runtime the validator throws
			await expect(
				handleBenchmarkCommand(null as any, ['--cumulative']),
			).rejects.toThrow();
		});

		it('should handle undefined directory (throws at validation boundary)', async () => {
			await expect(
				handleBenchmarkCommand(undefined as any, ['--cumulative']),
			).rejects.toThrow();
		});
	});

	describe('Attack vector: large number of evidence files (DoS)', () => {
		it('should handle 20 task directories (moderate load)', async () => {
			// Create 20 real evidence directories (mix of valid and invalid)
			for (let i = 1; i <= 15; i++) {
				mkEvidenceDir(`${i}.1`); // not_found (no evidence.json)
			}
			for (let i = 16; i <= 20; i++) {
				const dir = mkEvidenceDir(`${i}.1`);
				writeFileSync(path.join(dir, 'evidence.json'), '{ invalid }'); // invalid_schema
			}

			const result = await handleBenchmarkCommand(testDir, ['--cumulative']);

			expect(resultText(result)).toContain('No evidence data found');
		});

		it('should handle mixed valid/invalid evidence at scale', async () => {
			// 5 valid review approvals
			for (let i = 1; i <= 5; i++) {
				await saveEvidence(testDir, `1.${i}`, {
					type: 'review',
					task_id: `1.${i}`,
					timestamp: mockDate,
					agent: 'reviewer',
					verdict: 'approved',
					summary: 'LGTM',
					risk: 'low',
					issues: [],
				});
			}
			// 5 invalid JSON files (skipped)
			for (let i = 6; i <= 10; i++) {
				const dir = mkEvidenceDir(`1.${i}`);
				writeFileSync(path.join(dir, 'evidence.json'), '{ bad }');
			}

			const result = await handleBenchmarkCommand(testDir, ['--cumulative']);

			// Only the 5 valid reviews should be counted
			expect(resultText(result)).toContain('Review pass rate: 100%');
			expect(resultText(result)).toContain('(5)');
		});
	});

	describe('Attack vector: CI Gate with adversarial inputs', () => {
		it('should handle CI gate when all evidence is invalid', async () => {
			// All evidence files are invalid JSON
			for (let i = 1; i <= 3; i++) {
				const dir = mkEvidenceDir(`1.${i}`);
				writeFileSync(path.join(dir, 'evidence.json'), '{ invalid }');
			}

			const result = await handleBenchmarkCommand(testDir, ['--ci-gate']);

			// CI gate should run even with invalid evidence
			expect(resultText(result)).toContain('CI Gate');
			// With no valid evidence, review and test pass rates are 0%
			expect(resultText(result)).toContain('❌ FAILED');
		});

		it('should handle CI gate with no evidence at all', async () => {
			const result = await handleBenchmarkCommand(testDir, ['--ci-gate']);

			expect(resultText(result)).toContain('CI Gate');
			// No evidence means review/test rates are 0%, but quality metrics pass by default
			expect(resultText(result)).toContain('Complexity Delta: 0 <= 5 ✅');
		});

		it('should handle CI gate with a mix of valid passing evidence and invalid files', async () => {
			// Add passing review and test evidence
			await saveEvidence(testDir, '1.1', {
				type: 'review',
				task_id: '1.1',
				timestamp: mockDate,
				agent: 'reviewer',
				verdict: 'approved',
				summary: 'LGTM',
				risk: 'low',
				issues: [],
			});
			await saveEvidence(testDir, '1.1', {
				type: 'test',
				task_id: '1.1',
				timestamp: mockDate,
				agent: 'tester',
				verdict: 'pass',
				summary: 'All tests pass',
				tests_passed: 100,
				tests_failed: 0,
				failures: [],
			});
			// Some invalid tasks
			const dir = mkEvidenceDir('2.1');
			writeFileSync(path.join(dir, 'evidence.json'), '{ bad }');

			const result = await handleBenchmarkCommand(testDir, ['--ci-gate']);

			expect(resultText(result)).toContain('CI Gate');
			// Review and test from valid task should count
			expect(resultText(result)).toContain('Review pass rate: 100%');
			expect(resultText(result)).toContain('Test pass rate: 100%');
		});
	});
});
