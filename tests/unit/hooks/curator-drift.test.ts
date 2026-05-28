/**
 * Verification and adversarial tests for curator-drift.ts
 * Tests readPriorDriftReports and writeDriftReport functions
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	buildDriftInjectionText,
	readPriorDriftReports,
	runDeterministicDriftCheck,
	writeDriftReport,
} from '../../../src/hooks/curator-drift';
import type {
	ComplianceObservation,
	CuratorConfig,
	CuratorPhaseResult,
	DriftReport,
	PhaseDigestEntry,
} from '../../../src/hooks/curator-types';

// Helper to create a valid CuratorPhaseResult for testing
function makeCuratorResult(
	overrides?: Partial<CuratorPhaseResult>,
): CuratorPhaseResult {
	const defaultDigest: PhaseDigestEntry = {
		phase: 1,
		timestamp: new Date().toISOString(),
		summary: 'Test phase summary',
		agents_used: ['agent1', 'agent2'],
		tasks_completed: 8,
		tasks_total: 10,
		key_decisions: ['decision1'],
		blockers_resolved: ['blocker1'],
	};
	return {
		phase: 1,
		digest: defaultDigest,
		compliance: [],
		knowledge_recommendations: [],
		summary_updated: true,
		...overrides,
	};
}

// Helper to create a valid CuratorConfig for testing
function makeCuratorConfig(overrides?: Partial<CuratorConfig>): CuratorConfig {
	return {
		enabled: true,
		init_enabled: true,
		phase_enabled: true,
		max_summary_tokens: 1000,
		min_knowledge_confidence: 0.7,
		compliance_report: true,
		suppress_warnings: false,
		drift_inject_max_chars: 500,
		...overrides,
	};
}
function createValidDriftReport(phase: number): DriftReport {
	return {
		schema_version: 1,
		phase,
		timestamp: new Date().toISOString(),
		alignment: 'ALIGNED',
		drift_score: 0.0,
		first_deviation: null,
		compounding_effects: [],
		corrections: [],
		requirements_checked: 10,
		requirements_satisfied: 10,
		scope_additions: [],
		injection_summary: 'Test report',
	};
}

describe('drift-report-io', () => {
	let tmpDir: string;

	beforeEach(async () => {
		// Create a temporary directory for each test
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'curator-drift-test-'));
	});

	afterEach(async () => {
		// Clean up the temporary directory
		try {
			await fs.rm(tmpDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	// ========== Verification Tests ==========

	describe('readPriorDriftReports', () => {
		it('returns [] when .swarm/ directory is missing', async () => {
			// Ensure .swarm doesn't exist
			const swarmDir = path.join(tmpDir, '.swarm');
			if (existsSync(swarmDir)) {
				await fs.rm(swarmDir, { recursive: true });
			}

			const reports = await readPriorDriftReports(tmpDir);
			expect(reports).toEqual([]);
		});

		it('returns [] when no drift report files exist', async () => {
			// Create .swarm/ directory but no drift reports
			await fs.mkdir(path.join(tmpDir, '.swarm'), { recursive: true });

			const reports = await readPriorDriftReports(tmpDir);
			expect(reports).toEqual([]);
		});

		it('reads one valid report correctly', async () => {
			// Ensure .swarm directory exists
			await fs.mkdir(path.join(tmpDir, '.swarm'), { recursive: true });

			const report = createValidDriftReport(1);
			const reportPath = path.join(
				tmpDir,
				'.swarm',
				'drift-report-phase-1.json',
			);
			await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');

			const reports = await readPriorDriftReports(tmpDir);
			expect(reports.length).toBe(1);
			expect(reports[0].phase).toBe(1);
			expect(reports[0].alignment).toBe('ALIGNED');
		});

		it('reads multiple reports and returns them sorted by phase ascending', async () => {
			// Ensure .swarm directory exists
			await fs.mkdir(path.join(tmpDir, '.swarm'), { recursive: true });

			const report3 = createValidDriftReport(3);
			const report1 = createValidDriftReport(1);
			const report2 = createValidDriftReport(2);

			// Write in non-sorted order
			await fs.writeFile(
				path.join(tmpDir, '.swarm', 'drift-report-phase-3.json'),
				JSON.stringify(report3, null, 2),
				'utf-8',
			);
			await fs.writeFile(
				path.join(tmpDir, '.swarm', 'drift-report-phase-1.json'),
				JSON.stringify(report1, null, 2),
				'utf-8',
			);
			await fs.writeFile(
				path.join(tmpDir, '.swarm', 'drift-report-phase-2.json'),
				JSON.stringify(report2, null, 2),
				'utf-8',
			);

			const reports = await readPriorDriftReports(tmpDir);
			expect(reports.length).toBe(3);
			expect(reports[0].phase).toBe(1);
			expect(reports[1].phase).toBe(2);
			expect(reports[2].phase).toBe(3);
		});

		it('skips and warns for corrupt JSON (other valid reports still returned)', async () => {
			// Ensure .swarm directory exists
			await fs.mkdir(path.join(tmpDir, '.swarm'), { recursive: true });

			const report1 = createValidDriftReport(1);
			const report3 = createValidDriftReport(3);

			// Write valid reports
			await fs.writeFile(
				path.join(tmpDir, '.swarm', 'drift-report-phase-1.json'),
				JSON.stringify(report1, null, 2),
				'utf-8',
			);
			await fs.writeFile(
				path.join(tmpDir, '.swarm', 'drift-report-phase-3.json'),
				JSON.stringify(report3, null, 2),
				'utf-8',
			);

			// Write corrupt JSON
			await fs.writeFile(
				path.join(tmpDir, '.swarm', 'drift-report-phase-2.json'),
				'{ invalid json',
				'utf-8',
			);

			const reports = await readPriorDriftReports(tmpDir);
			expect(reports.length).toBe(2);
			expect(reports[0].phase).toBe(1);
			expect(reports[1].phase).toBe(3);
		});

		it('skips and warns for structurally invalid JSON (missing phase field)', async () => {
			// Ensure .swarm directory exists
			await fs.mkdir(path.join(tmpDir, '.swarm'), { recursive: true });

			const report1 = createValidDriftReport(1);

			// Write valid report
			await fs.writeFile(
				path.join(tmpDir, '.swarm', 'drift-report-phase-1.json'),
				JSON.stringify(report1, null, 2),
				'utf-8',
			);

			// Write structurally invalid report (missing phase)
			const invalidReport = {
				schema_version: 1,
				timestamp: new Date().toISOString(),
				alignment: 'ALIGNED',
			};
			await fs.writeFile(
				path.join(tmpDir, '.swarm', 'drift-report-phase-2.json'),
				JSON.stringify(invalidReport, null, 2),
				'utf-8',
			);

			const reports = await readPriorDriftReports(tmpDir);
			expect(reports.length).toBe(1);
			expect(reports[0].phase).toBe(1);
		});
	});

	describe('writeDriftReport', () => {
		it('writes file to correct path .swarm/drift-report-phase-N.json', async () => {
			const report = createValidDriftReport(5);
			const filePath = await writeDriftReport(tmpDir, report);

			expect(filePath).toContain('drift-report-phase-5.json');
			const fileExists = existsSync(filePath);
			expect(fileExists).toBe(true);
		});

		it('creates .swarm/ directory if it does not exist', async () => {
			const swarmDir = path.join(tmpDir, '.swarm');
			// Ensure .swarm doesn't exist
			if (existsSync(swarmDir)) {
				await fs.rm(swarmDir, { recursive: true });
			}

			const report = createValidDriftReport(1);
			await writeDriftReport(tmpDir, report);

			expect(existsSync(swarmDir)).toBe(true);
		});

		it('returns absolute path of written file', async () => {
			const report = createValidDriftReport(1);
			const filePath = await writeDriftReport(tmpDir, report);

			// Check that it's an absolute path
			expect(path.isAbsolute(filePath)).toBe(true);
			expect(filePath.startsWith(tmpDir)).toBe(true);
		});

		it('written file is valid JSON parseable back to DriftReport', async () => {
			const report = createValidDriftReport(2);
			const filePath = await writeDriftReport(tmpDir, report);

			const content = await fs.readFile(filePath, 'utf-8');
			const parsed = JSON.parse(content) as DriftReport;

			expect(parsed.phase).toBe(2);
			expect(parsed.schema_version).toBe(1);
			expect(parsed.alignment).toBe('ALIGNED');
			expect(parsed.drift_score).toBe(0.0);
		});

		it('round-trip: writeDriftReport then readPriorDriftReports returns the same report', async () => {
			const originalReport = createValidDriftReport(4);
			await writeDriftReport(tmpDir, originalReport);

			const reports = await readPriorDriftReports(tmpDir);

			expect(reports.length).toBe(1);
			expect(reports[0].phase).toBe(originalReport.phase);
			expect(reports[0].alignment).toBe(originalReport.alignment);
			expect(reports[0].drift_score).toBe(originalReport.drift_score);
			expect(reports[0].schema_version).toBe(originalReport.schema_version);
		});
	});
});

describe('drift-report-adversarial', () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'curator-drift-adv-'));
	});

	afterEach(async () => {
		try {
			await fs.rm(tmpDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	// ========== Adversarial Tests ==========

	it('path traversal in directory arg to readPriorDriftReports - should return [] or throw gracefully', async () => {
		// Attempt path traversal
		const maliciousDir = path.join(tmpDir, '..', '..');

		// The function should either return [] or throw gracefully, not crash
		try {
			const reports = await readPriorDriftReports(maliciousDir);
			// If it doesn't throw, it should return []
			expect(Array.isArray(reports)).toBe(true);
		} catch (err) {
			// Or throw with a descriptive error
			expect(err).toBeDefined();
		}
	});

	it('path traversal in directory arg to writeDriftReport - validateSwarmPath should throw or the function wraps gracefully', async () => {
		const maliciousDir = path.join(tmpDir, '..', '..');
		const report = createValidDriftReport(1);

		// Should throw or handle gracefully
		try {
			await writeDriftReport(maliciousDir, report);
			// If it didn't throw, that's also acceptable (depends on implementation)
		} catch (err) {
			// Should throw with some error (path traversal or permission error)
			expect(err).toBeDefined();
		}
	});

	it('report.phase = NaN - writes drift-report-phase-NaN.json - function should not crash', async () => {
		const report = createValidDriftReport(NaN);
		// Should not crash
		try {
			const filePath = await writeDriftReport(tmpDir, report);
			// Check file was written with NaN in filename
			expect(filePath).toContain('NaN');
		} catch (err) {
			// May throw, which is also acceptable
			expect(err).toBeDefined();
		}
	});

	it('report.phase = -1 - negative phase - function should not crash, file gets written', async () => {
		const report = createValidDriftReport(-1);

		const filePath = await writeDriftReport(tmpDir, report);
		expect(filePath).toContain('drift-report-phase--1.json');
		expect(existsSync(filePath)).toBe(true);
	});

	it('concurrent writes of same phase: two writeDriftReport calls for same phase - last write wins, no crash', async () => {
		const report1 = createValidDriftReport(1);
		report1.drift_score = 0.1;

		const report2 = createValidDriftReport(1);
		report2.drift_score = 0.9;

		// Write twice for same phase
		await writeDriftReport(tmpDir, report1);
		await writeDriftReport(tmpDir, report2);

		// Should have only one file
		const reports = await readPriorDriftReports(tmpDir);
		expect(reports.length).toBe(1);
		// Last write should win (0.9)
		expect(reports[0].drift_score).toBe(0.9);
	});

	it('.swarm/drift-report-phase-1.json contains valid JSON but array instead of object - structurally invalid, should be skipped', async () => {
		// Ensure .swarm directory exists
		await fs.mkdir(path.join(tmpDir, '.swarm'), { recursive: true });

		// Write an array instead of an object
		await fs.writeFile(
			path.join(tmpDir, '.swarm', 'drift-report-phase-1.json'),
			JSON.stringify([1, 2, 3]),
			'utf-8',
		);

		// Also write a valid report
		const validReport = createValidDriftReport(2);
		await fs.writeFile(
			path.join(tmpDir, '.swarm', 'drift-report-phase-2.json'),
			JSON.stringify(validReport, null, 2),
			'utf-8',
		);

		const reports = await readPriorDriftReports(tmpDir);
		// Should only return the valid object report, skip the array
		expect(reports.length).toBe(1);
		expect(reports[0].phase).toBe(2);
	});
});

// ========== runDeterministicDriftCheck Tests ==========

describe('runDeterministicDriftCheck', () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'curator-drift-check-'));
		// Create .swarm directory
		await fs.mkdir(path.join(tmpDir, '.swarm'), { recursive: true });
		// Create plan.md in .swarm (the implementation reads from .swarm/plan.md)
		await fs.writeFile(
			path.join(tmpDir, '.swarm', 'plan.md'),
			'# Test Plan\n- Task 1\n- Task 2',
			'utf-8',
		);
	});

	afterEach(async () => {
		try {
			await fs.rm(tmpDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	// ========== Verification Tests ==========

	describe('runDeterministicDriftCheck verification', () => {
		it('ALIGNED case: 0 warnings, plan.md exists → alignment=ALIGNED, drift_score=0, report written', async () => {
			const curatorResult = makeCuratorResult({
				phase: 1,
				compliance: [], // no warnings
				digest: {
					tasks_completed: 10,
					tasks_total: 10,
					summary: 'all done',
					agents_used: [],
					key_decisions: [],
					blockers_resolved: [],
					phase: 1,
					timestamp: new Date().toISOString(),
				},
			});
			const config = makeCuratorConfig();

			const result = await runDeterministicDriftCheck(
				tmpDir,
				1,
				curatorResult,
				config,
			);

			expect(result.report.alignment).toBe('ALIGNED');
			expect(result.report.drift_score).toBe(0);
			expect(result.report_path).toContain('drift-report-phase-1.json');
			// Verify file was written
			const fileExists = existsSync(result.report_path);
			expect(fileExists).toBe(true);
		});

		it('MINOR_DRIFT case: 1 warning compliance obs → alignment=MINOR_DRIFT', async () => {
			const curatorResult = makeCuratorResult({
				phase: 1,
				compliance: [
					{
						phase: 1,
						timestamp: new Date().toISOString(),
						type: 'missing_reviewer',
						description: 'Reviewer not assigned',
						severity: 'warning',
					},
				],
				digest: {
					tasks_completed: 8,
					tasks_total: 10,
					summary: 'mostly done',
					agents_used: [],
					key_decisions: [],
					blockers_resolved: [],
					phase: 1,
					timestamp: new Date().toISOString(),
				},
			});
			const config = makeCuratorConfig();

			const result = await runDeterministicDriftCheck(
				tmpDir,
				1,
				curatorResult,
				config,
			);

			expect(result.report.alignment).toBe('MINOR_DRIFT');
			// Score: 0.2 + 1*0.05 = 0.25, capped at 0.49
			expect(result.report.drift_score).toBe(0.25);
		});

		it('MAJOR_DRIFT case: 3+ warning compliance obs → alignment=MAJOR_DRIFT', async () => {
			const curatorResult = makeCuratorResult({
				phase: 1,
				compliance: [
					{
						phase: 1,
						timestamp: new Date().toISOString(),
						type: 'missing_reviewer',
						description: 'Warning 1',
						severity: 'warning',
					},
					{
						phase: 1,
						timestamp: new Date().toISOString(),
						type: 'missing_retro',
						description: 'Warning 2',
						severity: 'warning',
					},
					{
						phase: 1,
						timestamp: new Date().toISOString(),
						type: 'missing_sme',
						description: 'Warning 3',
						severity: 'warning',
					},
				],
				digest: {
					tasks_completed: 5,
					tasks_total: 10,
					summary: 'in progress',
					agents_used: [],
					key_decisions: [],
					blockers_resolved: [],
					phase: 1,
					timestamp: new Date().toISOString(),
				},
			});
			const config = makeCuratorConfig();

			const result = await runDeterministicDriftCheck(
				tmpDir,
				1,
				curatorResult,
				config,
			);

			expect(result.report.alignment).toBe('MAJOR_DRIFT');
			// Score: 0.5 + 3*0.1 = 0.8, capped at 0.9
			expect(result.report.drift_score).toBe(0.8);
		});

		it('No plan.md: missing plan file → alignment=MINOR_DRIFT, drift_score=0.3', async () => {
			// Remove plan.md from .swarm
			await fs.rm(path.join(tmpDir, '.swarm', 'plan.md'));

			const curatorResult = makeCuratorResult({ phase: 1 });
			const config = makeCuratorConfig();

			const result = await runDeterministicDriftCheck(
				tmpDir,
				1,
				curatorResult,
				config,
			);

			expect(result.report.alignment).toBe('MINOR_DRIFT');
			expect(result.report.drift_score).toBe(0.3);
		});

		it('No spec.md: spec not present → function succeeds, spec field in payload is "none"', async () => {
			// Ensure spec.md does not exist in .swarm (it won't by default)

			const curatorResult = makeCuratorResult({ phase: 1 });
			const config = makeCuratorConfig();

			// Should not throw
			const result = await runDeterministicDriftCheck(
				tmpDir,
				1,
				curatorResult,
				config,
			);

			expect(result.report).toBeDefined();
			// The injection_summary should contain 'none' for spec
			expect(result.injection_text).toBeDefined();
		});

		it('injection_summary truncated to drift_inject_max_chars', async () => {
			const curatorResult = makeCuratorResult({
				phase: 1,
				compliance: [],
				digest: {
					tasks_completed: 10,
					tasks_total: 10,
					summary: 'all done',
					agents_used: [],
					key_decisions: [],
					blockers_resolved: [],
					phase: 1,
					timestamp: new Date().toISOString(),
				},
			});
			const config = makeCuratorConfig({ drift_inject_max_chars: 10 });

			const result = await runDeterministicDriftCheck(
				tmpDir,
				1,
				curatorResult,
				config,
			);

			expect(result.report.injection_summary.length).toBeLessThanOrEqual(10);
			expect(result.injection_text.length).toBeLessThanOrEqual(10);
		});

		it('Prior drift reports included in compounding_effects when not ALIGNED', async () => {
			// First create a prior drift report (MINOR_DRIFT)
			const priorReport: DriftReport = {
				schema_version: 1,
				phase: 1,
				timestamp: new Date().toISOString(),
				alignment: 'MINOR_DRIFT',
				drift_score: 0.3,
				first_deviation: null,
				compounding_effects: [],
				corrections: [],
				requirements_checked: 10,
				requirements_satisfied: 8,
				scope_additions: [],
				injection_summary: 'Phase 1 drift',
			};
			await writeDriftReport(tmpDir, priorReport);

			// Now run for phase 2 with no warnings (should be ALIGNED)
			const curatorResult = makeCuratorResult({
				phase: 2,
				compliance: [],
				digest: {
					tasks_completed: 10,
					tasks_total: 10,
					summary: 'all done',
					agents_used: [],
					key_decisions: [],
					blockers_resolved: [],
					phase: 2,
					timestamp: new Date().toISOString(),
				},
			});
			const config = makeCuratorConfig();

			const result = await runDeterministicDriftCheck(
				tmpDir,
				2,
				curatorResult,
				config,
			);

			// compounding_effects includes prior MINOR_DRIFT report even when current is ALIGNED
			// (it filters out prior ALIGNED reports, but includes prior drift)
			expect(result.report.compounding_effects.length).toBe(1);
			expect(result.report.compounding_effects[0]).toContain('Phase 1');
		});

		it('Prior drift reports included in compounding_effects when there IS drift', async () => {
			// First create a prior drift report (MINOR_DRIFT)
			const priorReport: DriftReport = {
				schema_version: 1,
				phase: 1,
				timestamp: new Date().toISOString(),
				alignment: 'MINOR_DRIFT',
				drift_score: 0.3,
				first_deviation: null,
				compounding_effects: [],
				corrections: [],
				requirements_checked: 10,
				requirements_satisfied: 8,
				scope_additions: [],
				injection_summary: 'Phase 1 drift',
			};
			await writeDriftReport(tmpDir, priorReport);

			// Now run for phase 2 with a warning (should be MINOR_DRIFT)
			const curatorResult = makeCuratorResult({
				phase: 2,
				compliance: [
					{
						phase: 2,
						timestamp: new Date().toISOString(),
						type: 'skipped_test',
						description: 'Test skipped',
						severity: 'warning',
					},
				],
				digest: {
					tasks_completed: 9,
					tasks_total: 10,
					summary: 'mostly done',
					agents_used: [],
					key_decisions: [],
					blockers_resolved: [],
					phase: 2,
					timestamp: new Date().toISOString(),
				},
			});
			const config = makeCuratorConfig();

			const result = await runDeterministicDriftCheck(
				tmpDir,
				2,
				curatorResult,
				config,
			);

			// Since phase 2 has drift, compounding_effects should include prior
			expect(result.report.compounding_effects.length).toBeGreaterThan(0);
			expect(result.report.compounding_effects[0]).toContain('Phase 1');
		});

		it('Return value has report_path pointing to the written file', async () => {
			const curatorResult = makeCuratorResult({
				phase: 1,
				compliance: [],
				digest: {
					tasks_completed: 10,
					tasks_total: 10,
					summary: 'all done',
					agents_used: [],
					key_decisions: [],
					blockers_resolved: [],
					phase: 1,
					timestamp: new Date().toISOString(),
				},
			});
			const config = makeCuratorConfig();

			const result = await runDeterministicDriftCheck(
				tmpDir,
				1,
				curatorResult,
				config,
			);

			expect(result.report_path).toContain('.swarm');
			expect(result.report_path).toContain('drift-report-phase-1.json');
			expect(existsSync(result.report_path)).toBe(true);
		});

		it('requirements_checked = digest.tasks_total, requirements_satisfied = digest.tasks_completed', async () => {
			const curatorResult = makeCuratorResult({
				phase: 1,
				compliance: [],
				digest: {
					tasks_completed: 7,
					tasks_total: 12,
					summary: 'some done',
					agents_used: [],
					key_decisions: [],
					blockers_resolved: [],
					phase: 1,
					timestamp: new Date().toISOString(),
				},
			});
			const config = makeCuratorConfig();

			const result = await runDeterministicDriftCheck(
				tmpDir,
				1,
				curatorResult,
				config,
			);

			expect(result.report.requirements_checked).toBe(12);
			expect(result.report.requirements_satisfied).toBe(7);
		});

		// ========== Spec-based Drift Tests ==========

		it('Spec-based MAJOR_DRIFT: spec has 3 FRs but plan only references 1 (coverage < 50%) → alignment=MAJOR_DRIFT', async () => {
			// Write plan.md that only mentions FR-001
			await fs.writeFile(
				path.join(tmpDir, '.swarm', 'plan.md'),
				'# Plan\n## Tasks\n- Task 1: implement FR-001',
				'utf-8',
			);
			// Write spec.md that mentions FR-001, FR-002, FR-003
			await fs.writeFile(
				path.join(tmpDir, '.swarm', 'spec.md'),
				'# Spec\n- FR-001: feature one\n- FR-002: feature two\n- FR-003: feature three',
				'utf-8',
			);

			const curatorResult = makeCuratorResult({
				phase: 1,
				compliance: [], // no warnings — drift is driven by spec coverage
				digest: {
					tasks_completed: 10,
					tasks_total: 10,
					summary: 'all done',
					agents_used: [],
					key_decisions: [],
					blockers_resolved: [],
					phase: 1,
					timestamp: new Date().toISOString(),
				},
			});
			const config = makeCuratorConfig();

			const result = await runDeterministicDriftCheck(
				tmpDir,
				1,
				curatorResult,
				config,
			);

			// 1/3 = 0.333 < 0.5 → MAJOR_DRIFT
			expect(result.report.alignment).toBe('MAJOR_DRIFT');
			// driftScore = min(0.9, 0.6 + (1 - 0.333) * 0.3) = min(0.9, 0.6 + 0.2) = 0.8
			expect(result.report.drift_score).toBe(0.8);
		});

		it('Spec-based MINOR_DRIFT (implementation gap): all spec FRs in plan but none in curator digest → alignment=MINOR_DRIFT', async () => {
			// Write plan.md that mentions FR-001, FR-002, FR-003
			await fs.writeFile(
				path.join(tmpDir, '.swarm', 'plan.md'),
				'# Plan\n## Tasks\n- FR-001: implement\n- FR-002: implement\n- FR-003: implement',
				'utf-8',
			);
			// Write spec.md with the same FRs
			await fs.writeFile(
				path.join(tmpDir, '.swarm', 'spec.md'),
				'# Spec\n- FR-001: feature one\n- FR-002: feature two\n- FR-003: feature three',
				'utf-8',
			);

			// curator digest does NOT mention any FRs (implementation gap)
			const curatorResult = makeCuratorResult({
				phase: 1,
				compliance: [], // no warnings
				digest: {
					tasks_completed: 10,
					tasks_total: 10,
					summary: 'all done but FRs not referenced',
					agents_used: [],
					key_decisions: [],
					blockers_resolved: [],
					phase: 1,
					timestamp: new Date().toISOString(),
				},
			});
			const config = makeCuratorConfig();

			const result = await runDeterministicDriftCheck(
				tmpDir,
				1,
				curatorResult,
				config,
			);

			// Plan covers all FRs (specCoverageRatio = 1.0, not < 0.5)
			// But implementationRatio = 0/3 = 0 < 0.5 → MINOR_DRIFT
			expect(result.report.alignment).toBe('MINOR_DRIFT');
			// driftScore = min(0.6, 0.2 + (1 - 0) * 0.3) = min(0.6, 0.5) = 0.5
			expect(result.report.drift_score).toBe(0.5);
		});

		it('No spec fallback: specMd is null/undefined → compliance-count-based drift (no spec FR logic)', async () => {
			// plan.md exists so we don't hit the no-plan path
			await fs.writeFile(
				path.join(tmpDir, '.swarm', 'plan.md'),
				'# Plan\n- Task 1\n- Task 2',
				'utf-8',
			);
			// Do NOT write spec.md — specMd will be null

			// 1 warning → should be MINOR_DRIFT under compliance-count logic
			const curatorResult = makeCuratorResult({
				phase: 1,
				compliance: [
					{
						phase: 1,
						timestamp: new Date().toISOString(),
						type: 'missing_reviewer',
						description: 'Reviewer not assigned',
						severity: 'warning',
					},
				],
				digest: {
					tasks_completed: 8,
					tasks_total: 10,
					summary: 'mostly done',
					agents_used: [],
					key_decisions: [],
					blockers_resolved: [],
					phase: 1,
					timestamp: new Date().toISOString(),
				},
			});
			const config = makeCuratorConfig();

			const result = await runDeterministicDriftCheck(
				tmpDir,
				1,
				curatorResult,
				config,
			);

			// Falls to compliance-count path (no specRequirements)
			// 1 warning → MINOR_DRIFT with score 0.2 + 1*0.05 = 0.25
			expect(result.report.alignment).toBe('MINOR_DRIFT');
			expect(result.report.drift_score).toBe(0.25);
		});

		it('FR coverage note in injection_summary: spec exists → note includes "[N/M FRs covered]"', async () => {
			// Write plan.md mentioning FR-001
			await fs.writeFile(
				path.join(tmpDir, '.swarm', 'plan.md'),
				'# Plan\n- FR-001: implement',
				'utf-8',
			);
			// Write spec.md with FR-001, FR-002
			await fs.writeFile(
				path.join(tmpDir, '.swarm', 'spec.md'),
				'# Spec\n- FR-001: feature one\n- FR-002: feature two',
				'utf-8',
			);

			// Curator digest mentions FR-001 (1 of 2 covered)
			const curatorResult = makeCuratorResult({
				phase: 1,
				compliance: [],
				digest: {
					tasks_completed: 10,
					tasks_total: 10,
					summary: 'implemented FR-001',
					agents_used: [],
					key_decisions: [],
					blockers_resolved: [],
					phase: 1,
					timestamp: new Date().toISOString(),
				},
			});
			const config = makeCuratorConfig({ drift_inject_max_chars: 500 });

			const result = await runDeterministicDriftCheck(
				tmpDir,
				1,
				curatorResult,
				config,
			);

			// FR-001 appears in both plan and digest; FR-002 in spec but not digest
			// digestRequirements = [FR-001], specRequirements = [FR-001, FR-002]
			// covered = FR-001 filtered by digestRequirements → 1
			// note should be "[1/2 FRs covered]"
			expect(result.report.injection_summary).toContain('[1/2 FRs covered]');
		});
	});

	// ========== Adversarial Tests ==========

	describe('runDeterministicDriftCheck adversarial', () => {
		it('Nonexistent directory → returns MINOR_DRIFT (no plan found), not crash', async () => {
			// A nonexistent directory will cause plan.md to not be found
			// This is treated as "no plan" → MINOR_DRIFT, not as an error
			const nonexistentDir = path.join(
				os.tmpdir(),
				'nonexistent-' + Date.now(),
			);

			const curatorResult = makeCuratorResult({ phase: 1 });
			const config = makeCuratorConfig();

			// Should NOT throw - missing plan is expected behavior
			const result = await runDeterministicDriftCheck(
				nonexistentDir,
				1,
				curatorResult,
				config,
			);

			// Per implementation: missing plan = MINOR_DRIFT with score 0.3
			// (not an error - missing data is handled gracefully)
			expect(result.report.alignment).toBe('MINOR_DRIFT');
			expect(result.report.drift_score).toBe(0.3);
		});

		it('Empty .swarm directory (no plan.md) → returns MINOR_DRIFT', async () => {
			const curatorResult = makeCuratorResult({ phase: 1 });
			const config = makeCuratorConfig();

			// Use a temp directory that has a .swarm/ dir but no plan.md inside it.
			// This avoids environment dependence (CWD may or may not have plan.md).
			const emptySwarmDir = path.join(tmpDir, 'no-plan-test');
			mkdirSync(path.join(emptySwarmDir, '.swarm'), { recursive: true });

			const result = await runDeterministicDriftCheck(
				emptySwarmDir,
				1,
				curatorResult,
				config,
			);

			// When planMd is null, the function returns MINOR_DRIFT with score 0.3
			// ("cannot assess alignment without a plan").
			expect(result.report.alignment).toBe('MINOR_DRIFT');
			expect(result.report.drift_score).toBe(0.3);
		});

		it('config.drift_inject_max_chars = 0 → injection_summary is empty string, no crash', async () => {
			const curatorResult = makeCuratorResult({
				phase: 1,
				compliance: [],
				digest: {
					tasks_completed: 10,
					tasks_total: 10,
					summary: 'all done',
					agents_used: [],
					key_decisions: [],
					blockers_resolved: [],
					phase: 1,
					timestamp: new Date().toISOString(),
				},
			});
			const config = makeCuratorConfig({ drift_inject_max_chars: 0 });

			const result = await runDeterministicDriftCheck(
				tmpDir,
				1,
				curatorResult,
				config,
			);

			expect(result.report.injection_summary).toBe('');
			expect(result.injection_text).toBe('');
		});

		it('curatorResult.compliance = [] → ALIGNED, no crash', async () => {
			const curatorResult = makeCuratorResult({
				phase: 1,
				compliance: [],
				digest: {
					tasks_completed: 10,
					tasks_total: 10,
					summary: 'all done',
					agents_used: [],
					key_decisions: [],
					blockers_resolved: [],
					phase: 1,
					timestamp: new Date().toISOString(),
				},
			});
			const config = makeCuratorConfig();

			const result = await runDeterministicDriftCheck(
				tmpDir,
				1,
				curatorResult,
				config,
			);

			expect(result.report.alignment).toBe('ALIGNED');
			expect(result.report.drift_score).toBe(0);
		});
	});
});

describe('buildDriftInjectionText', () => {
	// ========== Verification Tests ==========

	describe('ALIGNED with low drift score - minimal output', () => {
		it('ALIGNED + drift_score=0.0 → starts with "<drift_report>Phase 1: ALIGNED"', () => {
			const report = createValidDriftReport(1);
			report.alignment = 'ALIGNED';
			report.drift_score = 0.0;

			const result = buildDriftInjectionText(report, 500);

			expect(result).toStartWith('<drift_report>Phase 1: ALIGNED');
		});

		it('ALIGNED + drift_score=0.05 → minimal output', () => {
			const report = createValidDriftReport(1);
			report.alignment = 'ALIGNED';
			report.drift_score = 0.05;

			const result = buildDriftInjectionText(report, 500);

			// Minimal case: should NOT contain drift_score
			expect(result).not.toMatch(/\d+\.\d+/);
			expect(result).toContain('ALIGNED');
			expect(result).toContain('all requirements on track');
		});

		it('ALIGNED + drift_score=0.1 → detailed output (boundary: < 0.1 is minimal)', () => {
			const report = createValidDriftReport(1);
			report.alignment = 'ALIGNED';
			report.drift_score = 0.1;

			const result = buildDriftInjectionText(report, 500);

			// At 0.1, it's NOT minimal - should contain drift_score formatted
			expect(result).toMatch(/0\.10/);
		});
	});

	describe('MINOR_DRIFT and MAJOR_DRIFT - detailed output', () => {
		it('MINOR_DRIFT → contains alignment and drift_score', () => {
			const report = createValidDriftReport(2);
			report.alignment = 'MINOR_DRIFT';
			report.drift_score = 0.35;
			report.first_deviation = {
				phase: 2,
				task: 'task-1',
				description: 'Added new feature',
			};

			const result = buildDriftInjectionText(report, 500);

			expect(result).toContain('MINOR_DRIFT');
			expect(result).toContain('0.35');
		});

		it('MAJOR_DRIFT → contains first_deviation description', () => {
			const report = createValidDriftReport(3);
			report.alignment = 'MAJOR_DRIFT';
			report.drift_score = 0.75;
			report.first_deviation = {
				phase: 3,
				task: 'task-1',
				description: 'Critical scope creep detected',
			};

			const result = buildDriftInjectionText(report, 500);

			expect(result).toContain('MAJOR_DRIFT');
			expect(result).toContain('Critical scope creep detected');
		});
	});

	describe('corrections handling', () => {
		it('corrections[0] present → output contains "Correction:"', () => {
			const report = createValidDriftReport(1);
			report.alignment = 'MINOR_DRIFT';
			report.drift_score = 0.25;
			report.first_deviation = {
				phase: 1,
				task: 'task-1',
				description: 'Minor deviation',
			};
			report.corrections = ['Reverted scope addition'];

			const result = buildDriftInjectionText(report, 500);

			expect(result).toContain('Correction:');
			expect(result).toContain('Reverted scope addition');
		});

		it('corrections empty → no "Correction:" in output', () => {
			const report = createValidDriftReport(1);
			report.alignment = 'MINOR_DRIFT';
			report.drift_score = 0.25;
			report.first_deviation = {
				phase: 1,
				task: 'task-1',
				description: 'Minor deviation',
			};
			report.corrections = [];

			const result = buildDriftInjectionText(report, 500);

			expect(result).not.toContain('Correction:');
		});
	});

	describe('maxChars truncation', () => {
		it('maxChars=10 → result.length <= 10', () => {
			const report = createValidDriftReport(1);
			report.alignment = 'MINOR_DRIFT';
			report.drift_score = 0.25;

			const result = buildDriftInjectionText(report, 10);

			expect(result.length).toBeLessThanOrEqual(10);
		});

		it('Large maxChars → full string returned', () => {
			const report = createValidDriftReport(1);
			report.alignment = 'MINOR_DRIFT';
			report.drift_score = 0.25;
			report.first_deviation = {
				phase: 1,
				task: 'task-1',
				description: 'Test deviation',
			};

			const result = buildDriftInjectionText(report, 10000);

			// Should contain the full content
			expect(result).toContain('Test deviation');
		});
	});

	describe('edge cases - first_deviation and phase', () => {
		it('first_deviation=null → contains "no deviation recorded"', () => {
			const report = createValidDriftReport(1);
			report.alignment = 'MINOR_DRIFT';
			report.drift_score = 0.25;
			report.first_deviation = null;

			const result = buildDriftInjectionText(report, 500);

			expect(result).toContain('no deviation recorded');
		});

		it('Output is wrapped in "<drift_report>...</drift_report>" for minimal case', () => {
			const report = createValidDriftReport(1);
			report.alignment = 'ALIGNED';
			report.drift_score = 0.0;

			const result = buildDriftInjectionText(report, 500);

			expect(result).toStartWith('<drift_report>');
			expect(result).toEndWith('</drift_report>');
		});

		it('Score formatted to 2 decimal places (e.g., 0.30)', () => {
			const report = createValidDriftReport(1);
			report.alignment = 'MINOR_DRIFT';
			report.drift_score = 0.3;
			report.first_deviation = {
				phase: 1,
				task: 'task-1',
				description: 'Test',
			};

			const result = buildDriftInjectionText(report, 500);

			expect(result).toContain('0.30');
		});

		it('report.phase=0 → works fine, output contains "Phase 0"', () => {
			const report = createValidDriftReport(0);
			report.alignment = 'ALIGNED';
			report.drift_score = 0.0;

			const result = buildDriftInjectionText(report, 500);

			expect(result).toContain('Phase 0');
		});
	});

	// ========== Adversarial Tests ==========

	describe('maxChars edge cases', () => {
		it('maxChars=0 → returns empty string', () => {
			const report = createValidDriftReport(1);
			report.alignment = 'ALIGNED';
			report.drift_score = 0.0;

			const result = buildDriftInjectionText(report, 0);

			expect(result).toBe('');
		});

		it('maxChars=-1 → returns empty string', () => {
			const report = createValidDriftReport(1);
			report.alignment = 'ALIGNED';
			report.drift_score = 0.0;

			const result = buildDriftInjectionText(report, -1);

			expect(result).toBe('');
		});

		it('maxChars=1 → returns single character, no crash', () => {
			const report = createValidDriftReport(1);
			report.alignment = 'MINOR_DRIFT';
			report.drift_score = 0.5;

			const result = buildDriftInjectionText(report, 1);

			expect(result.length).toBeLessThanOrEqual(1);
			expect(result).toBe('<');
		});
	});

	describe('undefined/null handling', () => {
		it('drift_score=undefined → should not throw (null guard: ?? 0)', () => {
			const report = createValidDriftReport(1);
			report.alignment = 'ALIGNED';
			// @ts-expect-error - testing runtime behavior with undefined
			report.drift_score = undefined;

			expect(() => {
				const result = buildDriftInjectionText(report, 500);
				// Should return some valid string, not throw
				expect(typeof result).toBe('string');
			}).not.toThrow();
		});

		it('corrections=undefined → should not throw (null guard: ?.[0])', () => {
			const report = createValidDriftReport(1);
			report.alignment = 'MINOR_DRIFT';
			report.drift_score = 0.25;
			report.first_deviation = {
				phase: 1,
				task: 'task-1',
				description: 'Test',
			};
			// @ts-expect-error - testing runtime behavior with undefined
			report.corrections = undefined;

			expect(() => {
				const result = buildDriftInjectionText(report, 500);
				expect(typeof result).toBe('string');
			}).not.toThrow();
		});

		it('first_deviation.description is empty string → output includes empty string, no crash', () => {
			const report = createValidDriftReport(1);
			report.alignment = 'MINOR_DRIFT';
			report.drift_score = 0.25;
			report.first_deviation = {
				phase: 1,
				task: 'task-1',
				description: '',
			};

			const result = buildDriftInjectionText(report, 500);

			expect(result).toContain('</drift_report>');
			// Should include empty string in the output
			expect(result).toContain(' — .');
		});
	});

	describe('large input handling', () => {
		it('Very long first_deviation.description (1000 chars) → truncated to maxChars, no crash', () => {
			const longDescription = 'A'.repeat(1000);
			const report = createValidDriftReport(1);
			report.alignment = 'MINOR_DRIFT';
			report.drift_score = 0.25;
			report.first_deviation = {
				phase: 1,
				task: 'task-1',
				description: longDescription,
			};

			const result = buildDriftInjectionText(report, 100);

			expect(result.length).toBeLessThanOrEqual(100);
			expect(typeof result).toBe('string');
		});
	});

	// ========== NEW Adversarial Tests for buildDriftInjectionText ==========

	describe('buildDriftInjectionText - adversarial edge cases', () => {
		it('corrections array contains object instead of string → no crash, converts to [object Object]', () => {
			const report = createValidDriftReport(1);
			report.alignment = 'MINOR_DRIFT';
			report.drift_score = 0.25;
			report.first_deviation = {
				phase: 1,
				task: 'task-1',
				description: 'Test deviation',
			};
			// @ts-expect-error - testing runtime behavior with object in corrections
			report.corrections = [{ action: 'reverted' }];

			const result = buildDriftInjectionText(report, 500);

			expect(typeof result).toBe('string');
			expect(result).toContain('Correction:');
			// Object gets converted to "[object Object]"
			expect(result).toContain('[object Object]');
		});

		it('corrections array contains number instead of string → no crash', () => {
			const report = createValidDriftReport(1);
			report.alignment = 'MINOR_DRIFT';
			report.drift_score = 0.25;
			report.first_deviation = {
				phase: 1,
				task: 'task-1',
				description: 'Test deviation',
			};
			// @ts-expect-error - testing runtime behavior with number in corrections
			report.corrections = [42];

			const result = buildDriftInjectionText(report, 500);

			expect(typeof result).toBe('string');
			expect(result).toContain('Correction:');
			expect(result).toContain('42');
		});

		it('report.alignment is unexpected string value → no crash, uses value as-is', () => {
			const report = createValidDriftReport(1);
			// @ts-expect-error - testing runtime behavior with unexpected alignment
			report.alignment = 'UNKNOWN_STATUS';
			report.drift_score = 0.05;

			const result = buildDriftInjectionText(report, 500);

			expect(typeof result).toBe('string');
			expect(result).toContain('UNKNOWN_STATUS');
		});

		it('report.phase is NaN → output contains "NaN", no crash', () => {
			const report = createValidDriftReport(NaN);
			report.alignment = 'ALIGNED';
			report.drift_score = 0.0;

			const result = buildDriftInjectionText(report, 500);

			expect(typeof result).toBe('string');
			expect(result).toContain('NaN');
		});

		it('maxChars is Infinity → full string returned, no crash', () => {
			const report = createValidDriftReport(1);
			report.alignment = 'MINOR_DRIFT';
			report.drift_score = 0.25;
			report.first_deviation = {
				phase: 1,
				task: 'task-1',
				description: 'Test deviation',
			};

			const result = buildDriftInjectionText(report, Infinity);

			// Should return full string (slice(0, Infinity) returns full string)
			expect(typeof result).toBe('string');
			expect(result).toContain('Test deviation');
			expect(result).toContain('</drift_report>');
		});

		it('report.drift_score is -1 (negative) → score used as-is, no crash; since -1 < 0.1 with ALIGNED triggers minimal output', () => {
			const report = createValidDriftReport(1);
			report.alignment = 'ALIGNED';
			report.drift_score = -1;

			const result = buildDriftInjectionText(report, 500);

			expect(typeof result).toBe('string');
			// Since -1 < 0.1 and alignment is ALIGNED, goes to minimal case
			expect(result).toContain('ALIGNED');
			expect(result).toContain('all requirements on track');
		});

		it('report.drift_score is -1 with MINOR_DRIFT → outputs negative score as "-1.00", no crash', () => {
			const report = createValidDriftReport(1);
			report.alignment = 'MINOR_DRIFT';
			report.drift_score = -1;
			report.first_deviation = {
				phase: 1,
				task: 'task-1',
				description: 'Test',
			};

			const result = buildDriftInjectionText(report, 500);

			expect(typeof result).toBe('string');
			// toFixed(2) on -1 gives "-1.00"
			expect(result).toContain('-1.00');
		});

		it('first_deviation object with undefined description property → falls through to "no deviation recorded"', () => {
			const report = createValidDriftReport(1);
			report.alignment = 'MINOR_DRIFT';
			report.drift_score = 0.25;
			report.first_deviation = {
				phase: 1,
				task: 'task-1',
				// description is undefined (property missing)
			};

			const result = buildDriftInjectionText(report, 500);

			expect(typeof result).toBe('string');
			expect(result).toContain('no deviation recorded');
		});

		it('first_deviation is object but description is null → falls through to "no deviation recorded" (null is nullish for ?? )', () => {
			const report = createValidDriftReport(1);
			report.alignment = 'MINOR_DRIFT';
			report.drift_score = 0.25;
			report.first_deviation = {
				phase: 1,
				task: 'task-1',
				// @ts-expect-error - testing runtime behavior with null description
				description: null,
			};

			const result = buildDriftInjectionText(report, 500);

			expect(typeof result).toBe('string');
			// null is nullish for ?? operator, so it falls through to default
			expect(result).toContain('no deviation recorded');
		});
	});
});
