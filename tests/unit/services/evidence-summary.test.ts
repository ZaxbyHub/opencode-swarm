import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Evidence } from '../../../src/config/evidence-schema';
import type { Phase, Plan, Task } from '../../../src/config/plan-schema';
import type { LoadEvidenceResult } from '../../../src/evidence/manager';
import {
	buildEvidenceSummary,
	type EvidenceSummaryArtifact,
	isAutoSummaryEnabled,
	type PhaseBlocker,
	type TaskEvidenceSummary,
} from '../../../src/services/evidence-summary-service';

// Helper to wrap a bundle into a LoadEvidenceResult
function foundResult(bundle: {
	schema_version: string;
	task_id: string;
	entries: any[];
	created_at: string;
	updated_at: string;
}): LoadEvidenceResult {
	return { status: 'found', bundle: bundle as any };
}

const NOT_FOUND: LoadEvidenceResult = { status: 'not_found' };

// Mock the plan manager
mock.module('../../../src/plan/manager', () => ({
	loadPlanJsonOnly: mock(),
}));

// Mock the evidence manager
mock.module('../../../src/evidence/manager', () => ({
	loadEvidence: mock(),
	listEvidenceTaskIds: mock(),
}));

import {
	listEvidenceTaskIds,
	loadEvidence,
} from '../../../src/evidence/manager';
import { loadPlanJsonOnly } from '../../../src/plan/manager';

const mockLoadPlanJsonOnly = loadPlanJsonOnly as ReturnType<typeof mock>;
const mockLoadEvidence = loadEvidence as ReturnType<typeof mock>;
const mockListEvidenceTaskIds = listEvidenceTaskIds as ReturnType<typeof mock>;

let tempDir: string;

beforeEach(() => {
	tempDir = join(
		tmpdir(),
		`evidence-summary-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(join(tempDir, '.swarm'), { recursive: true });

	// Reset mocks
	mock.restore();
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

function createMockPlan(overrides: Partial<Plan> = {}): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Test Plan',
		swarm: 'test-swarm',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'completed',
						size: 'small',
						description: 'Task 1.1',
						depends: [],
						files_touched: [],
					},
					{
						id: '1.2',
						phase: 1,
						status: 'in_progress',
						size: 'medium',
						description: 'Task 1.2',
						depends: [],
						files_touched: [],
					},
					{
						id: '1.3',
						phase: 1,
						status: 'pending',
						size: 'large',
						description: 'Task 1.3',
						depends: [],
						files_touched: [],
						blocked_reason: 'Waiting on external dependency',
					},
				],
			},
			{
				id: 2,
				name: 'Phase 2',
				status: 'pending',
				tasks: [
					{
						id: '2.1',
						phase: 2,
						status: 'pending',
						size: 'small',
						description: 'Task 2.1',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
		...overrides,
	};
}

function createMockEvidence(
	taskId: string,
	types: string[],
): Array<{ task_id: string; type: string; timestamp: string }> {
	return types.map((type) => ({
		task_id: taskId,
		type,
		timestamp: new Date().toISOString(),
		agent: 'test-agent',
		verdict: 'pass' as const,
		summary: `Test ${type} evidence`,
	}));
}

function writeDurableGateEvidence(
	taskId: string,
	requiredGates = ['reviewer', 'test_engineer'],
	gates: Record<
		string,
		{ sessionId: string; timestamp: string; agent: string }
	> = {
		reviewer: {
			sessionId: 'review-session',
			timestamp: '2026-01-01T00:00:00.000Z',
			agent: 'reviewer',
		},
		test_engineer: {
			sessionId: 'test-session',
			timestamp: '2026-01-01T00:01:00.000Z',
			agent: 'test_engineer',
		},
	},
): void {
	const evidenceDir = join(tempDir, '.swarm', 'evidence');
	mkdirSync(evidenceDir, { recursive: true });
	writeFileSync(
		join(evidenceDir, `${taskId}.json`),
		JSON.stringify({
			taskId,
			required_gates: requiredGates,
			gates,
		}),
	);
}

describe('isAutoSummaryEnabled', () => {
	it('returns false when config is undefined', () => {
		expect(isAutoSummaryEnabled(undefined)).toBe(false);
	});

	it('returns false when mode is manual', () => {
		expect(
			isAutoSummaryEnabled({
				mode: 'manual',
				capabilities: { evidence_auto_summaries: true },
			}),
		).toBe(false);
	});

	it('returns false when evidence_auto_summaries is false', () => {
		expect(
			isAutoSummaryEnabled({
				mode: 'hybrid',
				capabilities: { evidence_auto_summaries: false },
			}),
		).toBe(false);
	});

	it('returns true when mode is hybrid and evidence_auto_summaries is true', () => {
		expect(
			isAutoSummaryEnabled({
				mode: 'hybrid',
				capabilities: { evidence_auto_summaries: true },
			}),
		).toBe(true);
	});

	it('returns true when mode is auto and evidence_auto_summaries is true', () => {
		expect(
			isAutoSummaryEnabled({
				mode: 'auto',
				capabilities: { evidence_auto_summaries: true },
			}),
		).toBe(true);
	});

	it('returns false when capabilities is missing', () => {
		expect(
			isAutoSummaryEnabled({
				mode: 'hybrid',
			}),
		).toBe(false);
	});
});

describe('buildEvidenceSummary', () => {
	it('returns null when no plan exists', async () => {
		mockLoadPlanJsonOnly.mockResolvedValue(null);

		const result = await buildEvidenceSummary(tempDir);

		expect(result).toBeNull();
		expect(mockLoadPlanJsonOnly).toHaveBeenCalledWith(tempDir);
	});

	it('builds summary for plan with no evidence', async () => {
		const plan = createMockPlan();
		mockLoadPlanJsonOnly.mockResolvedValue(plan);
		mockListEvidenceTaskIds.mockResolvedValue([]);
		mockLoadEvidence.mockResolvedValue(NOT_FOUND);

		const result = await buildEvidenceSummary(tempDir, 1);

		expect(result).not.toBeNull();
		expect(result!.planTitle).toBe('Test Plan');
		expect(result!.currentPhase).toBe(1);
		expect(result!.phaseSummaries).toHaveLength(1); // Only phase 1 due to currentPhase=1

		// Phase 1 summary
		const phase1 = result!.phaseSummaries[0];
		expect(phase1.phaseId).toBe(1);
		expect(phase1.totalTasks).toBe(3);
		expect(phase1.completedTasks).toBe(1); // Only task 1.1 is completed
		expect(phase1.completionRatio).toBeCloseTo(1 / 3, 2);
	});

	it('detects missing evidence correctly', async () => {
		const plan = createMockPlan();
		mockLoadPlanJsonOnly.mockResolvedValue(plan);
		mockListEvidenceTaskIds.mockResolvedValue(['1.1', '1.2']);

		// Task 1.1 has both review and test
		mockLoadEvidence
			.mockResolvedValueOnce(
				foundResult({
					schema_version: '1.0.0',
					task_id: '1.1',
					entries: createMockEvidence('1.1', ['review', 'test']),
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
				}),
			)
			// Task 1.2 only has review
			.mockResolvedValueOnce(
				foundResult({
					schema_version: '1.0.0',
					task_id: '1.2',
					entries: createMockEvidence('1.2', ['review']),
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
				}),
			);

		const result = await buildEvidenceSummary(tempDir, 1);

		expect(result).not.toBeNull();

		// Task 1.1 should be complete
		const task11 = result!.phaseSummaries[0].tasks.find(
			(t) => t.taskId === '1.1',
		);
		expect(task11?.isComplete).toBe(true);
		expect(task11?.missingEvidence).toHaveLength(0);

		// Task 1.2 should be missing test evidence
		const task12 = result!.phaseSummaries[0].tasks.find(
			(t) => t.taskId === '1.2',
		);
		expect(task12?.isComplete).toBe(false);
		expect(task12?.missingEvidence).toContain('test');
	});

	it('counts durable gate evidence when no evidence bundle exists', async () => {
		const plan = createMockPlan();
		mockLoadPlanJsonOnly.mockResolvedValue(plan);
		mockListEvidenceTaskIds.mockResolvedValue([]);
		mockLoadEvidence.mockResolvedValue(NOT_FOUND);
		writeDurableGateEvidence('1.1');

		const result = await buildEvidenceSummary(tempDir, 1);

		expect(result).not.toBeNull();
		const task11 = result!.phaseSummaries[0].tasks.find(
			(t) => t.taskId === '1.1',
		);

		expect(task11?.evidenceCount).toBe(2);
		expect(task11?.hasReview).toBe(true);
		expect(task11?.hasTest).toBe(true);
		expect(task11?.isComplete).toBe(true);
		expect(task11?.missingEvidence).toHaveLength(0);
		expect(task11?.blockers).toHaveLength(0);
		expect(
			result!.phaseSummaries[0].missingEvidenceByType.review,
		).not.toContain('1.1');
		expect(result!.phaseSummaries[0].missingEvidenceByType.test).not.toContain(
			'1.1',
		);
	});

	it('does not mark durable gate evidence complete when required gates are missing', async () => {
		const plan = createMockPlan();
		mockLoadPlanJsonOnly.mockResolvedValue(plan);
		mockListEvidenceTaskIds.mockResolvedValue([]);
		mockLoadEvidence.mockResolvedValue(NOT_FOUND);
		writeDurableGateEvidence('1.1', ['critic', 'reviewer', 'test_engineer']);

		const result = await buildEvidenceSummary(tempDir, 1);

		expect(result).not.toBeNull();
		const task11 = result!.phaseSummaries[0].tasks.find(
			(t) => t.taskId === '1.1',
		);

		expect(task11?.hasReview).toBe(true);
		expect(task11?.hasTest).toBe(true);
		expect(task11?.isComplete).toBe(false);
		expect(task11?.missingEvidence).toContain('gate:critic');
		expect(task11?.blockers).toContain('Missing evidence: gate:critic');
	});

	it('detects blockers correctly', async () => {
		const plan = createMockPlan();
		mockLoadPlanJsonOnly.mockResolvedValue(plan);
		// Return all task IDs that have evidence
		mockListEvidenceTaskIds.mockResolvedValue(['1.1', '1.2', '1.3']);

		// Task 1.1 has both evidence types (complete)
		mockLoadEvidence
			.mockResolvedValueOnce(
				foundResult({
					schema_version: '1.0.0',
					task_id: '1.1',
					entries: [
						{
							task_id: '1.1',
							type: 'review',
							timestamp: new Date().toISOString(),
							agent: 'test',
							verdict: 'pass',
							summary: 'test',
						},
						{
							task_id: '1.1',
							type: 'test',
							timestamp: new Date().toISOString(),
							agent: 'test',
							verdict: 'pass',
							summary: 'test',
						},
					],
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
				}),
			)
			// Task 1.2 has both evidence types (complete)
			.mockResolvedValueOnce(
				foundResult({
					schema_version: '1.0.0',
					task_id: '1.2',
					entries: [
						{
							task_id: '1.2',
							type: 'review',
							timestamp: new Date().toISOString(),
							agent: 'test',
							verdict: 'pass',
							summary: 'test',
						},
						{
							task_id: '1.2',
							type: 'test',
							timestamp: new Date().toISOString(),
							agent: 'test',
							verdict: 'pass',
							summary: 'test',
						},
					],
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
				}),
			)
			// Task 1.3 has no evidence but has blocked_reason
			.mockResolvedValueOnce(NOT_FOUND);

		const result = await buildEvidenceSummary(tempDir, 1);

		expect(result).not.toBeNull();

		// Task 1.3 is blocked
		const task13 = result!.phaseSummaries[0].tasks.find(
			(t) => t.taskId === '1.3',
		);
		expect(task13?.taskStatus).toBe('pending');
		expect(task13?.blockers).toContain('Waiting on external dependency');

		// Phase should have blocker for task 1.3
		const phase1 = result!.phaseSummaries[0];
		const blockedBlocker = phase1.blockers.find(
			(b) => b.type === 'blocked_task' && b.taskId === '1.3',
		);
		expect(blockedBlocker).toBeDefined();
		expect(blockedBlocker?.reason).toContain('Waiting on external dependency');
	});

	it('calculates overall completion ratio correctly', async () => {
		const plan = createMockPlan({
			current_phase: 2,
		});
		mockLoadPlanJsonOnly.mockResolvedValue(plan);
		mockListEvidenceTaskIds.mockResolvedValue([]);

		// Set up tasks with various statuses for both phases
		const mockTasks: Task[] = [
			{
				id: '1.1',
				phase: 1,
				status: 'completed',
				size: 'small',
				description: 't1',
				depends: [],
				files_touched: [],
			},
			{
				id: '1.2',
				phase: 1,
				status: 'completed',
				size: 'small',
				description: 't2',
				depends: [],
				files_touched: [],
			},
			{
				id: '1.3',
				phase: 1,
				status: 'pending',
				size: 'small',
				description: 't3',
				depends: [],
				files_touched: [],
			},
			{
				id: '2.1',
				phase: 2,
				status: 'pending',
				size: 'small',
				description: 't4',
				depends: [],
				files_touched: [],
			},
		];

		// Update plan with correct tasks
		plan.phases[0].tasks = mockTasks.filter((t) => t.phase === 1);
		plan.phases[1].tasks = mockTasks.filter((t) => t.phase === 2);

		mockLoadEvidence.mockResolvedValue(NOT_FOUND);

		const result = await buildEvidenceSummary(tempDir);

		expect(result).not.toBeNull();
		// 2 completed out of 4 total = 50%
		expect(result!.overallCompletionRatio).toBeCloseTo(0.5, 2);
	});

	it('includes human-readable summary text', async () => {
		const plan = createMockPlan();
		mockLoadPlanJsonOnly.mockResolvedValue(plan);
		mockListEvidenceTaskIds.mockResolvedValue([]);
		mockLoadEvidence.mockResolvedValue(NOT_FOUND);

		const result = await buildEvidenceSummary(tempDir, 1);

		expect(result).not.toBeNull();
		expect(result!.summaryText).toContain('Evidence Summary');
		expect(result!.summaryText).toContain('Test Plan');
		expect(result!.summaryText).toContain('Phase 1');
	});
});

describe('TaskEvidenceSummary', () => {
	it('correctly identifies task with all required evidence', async () => {
		const plan = createMockPlan();
		mockLoadPlanJsonOnly.mockResolvedValue(plan);
		mockListEvidenceTaskIds.mockResolvedValue(['1.1']);
		mockLoadEvidence.mockResolvedValue(
			foundResult({
				schema_version: '1.0.0',
				task_id: '1.1',
				entries: createMockEvidence('1.1', ['review', 'test', 'approval']),
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			}),
		);

		const result = await buildEvidenceSummary(tempDir, 1);

		expect(result).not.toBeNull();
		const task = result!.phaseSummaries[0].tasks.find(
			(t) => t.taskId === '1.1',
		);

		expect(task?.hasReview).toBe(true);
		expect(task?.hasTest).toBe(true);
		expect(task?.hasApproval).toBe(true);
		expect(task?.evidenceCount).toBe(3);
		expect(task?.isComplete).toBe(true);
		expect(task?.missingEvidence).toHaveLength(0);
	});

	it('correctly identifies task missing required evidence', async () => {
		const plan = createMockPlan();
		mockLoadPlanJsonOnly.mockResolvedValue(plan);
		mockListEvidenceTaskIds.mockResolvedValue(['1.2']);
		mockLoadEvidence.mockResolvedValue(
			foundResult({
				schema_version: '1.0.0',
				task_id: '1.2',
				entries: createMockEvidence('1.2', ['note', 'diff']),
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			}),
		);

		const result = await buildEvidenceSummary(tempDir, 1);

		expect(result).not.toBeNull();
		const task = result!.phaseSummaries[0].tasks.find(
			(t) => t.taskId === '1.2',
		);

		expect(task?.hasReview).toBe(false);
		expect(task?.hasTest).toBe(false);
		expect(task?.evidenceCount).toBe(2);
		expect(task?.isComplete).toBe(false);
		expect(task?.missingEvidence).toContain('review');
		expect(task?.missingEvidence).toContain('test');
	});
});

describe('Blocker detection', () => {
	it('detects missing evidence blockers at phase level', async () => {
		const plan = createMockPlan();
		mockLoadPlanJsonOnly.mockResolvedValue(plan);
		mockListEvidenceTaskIds.mockResolvedValue(['1.1', '1.2']);

		// Both tasks missing test evidence
		mockLoadEvidence
			.mockResolvedValueOnce(
				foundResult({
					schema_version: '1.0.0',
					task_id: '1.1',
					entries: createMockEvidence('1.1', ['review']),
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
				}),
			)
			.mockResolvedValueOnce(
				foundResult({
					schema_version: '1.0.0',
					task_id: '1.2',
					entries: createMockEvidence('1.2', ['review']),
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
				}),
			);

		const result = await buildEvidenceSummary(tempDir, 1);

		expect(result).not.toBeNull();

		// Should have missing evidence blocker for test
		const testBlocker = result!.phaseSummaries[0].blockers.find(
			(b) => b.type === 'missing_evidence' && b.reason.includes('test'),
		);
		expect(testBlocker).toBeDefined();
		expect(testBlocker?.severity).toBe('high');
	});

	it('detects incomplete task blockers', async () => {
		const plan = createMockPlan();
		// Task 1.1 is completed but missing evidence
		plan.phases[0].tasks[0].status = 'completed';

		mockLoadPlanJsonOnly.mockResolvedValue(plan);
		mockListEvidenceTaskIds.mockResolvedValue(['1.1']);
		mockLoadEvidence.mockResolvedValue(
			foundResult({
				schema_version: '1.0.0',
				task_id: '1.1',
				entries: createMockEvidence('1.1', ['note']), // Missing review + test
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			}),
		);

		const result = await buildEvidenceSummary(tempDir, 1);

		expect(result).not.toBeNull();

		// Should have incomplete task blocker
		const incompleteBlocker = result!.phaseSummaries[0].blockers.find(
			(b) => b.type === 'incomplete_task',
		);
		expect(incompleteBlocker).toBeDefined();
		expect(incompleteBlocker?.taskId).toBe('1.1');
		expect(incompleteBlocker?.severity).toBe('medium');
	});

	it('collects overall blockers across phases', async () => {
		const plan = createMockPlan({
			current_phase: 2,
		});
		// Phase 1 is complete but has blockers
		plan.phases[0].status = 'complete';

		mockLoadPlanJsonOnly.mockResolvedValue(plan);
		mockListEvidenceTaskIds.mockResolvedValue(['1.3']); // Blocked task in phase 1
		mockLoadEvidence.mockResolvedValue(NOT_FOUND);

		const result = await buildEvidenceSummary(tempDir);

		expect(result).not.toBeNull();

		// Overall blockers should include blockers from incomplete phases
		expect(result!.overallBlockers.length).toBeGreaterThan(0);
	});
});
