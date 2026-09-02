import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { closeGroupCommitWriter } from '../../../src/db/group-commit-writer.js';
import { readPhaseReportsDb } from '../../../src/db/phase-report-store.js';
import { closeProjectDb } from '../../../src/db/project-db.js';
import {
	readPriorDriftReports,
	runDeterministicDriftCheck,
	writeDriftReport,
} from '../../../src/hooks/curator-drift.js';
import type {
	CuratorConfig,
	CuratorPhaseResult,
} from '../../../src/hooks/curator-types.js';

/**
 * Minimal CuratorConfig for testing — covers fields actually read by runDeterministicDriftCheck.
 */
function makeCuratorConfig(overrides?: Partial<CuratorConfig>): CuratorConfig {
	return {
		enabled: true,
		init_enabled: true,
		phase_enabled: true,
		max_summary_tokens: 2000,
		min_knowledge_confidence: 0.7,
		compliance_report: true,
		suppress_warnings: true,
		drift_inject_max_chars: 500,
		...overrides,
	};
}

/**
 * Minimal CuratorPhaseResult stub — only fields actually read by runDeterministicDriftCheck.
 */
function makeCuratorResult(phase: number): CuratorPhaseResult {
	return {
		phase,
		digest: {
			phase,
			timestamp: new Date().toISOString(),
			summary: 'Test phase digest',
			agents_used: [],
			tasks_completed: 0,
			tasks_total: 0,
			key_decisions: [],
			blockers_resolved: [],
		},
		compliance: [],
		knowledge_recommendations: [],
		summary_updated: false,
	};
}

describe('runDeterministicDriftCheck — gate invariants', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'curator-drift-gate-test-')),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);

		// Create .swarm directory
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });

		// Write a minimal plan.md so the function has a plan to read
		fs.writeFileSync(
			path.join(tempDir, 'plan.md'),
			'# Test Plan\n\n## Phase 1\n\n- [ ] Task 1.1\n',
		);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	test('runDeterministicDriftCheck does NOT create drift-verifier.json at the flat .swarm path', async () => {
		const curatorResult = makeCuratorResult(1);
		const config = makeCuratorConfig();

		await runDeterministicDriftCheck(tempDir, 1, curatorResult, config);

		const flatGatePath = path.join(tempDir, '.swarm', 'drift-verifier.json');
		expect(fs.existsSync(flatGatePath)).toBe(false);
	});

	test('advisory drift report is written under .swarm/', async () => {
		const curatorResult = makeCuratorResult(1);
		const config = makeCuratorConfig();

		const result = await runDeterministicDriftCheck(
			tempDir,
			1,
			curatorResult,
			config,
		);

		// The function must return a valid report path
		expect(result.report_path).toBeTruthy();
		expect(result.report_path.length).toBeGreaterThan(0);

		// #2480: the report persists in swarm.db behind the locator.
		expect(result.report_path).toBe('swarm.db:phase_report(curator_drift,1)');
		const persisted = readPhaseReportsDb(tempDir, 'curator_drift');
		expect(persisted.length).toBe(1);

		// It must be valid JSON with a DriftReport shape
		const content = persisted[0].payload;
		expect(() => JSON.parse(content)).not.toThrow();

		const report = JSON.parse(content);
		expect(report).toHaveProperty('schema_version');
		expect(report).toHaveProperty('phase');
		expect(report.phase).toBe(1);
		expect(report).toHaveProperty('alignment');
		expect(report).toHaveProperty('drift_score');
		expect(report).toHaveProperty('timestamp');
	});

	test('injectAdvisory callback receives messages when drift is detected', async () => {
		// With no plan.md: alignment=MINOR_DRIFT, driftScore=0.3 → callback fires
		fs.rmSync(path.join(tempDir, 'plan.md'), { force: true });
		fs.writeFileSync(path.join(tempDir, 'plan.md'), '# Test Plan\n');

		const curatorResult: CuratorPhaseResult = {
			...makeCuratorResult(1),
			compliance: [{ severity: 'warning', description: 'Test warning' }],
		};
		const config = makeCuratorConfig();
		const receivedMessages: string[] = [];

		await runDeterministicDriftCheck(
			tempDir,
			1,
			curatorResult,
			config,
			(msg) => {
				receivedMessages.push(msg);
			},
		);

		expect(receivedMessages.length).toBeGreaterThan(0);
		expect(typeof receivedMessages[0]).toBe('string');
		expect(receivedMessages[0].length).toBeGreaterThan(0);
	});

	test('readPriorDriftReports returns empty array when no prior reports exist', async () => {
		const reports = await readPriorDriftReports(tempDir);
		expect(Array.isArray(reports)).toBe(true);
		expect(reports.length).toBe(0);
	});

	test('writeDriftReport writes a correctly named file under .swarm/', async () => {
		const report = {
			schema_version: 1 as const,
			phase: 99,
			timestamp: new Date().toISOString(),
			alignment: 'ALIGNED' as const,
			drift_score: 0,
			first_deviation: null,
			compounding_effects: [],
			corrections: [],
			requirements_checked: 0,
			requirements_satisfied: 0,
			scope_additions: [],
			injection_summary: 'Phase 99: ALIGNED',
		};

		const locator = await writeDriftReport(tempDir, report);

		expect(locator).toBe('swarm.db:phase_report(curator_drift,99)');
		const rows = readPhaseReportsDb(tempDir, 'curator_drift');
		expect(rows.length).toBe(1);

		const content = JSON.parse(rows[0].payload);
		expect(content.phase).toBe(99);
		expect(content.alignment).toBe('ALIGNED');
	});
});
