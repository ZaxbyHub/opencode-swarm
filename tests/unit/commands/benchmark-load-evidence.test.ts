/**
 * Verification tests for loadEvidence discriminated union migration in benchmark.ts
 *
 * Verifies that handleBenchmarkCommand correctly handles the LoadEvidenceResult
 * discriminated union when aggregating quality metrics:
 * 1. 'found' status with valid bundle → entries are processed
 * 2. 'not_found' status → continues (entries are not processed)
 * 3. 'invalid_schema' status → continues (entries are not processed)
 * 4. Mixed scenarios with multiple tasks
 *
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
			path.join(os.tmpdir(), 'benchmark-evidence-test-'),
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

describe('handleBenchmarkCommand loadEvidence discriminated union', () => {
	describe('Happy path: status "found" with valid bundle', () => {
		it('should aggregate review evidence when loadEvidence returns status: "found"', async () => {
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

			const result = await handleBenchmarkCommand(testDir, ['--cumulative']);

			expect(resultText(result)).toContain('Quality Signals');
			expect(resultText(result)).toContain('Review pass rate: 100%');
		});

		it('should aggregate test evidence when loadEvidence returns status: "found"', async () => {
			await saveEvidence(testDir, '1.1', {
				type: 'test',
				task_id: '1.1',
				timestamp: mockDate,
				agent: 'test_engineer',
				verdict: 'pass',
				summary: 'Tests passed',
				tests_passed: 80,
				tests_failed: 20,
				failures: [],
			});

			const result = await handleBenchmarkCommand(testDir, ['--cumulative']);

			expect(resultText(result)).toContain('Quality Signals');
			expect(resultText(result)).toContain('Test pass rate: 80%');
		});

		it('should aggregate quality_budget evidence when loadEvidence returns status: "found"', async () => {
			await saveEvidence(testDir, '1.1', {
				type: 'quality_budget',
				task_id: '1.1',
				timestamp: mockDate,
				agent: 'quality_budget',
				verdict: 'pass',
				summary: 'Quality budget passed',
				metrics: {
					complexity_delta: 3,
					public_api_delta: 5,
					duplication_ratio: 0.02,
					test_to_code_ratio: 0.4,
				},
				thresholds: {
					max_complexity_delta: 5,
					max_public_api_delta: 10,
					max_duplication_ratio: 0.05,
					min_test_to_code_ratio: 0.3,
				},
				violations: [],
				files_analyzed: ['src/test.ts'],
			});

			const result = await handleBenchmarkCommand(testDir, ['--cumulative']);

			expect(resultText(result)).toContain('Quality Metrics');
			expect(resultText(result)).toContain('Complexity Delta: 3');
			expect(resultText(result)).toContain('Public API Delta: 5');
			expect(resultText(result)).toContain('Duplication Ratio: 2%');
			expect(resultText(result)).toContain('Test-to-Code Ratio: 40%');
		});

		it('should aggregate diff evidence when loadEvidence returns status: "found"', async () => {
			await saveEvidence(testDir, '1.1', {
				type: 'diff',
				task_id: '1.1',
				timestamp: mockDate,
				agent: 'coder',
				verdict: 'info',
				summary: 'Code diff',
				additions: 100,
				deletions: 50,
			});

			const result = await handleBenchmarkCommand(testDir, ['--cumulative']);

			expect(resultText(result)).toContain('Quality Signals');
			expect(resultText(result)).toContain('Code churn: +100 / -50 lines');
		});
	});

	describe('Edge case: status "not_found"', () => {
		it('should skip task when loadEvidence returns status: "not_found"', async () => {
			// Create task directory WITHOUT evidence.json → listEvidenceTaskIds finds it,
			// loadEvidence returns 'not_found'
			mkEvidenceDir('2.1');

			const result = await handleBenchmarkCommand(testDir, ['--cumulative']);

			expect(resultText(result)).toContain('No evidence data found');
		});

		it('should aggregate only found evidence when some tasks return not_found', async () => {
			// Task 1.1: valid review evidence (found)
			await saveEvidence(testDir, '1.1', {
				type: 'review',
				task_id: '1.1',
				timestamp: mockDate,
				agent: 'reviewer',
				verdict: 'approved',
				summary: 'Good',
				risk: 'low',
				issues: [],
			});
			// Task 2.1: directory without evidence.json (not_found)
			mkEvidenceDir('2.1');

			const result = await handleBenchmarkCommand(testDir, ['--cumulative']);

			// Only task 1.1's evidence should be counted
			expect(resultText(result)).toContain('Review pass rate: 100%');
			expect(resultText(result)).toContain('(1)');
		});

		it('should show "No evidence data found" when all tasks return not_found', async () => {
			// Two task directories without evidence.json
			mkEvidenceDir('2.1');
			mkEvidenceDir('2.2');

			const result = await handleBenchmarkCommand(testDir, ['--cumulative']);

			expect(resultText(result)).toContain('No evidence data found');
		});
	});

	describe('Edge case: status "invalid_schema"', () => {
		it('should skip task when loadEvidence returns status: "invalid_schema"', async () => {
			// Create directory with invalid JSON → loadEvidence returns 'invalid_schema'
			const dir = mkEvidenceDir('3.1');
			writeFileSync(
				path.join(dir, 'evidence.json'),
				'{ invalid json content !!!',
			);

			const result = await handleBenchmarkCommand(testDir, ['--cumulative']);

			expect(resultText(result)).toContain('No evidence data found');
		});

		it('should aggregate only found evidence when some tasks return invalid_schema', async () => {
			// Task 1.1: valid review evidence (found)
			await saveEvidence(testDir, '1.1', {
				type: 'review',
				task_id: '1.1',
				timestamp: mockDate,
				agent: 'reviewer',
				verdict: 'approved',
				summary: 'Good',
				risk: 'low',
				issues: [],
			});
			// Task 3.1: invalid JSON (invalid_schema)
			const dir = mkEvidenceDir('3.1');
			writeFileSync(path.join(dir, 'evidence.json'), '{ bad json }');

			const result = await handleBenchmarkCommand(testDir, ['--cumulative']);

			expect(resultText(result)).toContain('Review pass rate: 100%');
			expect(resultText(result)).toContain('(1)');
		});
	});

	describe('Mixed scenarios with multiple tasks', () => {
		it('should handle mixed found/not_found/invalid_schema results correctly', async () => {
			// Task 1.1: valid review (found)
			await saveEvidence(testDir, '1.1', {
				type: 'review',
				task_id: '1.1',
				timestamp: mockDate,
				agent: 'reviewer',
				verdict: 'approved',
				summary: 'Good',
				risk: 'low',
				issues: [],
			});
			// Task 1.4: another valid review (found)
			await saveEvidence(testDir, '1.4', {
				type: 'review',
				task_id: '1.4',
				timestamp: mockDate,
				agent: 'reviewer',
				verdict: 'approved',
				summary: 'Good',
				risk: 'low',
				issues: [],
			});
			// Task 2.1: not_found
			mkEvidenceDir('2.1');
			// Task 3.1: invalid_schema
			const dir = mkEvidenceDir('3.1');
			writeFileSync(path.join(dir, 'evidence.json'), '{ bad json }');

			const result = await handleBenchmarkCommand(testDir, ['--cumulative']);

			// Only tasks 1.1 and 1.4 should be counted
			expect(resultText(result)).toContain('Review pass rate: 100%');
			expect(resultText(result)).toContain('(2)');
		});

		it('should aggregate quality metrics from multiple found tasks', async () => {
			await saveEvidence(testDir, '1.1', {
				type: 'quality_budget',
				task_id: '1.1',
				timestamp: mockDate,
				agent: 'quality_budget',
				verdict: 'pass',
				summary: 'Quality passed',
				metrics: {
					complexity_delta: 2,
					public_api_delta: 4,
					duplication_ratio: 0.01,
					test_to_code_ratio: 0.3,
				},
				thresholds: {
					max_complexity_delta: 5,
					max_public_api_delta: 10,
					max_duplication_ratio: 0.05,
					min_test_to_code_ratio: 0.3,
				},
				violations: [],
				files_analyzed: ['src/test.ts'],
			});
			await saveEvidence(testDir, '1.2', {
				type: 'quality_budget',
				task_id: '1.2',
				timestamp: mockDate,
				agent: 'quality_budget',
				verdict: 'pass',
				summary: 'Quality passed',
				metrics: {
					complexity_delta: 6,
					public_api_delta: 8,
					duplication_ratio: 0.03,
					test_to_code_ratio: 0.5,
				},
				thresholds: {
					max_complexity_delta: 5,
					max_public_api_delta: 10,
					max_duplication_ratio: 0.05,
					min_test_to_code_ratio: 0.3,
				},
				violations: [],
				files_analyzed: ['src/test2.ts'],
			});

			const result = await handleBenchmarkCommand(testDir, ['--cumulative']);

			// averages: (2+6)/2=4, (4+8)/2=6, (0.01+0.03)*100/2=2%, (0.3+0.5)*100/2=40%
			expect(resultText(result)).toContain('Complexity Delta: 4');
			expect(resultText(result)).toContain('Public API Delta: 6');
			expect(resultText(result)).toContain('Duplication Ratio: 2%');
			expect(resultText(result)).toContain('Test-to-Code Ratio: 40%');
		});
	});

	describe('CI Gate with loadEvidence discriminated union', () => {
		it('should pass CI gate with found quality_budget evidence', async () => {
			// Create passing review evidence (100%)
			await saveEvidence(testDir, '1.1', {
				type: 'review',
				task_id: '1.1',
				timestamp: mockDate,
				agent: 'reviewer',
				verdict: 'approved',
				summary: 'Good',
				risk: 'low',
				issues: [],
			});
			// Create passing test evidence (100%)
			await saveEvidence(testDir, '1.1', {
				type: 'test',
				task_id: '1.1',
				timestamp: mockDate,
				agent: 'test_engineer',
				verdict: 'pass',
				summary: 'Tests passed',
				tests_passed: 100,
				tests_failed: 0,
				failures: [],
			});
			// Create quality_budget within thresholds
			await saveEvidence(testDir, '1.1', {
				type: 'quality_budget',
				task_id: '1.1',
				timestamp: mockDate,
				agent: 'quality_budget',
				verdict: 'pass',
				summary: 'Quality passed',
				metrics: {
					complexity_delta: 3,
					public_api_delta: 5,
					duplication_ratio: 0.02,
					test_to_code_ratio: 0.4,
				},
				thresholds: {
					max_complexity_delta: 5,
					max_public_api_delta: 10,
					max_duplication_ratio: 0.05,
					min_test_to_code_ratio: 0.3,
				},
				violations: [],
				files_analyzed: ['src/test.ts'],
			});

			const result = await handleBenchmarkCommand(testDir, ['--ci-gate']);

			expect(resultText(result)).toContain('CI Gate');
			expect(resultText(result)).toContain('✅ PASSED');
			expect(resultText(result)).toContain('Complexity Delta: 3 <= 5 ✅');
		});

		it('should skip invalid evidence when checking CI gate (quality checks pass, review/test fail)', async () => {
			// Create invalid JSON file for a task
			const dir = mkEvidenceDir('3.1');
			writeFileSync(path.join(dir, 'evidence.json'), '{ bad json }');

			const result = await handleBenchmarkCommand(testDir, ['--ci-gate']);

			expect(resultText(result)).toContain('CI Gate');
			expect(resultText(result)).toContain('❌ FAILED');
			// Review and test checks fail with 0%
			expect(resultText(result)).toContain('Review pass rate: 0% >= 70% ❌');
			expect(resultText(result)).toContain('Test pass rate: 0% >= 80% ❌');
			// Quality checks pass by default when no evidence
			expect(resultText(result)).toContain('Complexity Delta: 0 <= 5 ✅');
			expect(resultText(result)).toContain('Public API Delta: 0 <= 10 ✅');
			expect(resultText(result)).toContain('Duplication Ratio: 0% <= 5% ✅');
			expect(resultText(result)).toContain('Test-to-Code Ratio: 0% >= 30% ✅');
		});
	});

	describe('In-memory mode (no evidence loading)', () => {
		it('should not read evidence in in-memory mode', async () => {
			// Even with evidence on disk, in-memory mode should not read it
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

			const result = await handleBenchmarkCommand(testDir, []);

			expect(resultText(result)).toContain('mode: in-memory');
			// In-memory mode does NOT include Quality Signals section
			expect(resultText(result)).not.toContain('Quality Signals');
			expect(resultText(result)).not.toContain('No evidence data found');
		});
	});
});
