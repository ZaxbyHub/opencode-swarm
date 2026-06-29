import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plan, Task } from '../../../src/config/plan-schema.js';
import type { LoadEvidenceResult } from '../../../src/evidence/manager.js';
import {
	buildEvidenceSummary,
	type EvidenceSummaryArtifact,
	type TaskEvidenceSummary,
} from '../../../src/services/evidence-summary-service.js';

// Create mock functions
const mockLoadPlanJsonOnly = vi.fn();
const mockLoadEvidence = vi.fn();
const mockListEvidenceTaskIds = vi.fn();

// Mock the plan manager
vi.mock('../../../src/plan/manager.js', () => ({
	loadPlanJsonOnly: () => mockLoadPlanJsonOnly(),
	closePlanTerminalState: async () => {},
	_snapshot_test_exports: {},
}));

// Mock the evidence manager
vi.mock('../../../src/evidence/manager.js', () => ({
	loadEvidence: () => mockLoadEvidence(),
	listEvidenceTaskIds: () => mockListEvidenceTaskIds(),
}));

let tempDir: string;

beforeEach(() => {
	tempDir = join(
		tmpdir(),
		`evidence-summary-load-evidence-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(join(tempDir, '.swarm'), { recursive: true });

	// Reset mocks
	vi.clearAllMocks();
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

describe('loadEvidence discriminated union handling', () => {
	describe('When loadEvidence returns found status', () => {
		it('includes evidence from the bundle in summary', async () => {
			const plan = createMockPlan();
			mockLoadPlanJsonOnly.mockResolvedValue(plan);
			mockListEvidenceTaskIds.mockResolvedValue(['1.1']);

			// Mock loadEvidence to return 'found' status with bundle
			mockLoadEvidence.mockResolvedValue({
				status: 'found',
				bundle: {
					schema_version: '1.0.0',
					task_id: '1.1',
					entries: createMockEvidence('1.1', ['review', 'test', 'approval']),
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
				},
			});

			const result = await buildEvidenceSummary(tempDir, 1);

			expect(result).not.toBeNull();
			const task11 = result!.phaseSummaries[0].tasks.find(
				(t) => t.taskId === '1.1',
			);

			// Should include all evidence from the bundle
			expect(task11?.evidenceCount).toBe(3);
			expect(task11?.hasReview).toBe(true);
			expect(task11?.hasTest).toBe(true);
			expect(task11?.hasApproval).toBe(true);
			expect(task11?.isComplete).toBe(true);
			expect(task11?.missingEvidence).toHaveLength(0);
		});

		it('extracts bundle correctly using discriminated union check', async () => {
			const plan = createMockPlan();
			mockLoadPlanJsonOnly.mockResolvedValue(plan);
			mockListEvidenceTaskIds.mockResolvedValue(['1.1']);

			const mockBundle = {
				schema_version: '1.0.0' as const,
				task_id: '1.1',
				entries: createMockEvidence('1.1', ['review']),
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			};

			// Mock to return 'found' status
			mockLoadEvidence.mockResolvedValue({
				status: 'found',
				bundle: mockBundle,
			});

			const result = await buildEvidenceSummary(tempDir, 1);

			expect(result).not.toBeNull();
			const task11 = result!.phaseSummaries[0].tasks.find(
				(t) => t.taskId === '1.1',
			);

			// Verify bundle was correctly extracted (status === 'found' ? result.bundle : null)
			expect(task11?.evidenceCount).toBe(1);
			expect(task11?.hasReview).toBe(true);
		});

		it('handles bundle with only partial evidence', async () => {
			const plan = createMockPlan();
			mockLoadPlanJsonOnly.mockResolvedValue(plan);
			mockListEvidenceTaskIds.mockResolvedValue(['1.2']);

			// Mock to return 'found' status with partial evidence
			mockLoadEvidence.mockResolvedValue({
				status: 'found',
				bundle: {
					schema_version: '1.0.0',
					task_id: '1.2',
					entries: createMockEvidence('1.2', ['review']), // Missing test
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
				},
			});

			const result = await buildEvidenceSummary(tempDir, 1);

			expect(result).not.toBeNull();
			const task12 = result!.phaseSummaries[0].tasks.find(
				(t) => t.taskId === '1.2',
			);

			// Should have evidence but be incomplete
			expect(task12?.evidenceCount).toBe(1);
			expect(task12?.hasReview).toBe(true);
			expect(task12?.hasTest).toBe(false);
			expect(task12?.isComplete).toBe(false);
			expect(task12?.missingEvidence).toContain('test');
		});
	});

	describe('When loadEvidence returns not_found status', () => {
		it('shows no evidence in summary', async () => {
			const plan = createMockPlan();
			mockLoadPlanJsonOnly.mockResolvedValue(plan);
			mockListEvidenceTaskIds.mockResolvedValue([]);

			// Mock to return 'not_found' status
			mockLoadEvidence.mockResolvedValue({ status: 'not_found' });

			const result = await buildEvidenceSummary(tempDir, 1);

			expect(result).not.toBeNull();
			const task11 = result!.phaseSummaries[0].tasks.find(
				(t) => t.taskId === '1.1',
			);

			// Should have no evidence
			expect(task11?.evidenceCount).toBe(0);
			expect(task11?.hasReview).toBe(false);
			expect(task11?.hasTest).toBe(false);
			expect(task11?.hasApproval).toBe(false);
			expect(task11?.isComplete).toBe(false);
			expect(task11?.missingEvidence).toContain('review');
			expect(task11?.missingEvidence).toContain('test');
		});

		it('extracts null bundle from not_found status', async () => {
			const plan = createMockPlan();
			mockLoadPlanJsonOnly.mockResolvedValue(plan);
			mockListEvidenceTaskIds.mockResolvedValue(['1.1']);

			// Mock to return 'not_found' status
			mockLoadEvidence.mockResolvedValue({ status: 'not_found' });

			const result = await buildEvidenceSummary(tempDir, 1);

			expect(result).not.toBeNull();
			const task11 = result!.phaseSummaries[0].tasks.find(
				(t) => t.taskId === '1.1',
			);

			// Verify bundle extraction: result.status === 'found' ? result.bundle : null
			// Since status is 'not_found', bundle should be null
			expect(task11?.evidenceCount).toBe(0);
		});

		it('handles pending tasks without evidence', async () => {
			const plan = createMockPlan();
			mockLoadPlanJsonOnly.mockResolvedValue(plan);
			mockListEvidenceTaskIds.mockResolvedValue([]);

			// All tasks return 'not_found'
			mockLoadEvidence.mockResolvedValue({ status: 'not_found' });

			const result = await buildEvidenceSummary(tempDir, 1);

			expect(result).not.toBeNull();
			const tasks = result!.phaseSummaries[0].tasks;

			// All tasks should have no evidence
			for (const task of tasks) {
				expect(task.evidenceCount).toBe(0);
				expect(task.isComplete).toBe(false);
			}
		});
	});

	describe('When loadEvidence returns invalid_schema status', () => {
		it('treats as no evidence (same as not_found)', async () => {
			const plan = createMockPlan();
			mockLoadPlanJsonOnly.mockResolvedValue(plan);
			mockListEvidenceTaskIds.mockResolvedValue(['1.1']);

			// Mock to return 'invalid_schema' status
			mockLoadEvidence.mockResolvedValue({
				status: 'invalid_schema',
				errors: ['entries.0.type: Invalid enum value'],
			});

			const result = await buildEvidenceSummary(tempDir, 1);

			expect(result).not.toBeNull();
			const task11 = result!.phaseSummaries[0].tasks.find(
				(t) => t.taskId === '1.1',
			);

			// Should have no evidence (treated same as not_found)
			expect(task11?.evidenceCount).toBe(0);
			expect(task11?.hasReview).toBe(false);
			expect(task11?.hasTest).toBe(false);
			expect(task11?.isComplete).toBe(false);
			expect(task11?.missingEvidence).toContain('review');
			expect(task11?.missingEvidence).toContain('test');
		});

		it('extracts null bundle from invalid_schema status', async () => {
			const plan = createMockPlan();
			mockLoadPlanJsonOnly.mockResolvedValue(plan);
			mockListEvidenceTaskIds.mockResolvedValue(['1.2']);

			// Mock to return 'invalid_schema' status with multiple errors
			mockLoadEvidence.mockResolvedValue({
				status: 'invalid_schema',
				errors: [
					'task_id: Required',
					'entries: Expected array',
					'schema_version: Invalid',
				],
			});

			const result = await buildEvidenceSummary(tempDir, 1);

			expect(result).not.toBeNull();
			const task12 = result!.phaseSummaries[0].tasks.find(
				(t) => t.taskId === '1.2',
			);

			// Verify bundle extraction: result.status === 'found' ? result.bundle : null
			// Since status is 'invalid_schema', bundle should be null
			expect(task12?.evidenceCount).toBe(0);
		});

		it('does not crash on schema validation errors', async () => {
			const plan = createMockPlan();
			mockLoadPlanJsonOnly.mockResolvedValue(plan);
			mockListEvidenceTaskIds.mockResolvedValue(['1.1', '1.2', '1.3']);

			// Mix of status types
			mockLoadEvidence
				.mockResolvedValueOnce({
					status: 'found',
					bundle: {
						schema_version: '1.0.0',
						task_id: '1.1',
						entries: createMockEvidence('1.1', ['review', 'test']),
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
					},
				})
				.mockResolvedValueOnce({
					status: 'invalid_schema',
					errors: ['Invalid schema'],
				})
				.mockResolvedValueOnce({ status: 'not_found' });

			const result = await buildEvidenceSummary(tempDir, 1);

			// Should complete without errors
			expect(result).not.toBeNull();
			expect(result!.phaseSummaries[0].tasks).toHaveLength(3);

			// Verify each task was handled correctly
			const task11 = result!.phaseSummaries[0].tasks.find(
				(t) => t.taskId === '1.1',
			);
			const task12 = result!.phaseSummaries[0].tasks.find(
				(t) => t.taskId === '1.2',
			);
			const task13 = result!.phaseSummaries[0].tasks.find(
				(t) => t.taskId === '1.3',
			);

			expect(task11?.evidenceCount).toBe(2);
			expect(task12?.evidenceCount).toBe(0); // invalid_schema treated as no evidence
			expect(task13?.evidenceCount).toBe(0); // not_found treated as no evidence
		});
	});

	describe('Bundle extraction verification', () => {
		it('correctly extracts bundle for found status', async () => {
			const plan = createMockPlan();
			mockLoadPlanJsonOnly.mockResolvedValue(plan);
			mockListEvidenceTaskIds.mockResolvedValue(['1.1']);

			const mockBundle = {
				schema_version: '1.0.0' as const,
				task_id: '1.1',
				entries: createMockEvidence('1.1', [
					'review',
					'test',
					'approval',
					'diff',
				]),
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			};

			mockLoadEvidence.mockResolvedValue({
				status: 'found',
				bundle: mockBundle,
			});

			const result = await buildEvidenceSummary(tempDir, 1);

			const task11 = result!.phaseSummaries[0].tasks.find(
				(t) => t.taskId === '1.1',
			);

			// Verify bundle = result.status === 'found' ? result.bundle : null worked correctly
			expect(task11?.evidenceCount).toBe(4);
			expect(task11?.hasReview).toBe(true);
			expect(task11?.hasTest).toBe(true);
			expect(task11?.hasApproval).toBe(true);
		});

		it('correctly extracts null for not_found status', async () => {
			const plan = createMockPlan();
			mockLoadPlanJsonOnly.mockResolvedValue(plan);
			mockListEvidenceTaskIds.mockResolvedValue(['1.1']);

			mockLoadEvidence.mockResolvedValue({ status: 'not_found' });

			const result = await buildEvidenceSummary(tempDir, 1);

			const task11 = result!.phaseSummaries[0].tasks.find(
				(t) => t.taskId === '1.1',
			);

			// Verify bundle = result.status === 'found' ? result.bundle : null worked correctly
			expect(task11?.evidenceCount).toBe(0);
		});

		it('correctly extracts null for invalid_schema status', async () => {
			const plan = createMockPlan();
			mockLoadPlanJsonOnly.mockResolvedValue(plan);
			mockListEvidenceTaskIds.mockResolvedValue(['1.1']);

			mockLoadEvidence.mockResolvedValue({
				status: 'invalid_schema',
				errors: ['schema_version: Required'],
			});

			const result = await buildEvidenceSummary(tempDir, 1);

			const task11 = result!.phaseSummaries[0].tasks.find(
				(t) => t.taskId === '1.1',
			);

			// Verify bundle = result.status === 'found' ? result.bundle : null worked correctly
			expect(task11?.evidenceCount).toBe(0);
		});

		it('handles mixed status types across tasks', async () => {
			const plan = createMockPlan();
			mockLoadPlanJsonOnly.mockResolvedValue(plan);
			mockListEvidenceTaskIds.mockResolvedValue(['1.1', '1.2', '1.3']);

			// Task 1.1: found
			// Task 1.2: not_found
			// Task 1.3: invalid_schema
			mockLoadEvidence
				.mockResolvedValueOnce({
					status: 'found',
					bundle: {
						schema_version: '1.0.0',
						task_id: '1.1',
						entries: createMockEvidence('1.1', ['review', 'test']),
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
					},
				})
				.mockResolvedValueOnce({ status: 'not_found' })
				.mockResolvedValueOnce({
					status: 'invalid_schema',
					errors: ['Invalid'],
				});

			const result = await buildEvidenceSummary(tempDir, 1);

			const tasks = result!.phaseSummaries[0].tasks;

			const task11 = tasks.find((t) => t.taskId === '1.1');
			const task12 = tasks.find((t) => t.taskId === '1.2');
			const task13 = tasks.find((t) => t.taskId === '1.3');

			// Task 1.1 (found): has evidence
			expect(task11?.evidenceCount).toBe(2);
			expect(task11?.isComplete).toBe(true);

			// Task 1.2 (not_found): no evidence
			expect(task12?.evidenceCount).toBe(0);
			expect(task12?.isComplete).toBe(false);

			// Task 1.3 (invalid_schema): no evidence
			expect(task13?.evidenceCount).toBe(0);
			expect(task13?.isComplete).toBe(false);
		});
	});

	describe('Edge cases', () => {
		it('handles empty bundle entries array', async () => {
			const plan = createMockPlan();
			mockLoadPlanJsonOnly.mockResolvedValue(plan);
			mockListEvidenceTaskIds.mockResolvedValue(['1.1']);

			// Bundle exists but has no entries
			mockLoadEvidence.mockResolvedValue({
				status: 'found',
				bundle: {
					schema_version: '1.0.0',
					task_id: '1.1',
					entries: [],
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
				},
			});

			const result = await buildEvidenceSummary(tempDir, 1);

			const task11 = result!.phaseSummaries[0].tasks.find(
				(t) => t.taskId === '1.1',
			);

			// Bundle was found, but has no entries
			expect(task11?.evidenceCount).toBe(0);
			expect(task11?.isComplete).toBe(false);
			expect(task11?.missingEvidence).toContain('review');
			expect(task11?.missingEvidence).toContain('test');
		});

		it('infers completed status from evidence when task status is undefined', async () => {
			const plan = createMockPlan();
			// Remove status from task
			plan.phases[0].tasks[0].status = undefined as any;

			mockLoadPlanJsonOnly.mockResolvedValue(plan);
			mockListEvidenceTaskIds.mockResolvedValue(['1.1']);

			mockLoadEvidence.mockResolvedValue({
				status: 'found',
				bundle: {
					schema_version: '1.0.0',
					task_id: '1.1',
					entries: createMockEvidence('1.1', ['review', 'test']),
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
				},
			});

			const result = await buildEvidenceSummary(tempDir, 1);

			const task11 = result!.phaseSummaries[0].tasks.find(
				(t) => t.taskId === '1.1',
			);

			// Should infer 'completed' from evidence presence
			expect(task11?.taskStatus).toBe('completed');
			expect(task11?.isComplete).toBe(true);
		});

		it('tracks lastEvidenceTimestamp correctly from found bundle', async () => {
			const plan = createMockPlan();
			mockLoadPlanJsonOnly.mockResolvedValue(plan);
			mockListEvidenceTaskIds.mockResolvedValue(['1.1']);

			const timestamp1 = '2024-01-01T10:00:00.000Z';
			const timestamp2 = '2024-01-02T11:00:00.000Z';
			const timestamp3 = '2024-01-03T12:00:00.000Z';

			mockLoadEvidence.mockResolvedValue({
				status: 'found',
				bundle: {
					schema_version: '1.0.0',
					task_id: '1.1',
					entries: [
						{
							task_id: '1.1',
							type: 'review',
							timestamp: timestamp1,
							agent: 'test',
							verdict: 'pass',
							summary: 'test',
						},
						{
							task_id: '1.1',
							type: 'test',
							timestamp: timestamp2,
							agent: 'test',
							verdict: 'pass',
							summary: 'test',
						},
						{
							task_id: '1.1',
							type: 'approval',
							timestamp: timestamp3,
							agent: 'test',
							verdict: 'pass',
							summary: 'test',
						},
					],
					created_at: timestamp1,
					updated_at: timestamp3,
				},
			});

			const result = await buildEvidenceSummary(tempDir, 1);

			const task11 = result!.phaseSummaries[0].tasks.find(
				(t) => t.taskId === '1.1',
			);

			// Should track the most recent timestamp
			expect(task11?.lastEvidenceTimestamp).toBe(timestamp3);
		});

		it('has null lastEvidenceTimestamp when bundle is null', async () => {
			const plan = createMockPlan();
			mockLoadPlanJsonOnly.mockResolvedValue(plan);
			mockListEvidenceTaskIds.mockResolvedValue(['1.1']);

			mockLoadEvidence.mockResolvedValue({ status: 'not_found' });

			const result = await buildEvidenceSummary(tempDir, 1);

			const task11 = result!.phaseSummaries[0].tasks.find(
				(t) => t.taskId === '1.1',
			);

			// No bundle = no timestamp
			expect(task11?.lastEvidenceTimestamp).toBeNull();
		});
	});
});
