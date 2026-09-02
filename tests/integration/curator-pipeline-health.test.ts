import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { closeGroupCommitWriter } from '../../src/db/group-commit-writer.js';
import { _resetPhaseReportImportGuards } from '../../src/db/phase-report-store.js';
import { closeProjectDb } from '../../src/db/project-db.js';
import {
	applyCuratorKnowledgeUpdates,
	runCuratorPhase,
} from '../../src/hooks/curator';
import { readPriorDriftReports } from '../../src/hooks/curator-drift';
import type {
	CuratorPhaseResult,
	KnowledgeRecommendation,
} from '../../src/hooks/curator-types';
import { resetSwarmState, swarmState } from '../../src/state';

describe('curator pipeline health — integration', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = fs.mkdtempSync(
			path.join(os.tmpdir(), 'curator-pipeline-health-'),
		);
		// Create required .swarm directory
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		// #2480: the drift-report reader opens swarm.db — release before cleanup.
		try {
			closeGroupCommitWriter(tempDir);
			closeProjectDb(tempDir);
		} catch {
			// already closed
		}
		_resetPhaseReportImportGuards();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	/**
	 * Write a minimal plan.md with task descriptions for curator to analyze
	 */
	function writePlanMd(content: string): void {
		fs.writeFileSync(path.join(tempDir, 'plan.md'), content, 'utf-8');
	}

	/**
	 * Write events.jsonl with task.completed events
	 */
	function writeEventsJsonl(events: Array<Record<string, unknown>>): void {
		const eventsPath = path.join(tempDir, '.swarm', 'events.jsonl');
		const lines = events.map((e) => JSON.stringify(e)).join('\n');
		fs.writeFileSync(eventsPath, lines, 'utf-8');
	}

	/**
	 * Write opencode-swarm.json config file
	 */
	function writeSwarmConfig(config: Record<string, unknown>): void {
		fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify(config, null, 2),
		);
	}

	/**
	 * Write a drift report file to .swarm directory
	 */
	function writeDriftReport(phase: number, driftScore: number): void {
		const reportPath = path.join(
			tempDir,
			'.swarm',
			`drift-report-phase-${phase}.json`,
		);
		fs.writeFileSync(
			reportPath,
			JSON.stringify(
				{
					schema_version: 1,
					phase,
					alignment: driftScore > 0 ? 'drift_detected' : 'aligned',
					drift_score: driftScore,
					timestamp: new Date().toISOString(),
					spec_deviations: [],
					compounding_effects: [],
					evidence_files_checked: 3,
					evidence_files_passed: driftScore > 0 ? 1 : 3,
				},
				null,
				2,
			),
		);
	}

	describe('runCuratorPhase', () => {
		test('produces a valid CuratorPhaseResult with required fields', async () => {
			// Setup: plan.md with task descriptions
			writePlanMd(`# Project Plan

## Phase 1

### Tasks
- task-1.1: Implement feature X
- task-1.2: Add tests for feature X

## Decisions
- Using TypeScript for type safety
- Following existing code patterns

## Phase 2

### Tasks
- task-2.1: Review implementation
`);

			// Setup: events.jsonl with task.completed events
			writeEventsJsonl([
				{
					type: 'task.completed',
					task_id: 'task-1.1',
					phase: 1,
					timestamp: '2026-01-01T10:00:00.000Z',
				},
				{
					type: 'task.completed',
					task_id: 'task-1.2',
					phase: 1,
					timestamp: '2026-01-01T10:05:00.000Z',
				},
				{
					type: 'task.completed',
					task_id: 'task-2.1',
					phase: 2,
					timestamp: '2026-01-01T11:00:00.000Z',
				},
			]);

			// Execute
			const result = await runCuratorPhase(
				tempDir,
				1,
				['reviewer', 'test_engineer'],
				{
					enabled: true,
					init_enabled: true,
					phase_enabled: true,
					max_summary_tokens: 2000,
					min_knowledge_confidence: 0.7,
					compliance_report: true,
					suppress_warnings: true,
					drift_inject_max_chars: 500,
				},
				{},
			);

			// Assert: result is not null/undefined
			expect(result).not.toBeNull();
			expect(result).not.toBeUndefined();

			// Assert: has required fields per CuratorPhaseResult interface
			expect(typeof result.phase).toBe('number');
			expect(result.phase).toBe(1);

			expect(result.digest).toBeDefined();
			expect(typeof result.digest.summary).toBe('string');
			expect(result.digest.summary.length).toBeGreaterThan(0);
			expect(typeof result.digest.timestamp).toBe('string');
			expect(Array.isArray(result.digest.agents_used)).toBe(true);
			expect(typeof result.digest.tasks_completed).toBe('number');
			expect(typeof result.digest.tasks_total).toBe('number');
			expect(Array.isArray(result.digest.key_decisions)).toBe(true);
			expect(Array.isArray(result.digest.blockers_resolved)).toBe(true);

			expect(Array.isArray(result.compliance)).toBe(true);
			expect(Array.isArray(result.knowledge_recommendations)).toBe(true);
			expect(typeof result.summary_updated).toBe('boolean');
		});

		test('runCuratorPhase produces empty knowledge_recommendations when no knowledge entries exist', async () => {
			writePlanMd('# Plan\n\n## Phase 1\n\nNo tasks yet.\n');
			writeEventsJsonl([]);

			const result = await runCuratorPhase(
				tempDir,
				1,
				[],
				{
					enabled: true,
					init_enabled: true,
					phase_enabled: true,
					max_summary_tokens: 2000,
					min_knowledge_confidence: 0.7,
					compliance_report: true,
					suppress_warnings: true,
					drift_inject_max_chars: 500,
				},
				{},
			);

			expect(result.knowledge_recommendations).toEqual([]);
		});
	});

	describe('applyCuratorKnowledgeUpdates', () => {
		test('can be called with runCuratorPhase result recommendations without error', async () => {
			writePlanMd('# Plan\n\n## Phase 1\n\n- task-1.1: Implement something\n');
			writeEventsJsonl([
				{
					type: 'task.completed',
					task_id: 'task-1.1',
					phase: 1,
					timestamp: '2026-01-01T10:00:00.000Z',
				},
			]);

			const curatorResult = await runCuratorPhase(
				tempDir,
				1,
				['reviewer'],
				{
					enabled: true,
					init_enabled: true,
					phase_enabled: true,
					max_summary_tokens: 2000,
					min_knowledge_confidence: 0.7,
					compliance_report: true,
					suppress_warnings: true,
					drift_inject_max_chars: 500,
				},
				{},
			);

			// Should not throw when called with empty recommendations
			const updateResult = await applyCuratorKnowledgeUpdates(
				tempDir,
				curatorResult.knowledge_recommendations,
				{
					enabled: true,
					swarm_max_entries: 100,
					hive_max_entries: 200,
					auto_promote_days: 90,
					max_inject_count: 5,
					dedup_threshold: 0.6,
					scope_filter: ['global'],
					hive_enabled: true,
					rejected_max_entries: 20,
					validation_enabled: true,
					evergreen_confidence: 0.9,
					evergreen_utility: 0.8,
					low_utility_threshold: 0.3,
					min_retrievals_for_utility: 3,
					schema_version: 1,
					same_project_weight: 1.0,
					cross_project_weight: 0.5,
					min_encounter_score: 0.1,
					initial_encounter_score: 1.0,
					encounter_increment: 0.1,
					max_encounter_score: 10.0,
				},
			);

			expect(updateResult).toBeDefined();
			expect(typeof updateResult.applied).toBe('number');
			expect(typeof updateResult.skipped).toBe('number');
		});

		test('returns zero applied/skipped when recommendations array is empty', async () => {
			const result = await applyCuratorKnowledgeUpdates(tempDir, [], {
				enabled: true,
				swarm_max_entries: 100,
				hive_max_entries: 200,
				auto_promote_days: 90,
				max_inject_count: 5,
				dedup_threshold: 0.6,
				scope_filter: ['global'],
				hive_enabled: true,
				rejected_max_entries: 20,
				validation_enabled: true,
				evergreen_confidence: 0.9,
				evergreen_utility: 0.8,
				low_utility_threshold: 0.3,
				min_retrievals_for_utility: 3,
				schema_version: 1,
				same_project_weight: 1.0,
				cross_project_weight: 0.5,
				min_encounter_score: 0.1,
				initial_encounter_score: 1.0,
				encounter_increment: 0.1,
				max_encounter_score: 10.0,
			});

			expect(result.applied).toBe(0);
			expect(result.skipped).toBe(0);
		});
	});

	describe('readPriorDriftReports', () => {
		test('can read drift report files written by the pipeline', async () => {
			// Write a drift report for phase 1
			writeDriftReport(1, 0.15);

			const reports = await readPriorDriftReports(tempDir);

			expect(reports).toHaveLength(1);
			expect(reports[0].phase).toBe(1);
			expect(reports[0].drift_score).toBe(0.15);
			expect(typeof reports[0].alignment).toBe('string');
		});

		test('returns empty array when no drift reports exist', async () => {
			const reports = await readPriorDriftReports(tempDir);
			expect(reports).toHaveLength(0);
		});

		test('returns empty array when .swarm directory does not exist', async () => {
			const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-swarm-dir-'));
			try {
				const reports = await readPriorDriftReports(emptyDir);
				expect(reports).toHaveLength(0);
			} finally {
				// #2480: the read may open (and create) a fresh swarm.db —
				// release the handle before the temp cleanup or Windows EBUSY.
				try {
					closeGroupCommitWriter(emptyDir);
					closeProjectDb(emptyDir);
				} catch {
					// already closed
				}
				fs.rmSync(emptyDir, { recursive: true, force: true });
			}
		});

		test('can read multiple drift reports sorted by phase', async () => {
			writeDriftReport(1, 0.1);
			writeDriftReport(2, 0.25);
			writeDriftReport(3, 0.0);

			const reports = await readPriorDriftReports(tempDir);

			expect(reports).toHaveLength(3);
			expect(reports[0].phase).toBe(1);
			expect(reports[1].phase).toBe(2);
			expect(reports[2].phase).toBe(3);
		});
	});

	describe('curator config enabled/phase_enabled gate', () => {
		test('runCuratorPhase still returns valid result when enabled=false (graceful skip)', async () => {
			writePlanMd('# Plan\n\n## Phase 1\n\n- task-1.1: Do something\n');
			writeEventsJsonl([
				{
					type: 'task.completed',
					task_id: 'task-1.1',
					phase: 1,
					timestamp: '2026-01-01T10:00:00.000Z',
				},
			]);

			// Note: runCuratorPhase itself doesn't check the enabled flag -
			// that's done by the caller (phase-complete). But we verify the
			// function itself returns valid result even when config suggests
			// curator is disabled.
			const result = await runCuratorPhase(
				tempDir,
				1,
				[],
				{
					enabled: false,
					init_enabled: false,
					phase_enabled: false,
					max_summary_tokens: 2000,
					min_knowledge_confidence: 0.7,
					compliance_report: true,
					suppress_warnings: true,
					drift_inject_max_chars: 500,
				},
				{},
			);

			// Should still return a valid result - the skip happens at caller level
			expect(result).toBeDefined();
			expect(typeof result.phase).toBe('number');
			expect(result.digest).toBeDefined();
		});
	});

	describe('full curator pipeline round-trip', () => {
		test('runCuratorPhase + applyCuratorKnowledgeUpdates produces consistent state', async () => {
			writePlanMd(`# Plan

## Phase 1

### Tasks
- task-1.1: Implement login feature
- task-1.2: Add unit tests

## Decisions
- Using JWT for authentication
- Storing sessions in memory
`);
			writeEventsJsonl([
				{
					type: 'task.completed',
					task_id: 'task-1.1',
					phase: 1,
					timestamp: '2026-01-01T10:00:00.000Z',
				},
				{
					type: 'task.completed',
					task_id: 'task-1.2',
					phase: 1,
					timestamp: '2026-01-01T10:10:00.000Z',
				},
			]);

			// Step 1: Run curator phase
			const phaseResult = await runCuratorPhase(
				tempDir,
				1,
				['reviewer', 'test_engineer'],
				{
					enabled: true,
					init_enabled: true,
					phase_enabled: true,
					max_summary_tokens: 2000,
					min_knowledge_confidence: 0.7,
					compliance_report: true,
					suppress_warnings: true,
					drift_inject_max_chars: 500,
				},
				{},
			);

			// Step 2: Apply knowledge updates
			const updateResult = await applyCuratorKnowledgeUpdates(
				tempDir,
				phaseResult.knowledge_recommendations,
				{
					enabled: true,
					swarm_max_entries: 100,
					hive_max_entries: 200,
					auto_promote_days: 90,
					max_inject_count: 5,
					dedup_threshold: 0.6,
					scope_filter: ['global'],
					hive_enabled: true,
					rejected_max_entries: 20,
					validation_enabled: true,
					evergreen_confidence: 0.9,
					evergreen_utility: 0.8,
					low_utility_threshold: 0.3,
					min_retrievals_for_utility: 3,
					schema_version: 1,
					same_project_weight: 1.0,
					cross_project_weight: 0.5,
					min_encounter_score: 0.1,
					initial_encounter_score: 1.0,
					encounter_increment: 0.1,
					max_encounter_score: 10.0,
				},
			);

			// Verify the pipeline produced consistent output
			expect(phaseResult.phase).toBe(1);
			expect(typeof phaseResult.digest.tasks_completed).toBe('number');
			expect(typeof updateResult.applied).toBe('number');
			expect(typeof updateResult.skipped).toBe('number');
			// applied + skipped should be a non-negative integer
			expect(
				Number.isInteger(updateResult.applied + updateResult.skipped),
			).toBe(true);

			// Step 3: Write and read a drift report
			writeDriftReport(1, 0.05);
			const driftReports = await readPriorDriftReports(tempDir);
			expect(driftReports).toHaveLength(1);
			expect(driftReports[0].phase).toBe(1);
		});
	});
});
