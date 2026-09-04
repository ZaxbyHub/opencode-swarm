import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleBenchmarkCommand } from '../../../src/commands/benchmark';
import { saveEvidence } from '../../../src/evidence/manager';
import { resetSwarmState, swarmState } from '../../../src/state';
import { resultText } from '../../helpers/benchmark-result-text.js';

let testDir: string;

beforeEach(() => {
	resetSwarmState();
	testDir = path.join(
		os.tmpdir(),
		`benchmark-ci-gate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(path.join(testDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	rmSync(testDir, { recursive: true, force: true });
});

describe('CI Gate Quality Checks', () => {
	async function createPassingEvidence() {
		// Create passing review evidence: 8 approved, 2 rejected = 80% >= 70%
		for (let i = 0; i < 8; i++) {
			await saveEvidence(testDir, `${i + 1}.1`, {
				task_id: `${i + 1}.1`,
				type: 'review',
				timestamp: new Date().toISOString(),
				agent: 'reviewer',
				verdict: 'approved',
				summary: 'Good',
				risk: 'low',
				issues: [],
			});
		}
		for (let i = 0; i < 2; i++) {
			await saveEvidence(testDir, `${i + 1}.2`, {
				task_id: `${i + 1}.2`,
				type: 'review',
				timestamp: new Date().toISOString(),
				agent: 'reviewer',
				verdict: 'rejected',
				summary: 'Bad',
				risk: 'high',
				issues: [],
			});
		}
		// Test evidence: 90 passed, 10 failed = 90% >= 80%
		await saveEvidence(testDir, '9.1', {
			task_id: '9.1',
			type: 'test',
			timestamp: new Date().toISOString(),
			agent: 'test_engineer',
			verdict: 'pass',
			summary: 'Tests done',
			tests_passed: 90,
			tests_failed: 10,
			failures: [],
		});
		// Low error rate tools
		swarmState.toolAggregates.set('read', {
			tool: 'read',
			count: 100,
			successCount: 95,
			failureCount: 5,
			totalDuration: 1000,
		});
	}

	describe('Quality check: Complexity Delta', () => {
		it('passes when complexity delta within threshold', async () => {
			await createPassingEvidence();
			// Add quality_budget evidence with low complexity delta
			await saveEvidence(testDir, '10.1', {
				task_id: '10.1',
				type: 'quality_budget',
				timestamp: new Date().toISOString(),
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

			const result = await handleBenchmarkCommand(testDir, ['--ci-gate']);
			expect(resultText(result)).toContain('Complexity Delta: 3 <= 5 ✅');
		});

		it('fails when complexity delta exceeds threshold', async () => {
			await createPassingEvidence();
			// Add quality_budget evidence with high complexity delta
			await saveEvidence(testDir, '10.1', {
				task_id: '10.1',
				type: 'quality_budget',
				timestamp: new Date().toISOString(),
				agent: 'quality_budget',
				verdict: 'fail',
				summary: 'Complexity exceeded',
				metrics: {
					complexity_delta: 8,
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
				violations: [
					{
						type: 'complexity',
						message: 'Complexity delta exceeds threshold',
						severity: 'error',
						files: ['src/test.ts'],
					},
				],
				files_analyzed: ['src/test.ts'],
			});

			const result = await handleBenchmarkCommand(testDir, ['--ci-gate']);
			expect(resultText(result)).toContain('Complexity Delta: 8 <= 5 ❌');
			expect(resultText(result)).toContain('❌ FAILED');
		});
	});

	describe('Quality check: Public API Delta', () => {
		it('passes when public API delta within threshold', async () => {
			await createPassingEvidence();
			await saveEvidence(testDir, '10.1', {
				task_id: '10.1',
				type: 'quality_budget',
				timestamp: new Date().toISOString(),
				agent: 'quality_budget',
				verdict: 'pass',
				summary: 'Quality budget passed',
				metrics: {
					complexity_delta: 2,
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
			expect(resultText(result)).toContain('Public API Delta: 5 <= 10 ✅');
		});

		it('fails when public API delta exceeds threshold', async () => {
			await createPassingEvidence();
			await saveEvidence(testDir, '10.1', {
				task_id: '10.1',
				type: 'quality_budget',
				timestamp: new Date().toISOString(),
				agent: 'quality_budget',
				verdict: 'fail',
				summary: 'API delta exceeded',
				metrics: {
					complexity_delta: 2,
					public_api_delta: 15,
					duplication_ratio: 0.02,
					test_to_code_ratio: 0.4,
				},
				thresholds: {
					max_complexity_delta: 5,
					max_public_api_delta: 10,
					max_duplication_ratio: 0.05,
					min_test_to_code_ratio: 0.3,
				},
				violations: [
					{
						type: 'api',
						message: 'Public API delta exceeds threshold',
						severity: 'error',
						files: ['src/test.ts'],
					},
				],
				files_analyzed: ['src/test.ts'],
			});

			const result = await handleBenchmarkCommand(testDir, ['--ci-gate']);
			expect(resultText(result)).toContain('Public API Delta: 15 <= 10 ❌');
			expect(resultText(result)).toContain('❌ FAILED');
		});
	});

	describe('Quality check: Duplication Ratio', () => {
		it('passes when duplication ratio within threshold', async () => {
			await createPassingEvidence();
			await saveEvidence(testDir, '10.1', {
				task_id: '10.1',
				type: 'quality_budget',
				timestamp: new Date().toISOString(),
				agent: 'quality_budget',
				verdict: 'pass',
				summary: 'Quality budget passed',
				metrics: {
					complexity_delta: 2,
					public_api_delta: 5,
					duplication_ratio: 0.03,
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
			expect(resultText(result)).toContain('Duplication Ratio: 3% <= 5% ✅');
		});

		it('fails when duplication ratio exceeds threshold', async () => {
			await createPassingEvidence();
			await saveEvidence(testDir, '10.1', {
				task_id: '10.1',
				type: 'quality_budget',
				timestamp: new Date().toISOString(),
				agent: 'quality_budget',
				verdict: 'fail',
				summary: 'Duplication exceeded',
				metrics: {
					complexity_delta: 2,
					public_api_delta: 5,
					duplication_ratio: 0.08,
					test_to_code_ratio: 0.4,
				},
				thresholds: {
					max_complexity_delta: 5,
					max_public_api_delta: 10,
					max_duplication_ratio: 0.05,
					min_test_to_code_ratio: 0.3,
				},
				violations: [
					{
						type: 'duplication',
						message: 'Duplication ratio exceeds threshold',
						severity: 'error',
						files: ['src/test.ts'],
					},
				],
				files_analyzed: ['src/test.ts'],
			});

			const result = await handleBenchmarkCommand(testDir, ['--ci-gate']);
			expect(resultText(result)).toContain('Duplication Ratio: 8% <= 5% ❌');
			expect(resultText(result)).toContain('❌ FAILED');
		});
	});

	describe('Quality check: Test-to-Code Ratio', () => {
		it('passes when test-to-code ratio meets threshold', async () => {
			await createPassingEvidence();
			await saveEvidence(testDir, '10.1', {
				task_id: '10.1',
				type: 'quality_budget',
				timestamp: new Date().toISOString(),
				agent: 'quality_budget',
				verdict: 'pass',
				summary: 'Quality budget passed',
				metrics: {
					complexity_delta: 2,
					public_api_delta: 5,
					duplication_ratio: 0.02,
					test_to_code_ratio: 0.5,
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
			expect(resultText(result)).toContain('Test-to-Code Ratio: 50% >= 30% ✅');
		});

		it('fails when test-to-code ratio below threshold', async () => {
			await createPassingEvidence();
			await saveEvidence(testDir, '10.1', {
				task_id: '10.1',
				type: 'quality_budget',
				timestamp: new Date().toISOString(),
				agent: 'quality_budget',
				verdict: 'fail',
				summary: 'Test ratio too low',
				metrics: {
					complexity_delta: 2,
					public_api_delta: 5,
					duplication_ratio: 0.02,
					test_to_code_ratio: 0.1,
				},
				thresholds: {
					max_complexity_delta: 5,
					max_public_api_delta: 10,
					max_duplication_ratio: 0.05,
					min_test_to_code_ratio: 0.3,
				},
				violations: [
					{
						type: 'test_ratio',
						message: 'Test-to-code ratio below threshold',
						severity: 'error',
						files: ['src/test.ts'],
					},
				],
				files_analyzed: ['src/test.ts'],
			});

			const result = await handleBenchmarkCommand(testDir, ['--ci-gate']);
			expect(resultText(result)).toContain('Test-to-Code Ratio: 10% >= 30% ❌');
			expect(resultText(result)).toContain('❌ FAILED');
		});
	});

	describe('All quality checks passing', () => {
		it('ci-gate passes when all quality checks pass', async () => {
			await createPassingEvidence();
			await saveEvidence(testDir, '10.1', {
				task_id: '10.1',
				type: 'quality_budget',
				timestamp: new Date().toISOString(),
				agent: 'quality_budget',
				verdict: 'pass',
				summary: 'All quality checks passed',
				metrics: {
					complexity_delta: 3,
					public_api_delta: 5,
					duplication_ratio: 0.02,
					test_to_code_ratio: 0.5,
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
			expect(resultText(result)).toContain('✅ PASSED');
			// All quality checks should pass
			expect(resultText(result)).toContain('Complexity Delta: 3 <= 5 ✅');
			expect(resultText(result)).toContain('Public API Delta: 5 <= 10 ✅');
			expect(resultText(result)).toContain('Duplication Ratio: 2% <= 5% ✅');
			expect(resultText(result)).toContain('Test-to-Code Ratio: 50% >= 30% ✅');
		});
	});

	describe('Quality Metrics section in output', () => {
		it('displays Quality Metrics section when evidence exists', async () => {
			await createPassingEvidence();
			await saveEvidence(testDir, '10.1', {
				task_id: '10.1',
				type: 'quality_budget',
				timestamp: new Date().toISOString(),
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
			expect(resultText(result)).toContain('### Quality Metrics');
			expect(resultText(result)).toContain('Complexity Delta: 3');
			expect(resultText(result)).toContain('Public API Delta: 5');
			expect(resultText(result)).toContain('Duplication Ratio: 2%');
			expect(resultText(result)).toContain('Test-to-Code Ratio: 40%');
		});

		it('does not display Quality Metrics section when no evidence', async () => {
			await createPassingEvidence();
			// No quality_budget evidence
			const result = await handleBenchmarkCommand(testDir, ['--ci-gate']);
			expect(resultText(result)).not.toContain('### Quality Metrics');
		});
	});

	describe('JSON output with quality metrics', () => {
		it('includes quality_metrics in JSON output', async () => {
			await createPassingEvidence();
			await saveEvidence(testDir, '10.1', {
				task_id: '10.1',
				type: 'quality_budget',
				timestamp: new Date().toISOString(),
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
			const jsonMatch = resultText(result).match(
				/\[BENCHMARK_JSON\]\n([\s\S]*?)\n\[\/BENCHMARK_JSON\]/,
			);
			expect(jsonMatch).not.toBeNull();
			const parsed = JSON.parse(jsonMatch![1]);
			expect(parsed.quality_metrics).toBeDefined();
			expect(parsed.quality_metrics.complexity_delta).toBe(3);
			expect(parsed.quality_metrics.public_api_delta).toBe(5);
			expect(parsed.quality_metrics.duplication_ratio).toBe(2);
			expect(parsed.quality_metrics.test_to_code_ratio).toBe(40);
			expect(parsed.quality_metrics.has_evidence).toBe(true);
			expect(parsed.quality_metrics.thresholds).toEqual({
				maxComplexityDelta: 5,
				maxPublicApiDelta: 10,
				maxDuplicationRatio: 5,
				minTestToCodeRatio: 30,
			});
		});

		it('JSON remains parseable with quality metrics', async () => {
			await createPassingEvidence();
			await saveEvidence(testDir, '10.1', {
				task_id: '10.1',
				type: 'quality_budget',
				timestamp: new Date().toISOString(),
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
			const jsonMatch = resultText(result).match(
				/\[BENCHMARK_JSON\]\n([\s\S]*?)\n\[\/BENCHMARK_JSON\]/,
			);
			expect(jsonMatch).not.toBeNull();
			// Should not throw
			expect(() => JSON.parse(jsonMatch![1])).not.toThrow();
		});

		it('includes all 8 checks in ci_gate when quality evidence exists', async () => {
			await createPassingEvidence();
			await saveEvidence(testDir, '10.1', {
				task_id: '10.1',
				type: 'quality_budget',
				timestamp: new Date().toISOString(),
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
			const jsonMatch = resultText(result).match(
				/\[BENCHMARK_JSON\]\n([\s\S]*?)\n\[\/BENCHMARK_JSON\]/,
			);
			const parsed = JSON.parse(jsonMatch![1]);
			// Should have 8 checks now (4 original + 4 quality)
			expect(parsed.ci_gate.checks).toHaveLength(8);
			// Verify all quality check names
			const checkNames = parsed.ci_gate.checks.map(
				(c: { name: string }) => c.name,
			);
			expect(checkNames).toContain('Complexity Delta');
			expect(checkNames).toContain('Public API Delta');
			expect(checkNames).toContain('Duplication Ratio');
			expect(checkNames).toContain('Test-to-Code Ratio');
		});
	});

	describe('Multiple quality budget evidence entries', () => {
		it('averages metrics from multiple quality_budget evidence entries', async () => {
			await createPassingEvidence();
			// First evidence: complexity 2
			await saveEvidence(testDir, '10.1', {
				task_id: '10.1',
				type: 'quality_budget',
				timestamp: new Date().toISOString(),
				agent: 'quality_budget',
				verdict: 'pass',
				summary: 'First check',
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
			// Second evidence: complexity 6
			await saveEvidence(testDir, '10.2', {
				task_id: '10.2',
				type: 'quality_budget',
				timestamp: new Date().toISOString(),
				agent: 'quality_budget',
				verdict: 'fail',
				summary: 'Second check',
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

			const result = await handleBenchmarkCommand(testDir, ['--ci-gate']);
			// Average: (2+6)/2 = 4
			expect(resultText(result)).toContain('Complexity Delta: 4 <= 5 ✅');
			// Average: (4+8)/2 = 6
			expect(resultText(result)).toContain('Public API Delta: 6 <= 10 ✅');
			// Average: (0.01+0.03)*100/2 = 2%
			expect(resultText(result)).toContain('Duplication Ratio: 2% <= 5% ✅');
			// Average: (0.3+0.5)*100/2 = 40%
			expect(resultText(result)).toContain('Test-to-Code Ratio: 40% >= 30% ✅');
		});
	});
});
