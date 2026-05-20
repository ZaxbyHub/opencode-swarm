import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runDeterministicDriftCheck } from './curator-drift';
import type { CuratorConfig, CuratorPhaseResult } from './curator-types';

// Test utilities
function createTempDir(): string {
	const dir = fs.mkdtempSync(
		path.join(os.tmpdir(), 'curator-drift-advisory-test-'),
	);
	return dir;
}

function cleanupDir(dir: string): void {
	if (fs.existsSync(dir)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// Mock event bus to prevent real event publishing
const mockPublish = mock(() => Promise.resolve());
mock.module('../background/event-bus.js', () => ({
	getGlobalEventBus: () => ({
		publish: mockPublish,
	}),
}));

const defaultPhaseResult: CuratorPhaseResult = {
	phase: 1,
	digest: {
		phase: 1,
		timestamp: '2026-01-01',
		summary: 'Test phase summary',
		agents_used: ['coder'],
		tasks_completed: 3,
		tasks_total: 5,
		key_decisions: [],
		blockers_resolved: [],
	},
	compliance: [],
	knowledge_recommendations: [],
	summary_updated: true,
};

const defaultConfig: CuratorConfig = {
	enabled: true,
	init_enabled: true,
	phase_enabled: true,
	max_summary_tokens: 1000,
	min_knowledge_confidence: 0.7,
	compliance_report: true,
	suppress_warnings: false,
	drift_inject_max_chars: 500,
};

describe('curator-drift advisory injection', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = createTempDir();
		mockPublish.mockClear();
	});

	afterEach(() => {
		mock.restore();
		cleanupDir(tempDir);
	});

	describe('backward compatibility', () => {
		it('works normally when injectAdvisory is NOT provided', async () => {
			const result = await runDeterministicDriftCheck(
				tempDir,
				1,
				defaultPhaseResult,
				defaultConfig,
			);

			// Should still return a valid result
			expect(result).toBeDefined();
			expect(result.phase).toBe(1);
			expect(result.report).toBeDefined();
			// No plan.md means alignment will be MINOR_DRIFT with driftScore 0.3
			expect(result.report.alignment).toBe('MINOR_DRIFT');
		});
	});

	describe('advisory injection on drift detection', () => {
		it('calls injectAdvisory with CURATOR DRIFT DETECTED when drift_score > 0', async () => {
			const advisoryCalls: string[] = [];
			const injectAdvisory = (message: string) => {
				advisoryCalls.push(message);
			};

			// No plan.md → alignment = MINOR_DRIFT, driftScore = 0.3
			const result = await runDeterministicDriftCheck(
				tempDir,
				1,
				defaultPhaseResult,
				defaultConfig,
				injectAdvisory,
			);

			expect(result.report.alignment).toBe('MINOR_DRIFT');
			expect(advisoryCalls.length).toBe(1);
			expect(advisoryCalls[0]).toContain('CURATOR DRIFT DETECTED');
		});

		it('calls injectAdvisory when compliance has warnings (drift_score > 0)', async () => {
			const advisoryCalls: string[] = [];
			const injectAdvisory = (message: string) => {
				advisoryCalls.push(message);
			};

			// 3+ warnings → MAJOR_DRIFT with driftScore >= 0.8
			const phaseResultWithWarnings: CuratorPhaseResult = {
				...defaultPhaseResult,
				compliance: [
					{
						phase: 1,
						timestamp: '2026-01-01',
						type: 'missing_reviewer',
						description: 'No reviewer dispatched',
						severity: 'warning',
					},
					{
						phase: 1,
						timestamp: '2026-01-01',
						type: 'missing_retro',
						description: 'No retro recorded',
						severity: 'warning',
					},
					{
						phase: 1,
						timestamp: '2026-01-01',
						type: 'missing_sme',
						description: 'No SME review',
						severity: 'warning',
					},
				],
			};

			// Create .swarm/plan.md (validateSwarmPath restricts reads to .swarm directory)
			fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'plan.md'),
				'# Test Plan\nDo the thing.',
			);

			const result = await runDeterministicDriftCheck(
				tempDir,
				1,
				phaseResultWithWarnings,
				defaultConfig,
				injectAdvisory,
			);

			expect(result.report.alignment).toBe('MAJOR_DRIFT');
			expect(advisoryCalls.length).toBe(1);
			expect(advisoryCalls[0]).toContain('CURATOR DRIFT DETECTED');
		});
	});

	describe('no advisory when no drift', () => {
		it('does NOT call injectAdvisory when alignment == ALIGNED', async () => {
			const advisoryCalls: string[] = [];
			const injectAdvisory = (message: string) => {
				advisoryCalls.push(message);
			};

			// Empty compliance AND plan.md present → alignment = ALIGNED, driftScore = 0
			// Create .swarm/plan.md (validateSwarmPath restricts reads to .swarm directory)
			fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'plan.md'),
				'# Test Plan\nDo the thing.',
			);

			const result = await runDeterministicDriftCheck(
				tempDir,
				1,
				defaultPhaseResult,
				defaultConfig,
				injectAdvisory,
			);

			expect(result.report.alignment).toBe('ALIGNED');
			expect(result.report.drift_score).toBe(0);
			expect(advisoryCalls.length).toBe(0);
		});

		it('does NOT call injectAdvisory when drift_score == 0', async () => {
			const advisoryCalls: string[] = [];
			const injectAdvisory = (message: string) => {
				advisoryCalls.push(message);
			};

			// Create .swarm/plan.md so alignment can be ALIGNED
			fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'plan.md'),
				'# Test Plan\nDo the thing.',
			);

			// With only 2 non-warning compliance observations, alignment stays ALIGNED
			const phaseResultWithMinorCompliance: CuratorPhaseResult = {
				...defaultPhaseResult,
				compliance: [
					{
						phase: 1,
						timestamp: '2026-01-01',
						type: 'missing_reviewer',
						description: 'No reviewer dispatched',
						severity: 'info',
					},
					{
						phase: 1,
						timestamp: '2026-01-01',
						type: 'missing_retro',
						description: 'No retro recorded',
						severity: 'info',
					},
				],
			};

			const result = await runDeterministicDriftCheck(
				tempDir,
				1,
				phaseResultWithMinorCompliance,
				defaultConfig,
				injectAdvisory,
			);

			expect(result.report.alignment).toBe('ALIGNED');
			expect(advisoryCalls.length).toBe(0);
		});
	});

	describe('advisory injection error handling', () => {
		it('catches error when injectAdvisory throws and still returns successfully', async () => {
			const injectAdvisory = (_message: string) => {
				throw new Error('Advisory injection failed');
			};

			// No plan.md → will trigger advisory call but it will throw
			const result = await runDeterministicDriftCheck(
				tempDir,
				1,
				defaultPhaseResult,
				defaultConfig,
				injectAdvisory,
			);

			// Should still return valid result (not throw)
			expect(result).toBeDefined();
			expect(result.phase).toBe(1);
			expect(result.report).toBeDefined();
			expect(result.report.alignment).toBe('MINOR_DRIFT');
		});

		it('catches error when injectAdvisory throws synchronously', async () => {
			let callCount = 0;
			const injectAdvisory = (_message: string) => {
				callCount++;
				if (callCount === 1) {
					throw new Error('First call fails');
				}
			};

			const result = await runDeterministicDriftCheck(
				tempDir,
				1,
				defaultPhaseResult,
				defaultConfig,
				injectAdvisory,
			);

			// Should complete without throwing despite advisory error
			expect(result).toBeDefined();
			expect(result.report.alignment).toBe('MINOR_DRIFT');
		});
	});
});
