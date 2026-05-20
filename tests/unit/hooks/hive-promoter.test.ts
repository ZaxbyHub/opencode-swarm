/**
 * Verification tests for hive-promoter.ts
 * Tests all three promotion routes and confirmation advancement logic.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock knowledge-store module
const mockResolveHiveKnowledgePath = vi
	.fn()
	.mockReturnValue('/hive/shared-learnings.jsonl');
const mockResolveHiveRejectedPath = vi
	.fn()
	.mockReturnValue('/hive/shared-learnings-rejected.jsonl');
const mockResolveSwarmKnowledgePath = vi
	.fn()
	.mockReturnValue('/swarm/.swarm/knowledge.jsonl');
const mockReadKnowledge = vi.fn().mockResolvedValue([]);
const mockAppendKnowledge = vi.fn().mockResolvedValue(undefined);
const mockRewriteKnowledge = vi.fn().mockResolvedValue(undefined);
const mockFindNearDuplicate = vi.fn().mockReturnValue(undefined);

vi.mock('../../../src/hooks/knowledge-store.js', () => ({
	resolveHiveKnowledgePath: () => mockResolveHiveKnowledgePath(),
	resolveHiveRejectedPath: () => mockResolveHiveRejectedPath(),
	resolveSwarmKnowledgePath: (dir?: string) =>
		mockResolveSwarmKnowledgePath(dir),
	readKnowledge: (path: string) => mockReadKnowledge(path),
	appendKnowledge: (path: string, data: unknown) =>
		mockAppendKnowledge(path, data),
	rewriteKnowledge: (path: string, data: unknown) =>
		mockRewriteKnowledge(path, data),
	findNearDuplicate: (lesson: string, entries: unknown[], threshold: number) =>
		mockFindNearDuplicate(lesson, entries, threshold),
	computeConfidence: vi.fn().mockReturnValue(0.6),
}));

// Mock knowledge-validator module
const mockValidateLesson = vi.fn().mockReturnValue({
	valid: true,
	layer: 0,
	reason: '',
	severity: undefined,
});

vi.mock('../../../src/hooks/knowledge-validator.js', () => ({
	validateLesson: (lesson: string, existingLessons: string[], meta: unknown) =>
		mockValidateLesson(lesson, existingLessons, meta),
}));

import {
	checkHivePromotions,
	createHivePromoterHook,
} from '../../../src/hooks/hive-promoter.js';
import type {
	HiveKnowledgeEntry,
	KnowledgeConfig,
	SwarmKnowledgeEntry,
} from '../../../src/hooks/knowledge-types.js';

describe('hive-promoter', () => {
	let mockConfig: KnowledgeConfig;
	let baseSwarmEntry: SwarmKnowledgeEntry;

	beforeEach(() => {
		vi.clearAllMocks();

		mockConfig = {
			hive_enabled: true,
			auto_promote_days: 90,
			dedup_threshold: 0.8,
			schema_version: 1,
			validation_enabled: true,
			rejected_max_entries: 20,
			enabled: true,
			swarm_max_entries: 100,
			hive_max_entries: 200,
			max_inject_count: 5,
			scope_filter: ['global'],
			evergreen_confidence: 0.9,
			evergreen_utility: 0.8,
			low_utility_threshold: 0.3,
			min_retrievals_for_utility: 3,
		};

		baseSwarmEntry = {
			id: 'swarm-1',
			tier: 'swarm',
			lesson: 'Use bun for fast test execution',
			category: 'process',
			tags: ['testing', 'performance'],
			scope: 'global',
			confidence: 0.7,
			status: 'promoted',
			confirmed_by: [
				{
					phase_number: 1,
					confirmed_at: '2026-01-01T00:00:00Z',
					project_name: 'projectA',
				},
				{
					phase_number: 2,
					confirmed_at: '2026-01-02T00:00:00Z',
					project_name: 'projectA',
				},
				{
					phase_number: 3,
					confirmed_at: '2026-01-03T00:00:00Z',
					project_name: 'projectA',
				},
			],
			retrieval_outcomes: {
				applied_count: 5,
				succeeded_after_count: 4,
				failed_after_count: 0,
			},
			schema_version: 1,
			created_at: new Date(Date.now() - 50 * 86400000).toISOString(),
			updated_at: new Date().toISOString(),
			hive_eligible: true,
			project_name: 'projectA',
		};

		// Default mocks
		mockReadKnowledge.mockResolvedValue([]);
		mockFindNearDuplicate.mockReturnValue(undefined);
		mockValidateLesson.mockReturnValue({
			valid: true,
			layer: 0,
			reason: '',
			severity: undefined,
		});
	});

	it('Route 1: confirmed-by-3-phases promotes to hive as candidate', async () => {
		// Arrange
		const swarmEntries: SwarmKnowledgeEntry[] = [
			{
				...baseSwarmEntry,
				id: 'swarm-1',
				hive_eligible: true,
				confirmed_by: [
					{
						phase_number: 1,
						confirmed_at: '2026-01-01T00:00:00Z',
						project_name: 'projectA',
					},
					{
						phase_number: 2,
						confirmed_at: '2026-01-02T00:00:00Z',
						project_name: 'projectA',
					},
					{
						phase_number: 3,
						confirmed_at: '2026-01-03T00:00:00Z',
						project_name: 'projectA',
					},
				],
			},
		];

		mockReadKnowledge.mockResolvedValue([]);

		// Act
		await checkHivePromotions(swarmEntries, mockConfig);

		// Assert
		expect(mockAppendKnowledge).toHaveBeenCalledTimes(1);
		const hivePath = mockResolveHiveKnowledgePath();
		expect(mockAppendKnowledge).toHaveBeenCalledWith(
			hivePath,
			expect.any(Object),
		);

		const hiveEntry = mockAppendKnowledge.mock
			.calls[0][1] as HiveKnowledgeEntry;
		expect(hiveEntry.tier).toBe('hive');
		expect(hiveEntry.status).toBe('candidate');
		expect(hiveEntry.confidence).toBe(0.5);
		expect(hiveEntry.confirmed_by).toEqual([]);
		expect(hiveEntry.source_project).toBe('projectA');
	});

	it('Route 1: hive_eligible but only 2 distinct phases does NOT promote', async () => {
		// Arrange
		const swarmEntries: SwarmKnowledgeEntry[] = [
			{
				...baseSwarmEntry,
				hive_eligible: true,
				confirmed_by: [
					{
						phase_number: 1,
						confirmed_at: '2026-01-01T00:00:00Z',
						project_name: 'projectA',
					},
					{
						phase_number: 2,
						confirmed_at: '2026-01-02T00:00:00Z',
						project_name: 'projectA',
					},
				],
			},
		];

		// Act
		await checkHivePromotions(swarmEntries, mockConfig);

		// Assert
		expect(mockAppendKnowledge).not.toHaveBeenCalled();
	});

	it('Route 2: fast-track tag promotes regardless of phase count', async () => {
		// Arrange
		const swarmEntries: SwarmKnowledgeEntry[] = [
			{
				...baseSwarmEntry,
				hive_eligible: undefined,
				tags: ['hive-fast-track', 'testing'],
				confirmed_by: [
					{
						phase_number: 1,
						confirmed_at: '2026-01-01T00:00:00Z',
						project_name: 'projectA',
					},
				],
			},
		];

		// Act
		await checkHivePromotions(swarmEntries, mockConfig);

		// Assert
		expect(mockAppendKnowledge).toHaveBeenCalledTimes(1);
		const hiveEntry = mockAppendKnowledge.mock
			.calls[0][1] as HiveKnowledgeEntry;
		expect(hiveEntry.tier).toBe('hive');
		expect(hiveEntry.status).toBe('candidate');
	});

	it('Route 3: age-based promotes after auto_promote_days', async () => {
		// Arrange
		const swarmEntries: SwarmKnowledgeEntry[] = [
			{
				...baseSwarmEntry,
				hive_eligible: undefined,
				tags: ['testing'],
				confirmed_by: [
					{
						phase_number: 1,
						confirmed_at: '2026-01-01T00:00:00Z',
						project_name: 'projectA',
					},
				],
				created_at: new Date(Date.now() - 100 * 86400000).toISOString(),
			},
		];

		mockConfig.auto_promote_days = 90;

		// Act
		await checkHivePromotions(swarmEntries, mockConfig);

		// Assert
		expect(mockAppendKnowledge).toHaveBeenCalledTimes(1);
		const hiveEntry = mockAppendKnowledge.mock
			.calls[0][1] as HiveKnowledgeEntry;
		expect(hiveEntry.tier).toBe('hive');
		expect(hiveEntry.status).toBe('candidate');
	});

	it('Route 3: entry NOT old enough is not age-promoted', async () => {
		// Arrange
		const swarmEntries: SwarmKnowledgeEntry[] = [
			{
				...baseSwarmEntry,
				hive_eligible: undefined,
				tags: ['testing'],
				confirmed_by: [
					{
						phase_number: 1,
						confirmed_at: '2026-01-01T00:00:00Z',
						project_name: 'projectA',
					},
				],
				created_at: new Date(Date.now() - 10 * 86400000).toISOString(),
			},
		];

		mockConfig.auto_promote_days = 90;

		// Act
		await checkHivePromotions(swarmEntries, mockConfig);

		// Assert
		expect(mockAppendKnowledge).not.toHaveBeenCalled();
	});

	it('Contradiction with high-confidence hive entry blocks promotion', async () => {
		// Arrange
		const existingHiveEntry: HiveKnowledgeEntry = {
			id: 'hive-1',
			tier: 'hive',
			lesson: 'Always use TypeScript strict mode',
			category: 'process',
			tags: ['typescript'],
			scope: 'global',
			confidence: 0.9,
			status: 'established',
			confirmed_by: [],
			retrieval_outcomes: {
				applied_count: 10,
				succeeded_after_count: 8,
				failed_after_count: 1,
			},
			schema_version: 1,
			created_at: '2026-01-01T00:00:00Z',
			updated_at: '2026-01-01T00:00:00Z',
			source_project: 'projectA',
		};

		const swarmEntries: SwarmKnowledgeEntry[] = [
			{
				...baseSwarmEntry,
				id: 'swarm-1',
				lesson: 'Never use TypeScript strict mode',
				hive_eligible: true,
				confirmed_by: [
					{
						phase_number: 1,
						confirmed_at: '2026-01-01T00:00:00Z',
						project_name: 'projectA',
					},
					{
						phase_number: 2,
						confirmed_at: '2026-01-02T00:00:00Z',
						project_name: 'projectA',
					},
					{
						phase_number: 3,
						confirmed_at: '2026-01-03T00:00:00Z',
						project_name: 'projectA',
					},
				],
			},
		];

		mockReadKnowledge.mockResolvedValue([existingHiveEntry]);
		mockFindNearDuplicate.mockReturnValue(undefined); // Not a duplicate

		// Mock validateLesson to detect contradiction
		mockValidateLesson.mockReturnValue({
			valid: false,
			layer: 3,
			reason: 'Contradicts high-confidence hive entry',
			severity: 'error',
		});

		// Act
		await checkHivePromotions(swarmEntries, mockConfig);

		// Assert - should be rejected, not promoted
		const hiveRejectedPath = mockResolveHiveRejectedPath();
		expect(mockAppendKnowledge).toHaveBeenCalledWith(
			hiveRejectedPath,
			expect.objectContaining({
				lesson: 'Never use TypeScript strict mode',
				rejection_layer: 3,
			}),
		);

		// Assert - NOT promoted to hive knowledge
		const hiveKnowledgePath = mockResolveHiveKnowledgePath();
		const appendCalls = mockAppendKnowledge.mock.calls.filter(
			(call) => call[0] === hiveKnowledgePath,
		);
		expect(appendCalls).toHaveLength(0);
	});

	it('hive_enabled: false — no operations performed', async () => {
		// Arrange
		mockConfig.hive_enabled = false;
		const swarmEntries: SwarmKnowledgeEntry[] = [baseSwarmEntry];

		// Act
		await checkHivePromotions(swarmEntries, mockConfig);

		// Assert
		expect(mockReadKnowledge).not.toHaveBeenCalled();
		expect(mockAppendKnowledge).not.toHaveBeenCalled();
		expect(mockRewriteKnowledge).not.toHaveBeenCalled();
	});

	it('Project confirmation advancement: candidate to established after 3 distinct project names', async () => {
		// Arrange
		const existingHiveEntry: HiveKnowledgeEntry = {
			id: 'hive-1',
			tier: 'hive',
			lesson: 'Use bun for testing',
			category: 'process',
			tags: ['testing', 'performance'],
			scope: 'global',
			confidence: 0.5,
			status: 'candidate',
			confirmed_by: [
				{ project_name: 'projectA', confirmed_at: '2026-01-01T00:00:00Z' },
				{ project_name: 'projectB', confirmed_at: '2026-01-02T00:00:00Z' },
			],
			retrieval_outcomes: {
				applied_count: 5,
				succeeded_after_count: 4,
				failed_after_count: 0,
			},
			schema_version: 1,
			created_at: '2026-01-01T00:00:00Z',
			updated_at: '2026-01-01T00:00:00Z',
			source_project: 'projectA',
		};

		const swarmEntries: SwarmKnowledgeEntry[] = [
			{
				...baseSwarmEntry,
				id: 'swarm-1',
				project_name: 'projectC',
				lesson: 'Use bun for testing', // Near-duplicate
			},
		];

		mockReadKnowledge.mockResolvedValue([existingHiveEntry]);

		// Mock findNearDuplicate behavior:
		// First call (isAlreadyInHive): returns undefined (not in hive)
		// Second call (confirmation pass): returns the swarm entry from projectC
		mockFindNearDuplicate
			.mockReturnValueOnce(undefined) // isAlreadyInHive - swarm not in hive yet
			.mockReturnValueOnce(swarmEntries[0]); // confirmation pass - near-duplicate found

		// Act
		await checkHivePromotions(swarmEntries, mockConfig);

		// Assert
		expect(mockRewriteKnowledge).toHaveBeenCalledTimes(1);
		const hivePath = mockResolveHiveKnowledgePath();
		expect(mockRewriteKnowledge).toHaveBeenCalledWith(
			hivePath,
			expect.any(Array),
		);

		const updatedHive = mockRewriteKnowledge.mock
			.calls[0][1] as HiveKnowledgeEntry[];
		const updatedEntry = updatedHive.find((e) => e.id === 'hive-1');
		expect(updatedEntry).toBeDefined();
		expect(updatedEntry!.status).toBe('established');
		expect(updatedEntry!.confirmed_by).toHaveLength(3);
		expect(updatedEntry!.confirmed_by).toContainEqual({
			project_name: 'projectC',
			confirmed_at: expect.any(String),
		});
	});

	it('No double-count: same project in hive entry confirmed_by is not added again', async () => {
		// Arrange
		const existingHiveEntry: HiveKnowledgeEntry = {
			id: 'hive-1',
			tier: 'hive',
			lesson: 'Use bun for testing',
			category: 'process',
			tags: ['testing', 'performance'],
			scope: 'global',
			confidence: 0.5,
			status: 'candidate',
			confirmed_by: [
				{ project_name: 'projectB', confirmed_at: '2026-01-02T00:00:00Z' },
			],
			retrieval_outcomes: {
				applied_count: 5,
				succeeded_after_count: 4,
				failed_after_count: 0,
			},
			schema_version: 1,
			created_at: '2026-01-01T00:00:00Z',
			updated_at: '2026-01-01T00:00:00Z',
			source_project: 'projectA',
		};

		const swarmEntries: SwarmKnowledgeEntry[] = [
			{
				...baseSwarmEntry,
				id: 'swarm-1',
				project_name: 'projectB', // Same as existing confirmation
				lesson: 'Use bun for testing', // Near-duplicate
			},
		];

		mockReadKnowledge.mockResolvedValue([existingHiveEntry]);

		// Mock findNearDuplicate:
		// First call: undefined (not in hive)
		// Second call: swarm entry from projectB (same project)
		mockFindNearDuplicate
			.mockReturnValueOnce(undefined)
			.mockReturnValueOnce(swarmEntries[0]);

		// Act
		await checkHivePromotions(swarmEntries, mockConfig);

		// Assert - should NOT rewrite since no modification
		expect(mockRewriteKnowledge).not.toHaveBeenCalled();
	});

	it('Already-in-hive entry is skipped (dedup)', async () => {
		// Arrange
		const existingHiveEntry: HiveKnowledgeEntry = {
			id: 'hive-1',
			tier: 'hive',
			lesson: 'Use bun for testing',
			category: 'process',
			tags: ['testing', 'performance'],
			scope: 'global',
			confidence: 0.5,
			status: 'candidate',
			confirmed_by: [],
			retrieval_outcomes: {
				applied_count: 5,
				succeeded_after_count: 4,
				failed_after_count: 0,
			},
			schema_version: 1,
			created_at: '2026-01-01T00:00:00Z',
			updated_at: '2026-01-01T00:00:00Z',
			source_project: 'projectA',
		};

		const swarmEntries: SwarmKnowledgeEntry[] = [
			{
				...baseSwarmEntry,
				hive_eligible: true,
				confirmed_by: [
					{
						phase_number: 1,
						confirmed_at: '2026-01-01T00:00:00Z',
						project_name: 'projectB',
					},
					{
						phase_number: 2,
						confirmed_at: '2026-01-02T00:00:00Z',
						project_name: 'projectB',
					},
					{
						phase_number: 3,
						confirmed_at: '2026-01-03T00:00:00Z',
						project_name: 'projectB',
					},
				],
			},
		];

		mockReadKnowledge.mockResolvedValue([existingHiveEntry]);

		// findNearDuplicate returns the hive entry (already in hive)
		mockFindNearDuplicate.mockReturnValue(existingHiveEntry);

		// Act
		await checkHivePromotions(swarmEntries, mockConfig);

		// Assert - should NOT append (skipped as duplicate)
		const hivePath = mockResolveHiveKnowledgePath();
		const appendCalls = mockAppendKnowledge.mock.calls.filter(
			(call) => call[0] === hivePath,
		);
		expect(appendCalls).toHaveLength(0);
	});

	it('createHivePromoterHook: reads swarm entries and calls checkHivePromotions', async () => {
		// Arrange
		const mockSwarmEntries: SwarmKnowledgeEntry[] = [baseSwarmEntry];
		const hiveEntries: HiveKnowledgeEntry[] = [];

		mockReadKnowledge
			.mockResolvedValueOnce(mockSwarmEntries) // For swarm entries
			.mockResolvedValueOnce(hiveEntries); // For hive entries

		// Mock resolveSwarmKnowledgePath to return proper path
		mockResolveSwarmKnowledgePath.mockReturnValue(
			'/project/.swarm/knowledge.jsonl',
		);

		// Act
		const hook = createHivePromoterHook('/project', mockConfig);
		await hook({}, {});

		// Assert
		expect(mockReadKnowledge).toHaveBeenCalled();
		const swarmPath = '/project/.swarm/knowledge.jsonl';
		const swarmReadCalls = mockReadKnowledge.mock.calls.filter(
			(call) => call[0] === swarmPath,
		);
		expect(swarmReadCalls.length).toBeGreaterThan(0);
	});
});

// ============================================================================
// Schema Mismatch Fix Verification Tests
// ============================================================================

describe('promoteToHive - Schema Mismatch Fix Verification', () => {
	let mockConfig: KnowledgeConfig;
	let baseSwarmEntry: SwarmKnowledgeEntry;

	beforeEach(() => {
		vi.clearAllMocks();
		mockReadKnowledge.mockResolvedValue([]);
		mockFindNearDuplicate.mockReturnValue(undefined);
		mockValidateLesson.mockReturnValue({
			valid: true,
			layer: 0,
			reason: '',
			severity: undefined,
		});

		mockConfig = {
			hive_enabled: true,
			auto_promote_days: 90,
			dedup_threshold: 0.8,
			schema_version: 1,
			validation_enabled: true,
			rejected_max_entries: 20,
			enabled: true,
			swarm_max_entries: 100,
			hive_max_entries: 200,
			max_inject_count: 5,
			scope_filter: ['global'],
			evergreen_confidence: 0.9,
			evergreen_utility: 0.8,
			low_utility_threshold: 0.3,
			min_retrievals_for_utility: 3,
		};

		baseSwarmEntry = {
			id: 'swarm-1',
			tier: 'swarm',
			lesson: 'Use bun for testing',
			category: 'process',
			tags: ['testing', 'performance'],
			scope: 'global',
			confidence: 0.7,
			status: 'promoted',
			confirmed_by: [
				{
					phase_number: 1,
					confirmed_at: '2026-01-01T00:00:00Z',
					project_name: 'projectA',
				},
			],
			retrieval_outcomes: {
				applied_count: 5,
				succeeded_after_count: 4,
				failed_after_count: 0,
			},
			schema_version: 1,
			created_at: new Date(Date.now() - 50 * 86400000).toISOString(),
			updated_at: new Date().toISOString(),
			hive_eligible: true,
			project_name: 'projectA',
		};
	});

	it('promoteToHive function exists and is exported', async () => {
		const module = await import('../../../src/hooks/hive-promoter.js');
		expect(typeof module.promoteToHive).toBe('function');
	});

	it('promoteToHive uses resolveHiveKnowledgePath for correct path', async () => {
		const module = await import('../../../src/hooks/hive-promoter.js');
		const testLesson =
			'Test lesson for path verification with sufficient length';

		await module.promoteToHive('/test-dir', testLesson, 'process');

		// Verify appendKnowledge was called with the hive path
		expect(mockAppendKnowledge).toHaveBeenCalledTimes(1);
		const calledPath = mockAppendKnowledge.mock.calls[0][0];
		expect(calledPath).toBe(mockResolveHiveKnowledgePath());
	});

	it('promoteToHive validates lesson before writing', async () => {
		const module = await import('../../../src/hooks/hive-promoter.js');
		const testLesson = 'Test lesson for validation with sufficient length';

		await module.promoteToHive('/test-dir', testLesson, 'process');

		// Verify validateLesson was called
		expect(mockValidateLesson).toHaveBeenCalledTimes(1);
		expect(mockValidateLesson).toHaveBeenCalledWith(
			testLesson,
			[],
			expect.objectContaining({
				category: 'process',
				scope: 'global',
				confidence: 1.0,
			}),
		);
	});

	it('promoteToHive rejects invalid lesson', async () => {
		const module = await import('../../../src/hooks/hive-promoter.js');
		const shortLesson = 'abc';

		mockValidateLesson.mockReturnValue({
			valid: false,
			layer: 0,
			reason: 'Lesson too short',
			severity: 'error',
		});

		await expect(
			module.promoteToHive('/test-dir', shortLesson, 'process'),
		).rejects.toThrow('rejected by validator');
	});

	it('promoteToHive creates HiveKnowledgeEntry with all required fields', async () => {
		const module = await import('../../../src/hooks/hive-promoter.js');
		const testLesson =
			'Test lesson for schema verification with sufficient length';

		await module.promoteToHive('/test-dir', testLesson, 'process');

		expect(mockAppendKnowledge).toHaveBeenCalledTimes(1);
		const hiveEntry = mockAppendKnowledge.mock
			.calls[0][1] as HiveKnowledgeEntry;

		// Verify all required fields exist
		expect(hiveEntry).toHaveProperty('id');
		expect(hiveEntry).toHaveProperty('tier');
		expect(hiveEntry).toHaveProperty('lesson');
		expect(hiveEntry).toHaveProperty('category');
		expect(hiveEntry).toHaveProperty('tags');
		expect(hiveEntry).toHaveProperty('scope');
		expect(hiveEntry).toHaveProperty('confidence');
		expect(hiveEntry).toHaveProperty('status');
		expect(hiveEntry).toHaveProperty('confirmed_by');
		expect(hiveEntry).toHaveProperty('retrieval_outcomes');
		expect(hiveEntry).toHaveProperty('schema_version');
		expect(hiveEntry).toHaveProperty('created_at');
		expect(hiveEntry).toHaveProperty('updated_at');
		expect(hiveEntry).toHaveProperty('source_project');
	});

	it('promoteToHive sets confidence to 1.0', async () => {
		const module = await import('../../../src/hooks/hive-promoter.js');
		const testLesson = 'Test lesson for confidence verification';

		await module.promoteToHive('/test-dir', testLesson, 'process');

		const hiveEntry = mockAppendKnowledge.mock
			.calls[0][1] as HiveKnowledgeEntry;
		expect(hiveEntry.confidence).toBe(1.0);
	});

	it('promoteToHive sets status to promoted', async () => {
		const module = await import('../../../src/hooks/hive-promoter.js');
		const testLesson = 'Test lesson for status verification';

		await module.promoteToHive('/test-dir', testLesson, 'process');

		const hiveEntry = mockAppendKnowledge.mock
			.calls[0][1] as HiveKnowledgeEntry;
		expect(hiveEntry.status).toBe('promoted');
	});

	it('promoteToHive sets tier to hive', async () => {
		const module = await import('../../../src/hooks/hive-promoter.js');
		const testLesson = 'Test lesson for tier verification';

		await module.promoteToHive('/test-dir', testLesson, 'process');

		const hiveEntry = mockAppendKnowledge.mock
			.calls[0][1] as HiveKnowledgeEntry;
		expect(hiveEntry.tier).toBe('hive');
	});

	it('promoteToHive returns confirmation message', async () => {
		const module = await import('../../../src/hooks/hive-promoter.js');
		const testLesson = 'Test lesson for return value verification';

		const result = await module.promoteToHive(
			'/test-dir',
			testLesson,
			'process',
		);

		expect(result).toContain('Promoted to hive');
		expect(result).toContain('confidence: 1.0');
		expect(result).toContain('source: manual');
	});

	it('promoteToHive returns near-duplicate message for duplicates', async () => {
		const module = await import('../../../src/hooks/hive-promoter.js');
		const testLesson = 'Test lesson for duplicate detection';

		mockFindNearDuplicate.mockReturnValue({} as HiveKnowledgeEntry);

		const result = await module.promoteToHive(
			'/test-dir',
			testLesson,
			'process',
		);

		expect(result).toContain('already exists');
		expect(result).toContain('near-duplicate');
		expect(mockAppendKnowledge).not.toHaveBeenCalled();
	});
});

describe('promoteFromSwarm - Schema Mismatch Fix Verification', () => {
	let mockConfig: KnowledgeConfig;
	let baseSwarmEntry: SwarmKnowledgeEntry;

	beforeEach(() => {
		vi.clearAllMocks();
		mockReadKnowledge.mockResolvedValue([]);
		mockFindNearDuplicate.mockReturnValue(undefined);
		mockValidateLesson.mockReturnValue({
			valid: true,
			layer: 0,
			reason: '',
			severity: undefined,
		});

		mockConfig = {
			hive_enabled: true,
			auto_promote_days: 90,
			dedup_threshold: 0.8,
			schema_version: 1,
			validation_enabled: true,
			rejected_max_entries: 20,
			enabled: true,
			swarm_max_entries: 100,
			hive_max_entries: 200,
			max_inject_count: 5,
			scope_filter: ['global'],
			evergreen_confidence: 0.9,
			evergreen_utility: 0.8,
			low_utility_threshold: 0.3,
			min_retrievals_for_utility: 3,
		};

		baseSwarmEntry = {
			id: 'swarm-1',
			tier: 'swarm',
			lesson: 'Use bun for testing',
			category: 'process',
			tags: ['testing', 'performance'],
			scope: 'global',
			confidence: 0.7,
			status: 'promoted',
			confirmed_by: [
				{
					phase_number: 1,
					confirmed_at: '2026-01-01T00:00:00Z',
					project_name: 'projectA',
				},
			],
			retrieval_outcomes: {
				applied_count: 5,
				succeeded_after_count: 4,
				failed_after_count: 0,
			},
			schema_version: 1,
			created_at: new Date(Date.now() - 50 * 86400000).toISOString(),
			updated_at: new Date().toISOString(),
			hive_eligible: true,
			project_name: 'projectA',
		};
	});

	it('promoteFromSwarm function exists and is exported', async () => {
		const module = await import('../../../src/hooks/hive-promoter.js');
		expect(typeof module.promoteFromSwarm).toBe('function');
	});

	it('promoteFromSwarm reads from resolveSwarmKnowledgePath', async () => {
		const module = await import('../../../src/hooks/hive-promoter.js');

		const swarmEntry: SwarmKnowledgeEntry = {
			...baseSwarmEntry,
			id: 'test-lesson-id',
			lesson: 'Test lesson from swarm with sufficient length',
		};

		mockReadKnowledge.mockResolvedValue([swarmEntry]);

		await module.promoteFromSwarm('/test-dir', 'test-lesson-id');

		// Verify readKnowledge was called with the swarm path
		expect(mockReadKnowledge).toHaveBeenCalledWith(
			mockResolveSwarmKnowledgePath('/test-dir'),
		);
	});

	it('promoteFromSwarm finds lesson by ID', async () => {
		const module = await import('../../../src/hooks/hive-promoter.js');

		const swarmEntry: SwarmKnowledgeEntry = {
			...baseSwarmEntry,
			id: 'test-lesson-id',
			lesson: 'Test lesson for ID lookup with sufficient length',
		};

		mockReadKnowledge.mockResolvedValue([swarmEntry]);

		const result = await module.promoteFromSwarm('/test-dir', 'test-lesson-id');

		expect(result).toContain('Promoted lesson');
		expect(result).toContain('test-lesson-id');
	});

	it('promoteFromSwarm throws error if lesson not found', async () => {
		const module = await import('../../../src/hooks/hive-promoter.js');

		mockReadKnowledge.mockResolvedValue([]);

		await expect(
			module.promoteFromSwarm('/test-dir', 'non-existent-id'),
		).rejects.toThrow('not found');
	});

	it('promoteFromSwarm throws error with specific message for missing lesson', async () => {
		const module = await import('../../../src/hooks/hive-promoter.js');

		mockReadKnowledge.mockResolvedValue([]);

		try {
			await module.promoteFromSwarm('/test-dir', 'test-lesson-id');
			expect(false).toBe(true); // Should not reach here
		} catch (error) {
			expect((error as Error).message).toContain('not found');
			expect((error as Error).message).toContain('.swarm/knowledge.jsonl');
		}
	});

	it('promoteFromSwarm validates before writing', async () => {
		const module = await import('../../../src/hooks/hive-promoter.js');

		const swarmEntry: SwarmKnowledgeEntry = {
			...baseSwarmEntry,
			id: 'test-lesson-id',
			lesson: 'Valid lesson with sufficient length for testing',
		};

		// Mock readKnowledge to return swarm entries first, then empty hive entries
		mockReadKnowledge
			.mockResolvedValueOnce([swarmEntry]) // first call - swarm entries
			.mockResolvedValueOnce([]); // second call - hive entries (empty)

		await module.promoteFromSwarm('/test-dir', 'test-lesson-id');

		// Verify validateLesson was called
		expect(mockValidateLesson).toHaveBeenCalledTimes(1);
		expect(mockValidateLesson).toHaveBeenCalledWith(
			swarmEntry.lesson,
			[],
			expect.objectContaining({
				category: swarmEntry.category,
				scope: swarmEntry.scope,
				confidence: swarmEntry.confidence,
			}),
		);
	});

	it('promoteFromSwarm rejects invalid lesson', async () => {
		const module = await import('../../../src/hooks/hive-promoter.js');

		const swarmEntry: SwarmKnowledgeEntry = {
			...baseSwarmEntry,
			id: 'test-lesson-id',
			lesson: 'abc', // Too short
		};

		mockReadKnowledge.mockResolvedValue([swarmEntry]);
		mockValidateLesson.mockReturnValue({
			valid: false,
			layer: 0,
			reason: 'Lesson too short',
			severity: 'error',
		});

		await expect(
			module.promoteFromSwarm('/test-dir', 'test-lesson-id'),
		).rejects.toThrow('rejected by validator');
	});

	it('promoteFromSwarm creates HiveKnowledgeEntry with all required fields', async () => {
		const module = await import('../../../src/hooks/hive-promoter.js');

		const swarmEntry: SwarmKnowledgeEntry = {
			...baseSwarmEntry,
			id: 'test-lesson-id',
			lesson: 'Test lesson for schema verification from swarm',
			category: 'architecture',
			tags: ['test', 'swarm'],
			scope: 'stack:react',
		};

		mockReadKnowledge.mockResolvedValue([swarmEntry]);

		await module.promoteFromSwarm('/test-dir', 'test-lesson-id');

		const hiveEntry = mockAppendKnowledge.mock
			.calls[0][1] as HiveKnowledgeEntry;

		// Verify all required fields exist
		expect(hiveEntry).toHaveProperty('id');
		expect(hiveEntry).toHaveProperty('tier');
		expect(hiveEntry).toHaveProperty('lesson');
		expect(hiveEntry).toHaveProperty('category');
		expect(hiveEntry).toHaveProperty('tags');
		expect(hiveEntry).toHaveProperty('scope');
		expect(hiveEntry).toHaveProperty('confidence');
		expect(hiveEntry).toHaveProperty('status');
		expect(hiveEntry).toHaveProperty('confirmed_by');
		expect(hiveEntry).toHaveProperty('retrieval_outcomes');
		expect(hiveEntry).toHaveProperty('schema_version');
		expect(hiveEntry).toHaveProperty('created_at');
		expect(hiveEntry).toHaveProperty('updated_at');
		expect(hiveEntry).toHaveProperty('source_project');
	});

	it('promoteFromSwarm sets confidence to 1.0', async () => {
		const module = await import('../../../src/hooks/hive-promoter.js');

		const swarmEntry: SwarmKnowledgeEntry = {
			...baseSwarmEntry,
			id: 'test-lesson-id',
			lesson: 'Test lesson for confidence from swarm',
			confidence: 0.5,
		};

		mockReadKnowledge.mockResolvedValue([swarmEntry]);

		await module.promoteFromSwarm('/test-dir', 'test-lesson-id');

		const hiveEntry = mockAppendKnowledge.mock
			.calls[0][1] as HiveKnowledgeEntry;
		expect(hiveEntry.confidence).toBe(1.0);
	});

	it('promoteFromSwarm sets status to promoted', async () => {
		const module = await import('../../../src/hooks/hive-promoter.js');

		const swarmEntry: SwarmKnowledgeEntry = {
			...baseSwarmEntry,
			id: 'test-lesson-id',
			lesson: 'Test lesson for status from swarm',
		};

		mockReadKnowledge.mockResolvedValue([swarmEntry]);

		await module.promoteFromSwarm('/test-dir', 'test-lesson-id');

		const hiveEntry = mockAppendKnowledge.mock
			.calls[0][1] as HiveKnowledgeEntry;
		expect(hiveEntry.status).toBe('promoted');
	});

	it('promoteFromSwarm preserves lesson from swarm', async () => {
		const module = await import('../../../src/hooks/hive-promoter.js');

		const testLesson = 'This is the original lesson from swarm';
		const swarmEntry: SwarmKnowledgeEntry = {
			...baseSwarmEntry,
			id: 'test-lesson-id',
			lesson: testLesson,
		};

		mockReadKnowledge.mockResolvedValue([swarmEntry]);

		await module.promoteFromSwarm('/test-dir', 'test-lesson-id');

		const hiveEntry = mockAppendKnowledge.mock
			.calls[0][1] as HiveKnowledgeEntry;
		expect(hiveEntry.lesson).toBe(testLesson);
	});

	it('promoteFromSwarm preserves category from swarm', async () => {
		const module = await import('../../../src/hooks/hive-promoter.js');

		const swarmEntry: SwarmKnowledgeEntry = {
			...baseSwarmEntry,
			id: 'test-lesson-id',
			lesson: 'Test lesson for category preservation',
			category: 'security',
		};

		mockReadKnowledge.mockResolvedValue([swarmEntry]);

		await module.promoteFromSwarm('/test-dir', 'test-lesson-id');

		const hiveEntry = mockAppendKnowledge.mock
			.calls[0][1] as HiveKnowledgeEntry;
		expect(hiveEntry.category).toBe('security');
	});

	it('promoteFromSwarm preserves tags from swarm', async () => {
		const module = await import('../../../src/hooks/hive-promoter.js');

		const testTags = ['react', 'testing', 'hooks'];
		const swarmEntry: SwarmKnowledgeEntry = {
			...baseSwarmEntry,
			id: 'test-lesson-id',
			lesson: 'Test lesson for tags preservation',
			tags: testTags,
		};

		mockReadKnowledge.mockResolvedValue([swarmEntry]);

		await module.promoteFromSwarm('/test-dir', 'test-lesson-id');

		const hiveEntry = mockAppendKnowledge.mock
			.calls[0][1] as HiveKnowledgeEntry;
		expect(hiveEntry.tags).toEqual(testTags);
	});

	it('promoteFromSwarm preserves scope from swarm', async () => {
		const module = await import('../../../src/hooks/hive-promoter.js');

		const testScope = 'stack:nextjs';
		const swarmEntry: SwarmKnowledgeEntry = {
			...baseSwarmEntry,
			id: 'test-lesson-id',
			lesson: 'Test lesson for scope preservation',
			scope: testScope,
		};

		mockReadKnowledge.mockResolvedValue([swarmEntry]);

		await module.promoteFromSwarm('/test-dir', 'test-lesson-id');

		const hiveEntry = mockAppendKnowledge.mock
			.calls[0][1] as HiveKnowledgeEntry;
		expect(hiveEntry.scope).toBe(testScope);
	});

	it('promoteFromSwarm sets source_project from swarm entry', async () => {
		const module = await import('../../../src/hooks/hive-promoter.js');

		const projectName = 'my-awesome-project';
		const swarmEntry: SwarmKnowledgeEntry = {
			...baseSwarmEntry,
			id: 'test-lesson-id',
			lesson: 'Test lesson for source_project',
			project_name: projectName,
		};

		mockReadKnowledge.mockResolvedValue([swarmEntry]);

		await module.promoteFromSwarm('/test-dir', 'test-lesson-id');

		const hiveEntry = mockAppendKnowledge.mock
			.calls[0][1] as HiveKnowledgeEntry;
		expect(hiveEntry.source_project).toBe(projectName);
	});

	it('promoteFromSwarm generates new ID (not swarm ID)', async () => {
		const module = await import('../../../src/hooks/hive-promoter.js');

		const swarmEntry: SwarmKnowledgeEntry = {
			...baseSwarmEntry,
			id: 'swarm-123',
			lesson: 'Test lesson for ID generation',
		};

		mockReadKnowledge.mockResolvedValue([swarmEntry]);

		await module.promoteFromSwarm('/test-dir', 'swarm-123');

		const hiveEntry = mockAppendKnowledge.mock
			.calls[0][1] as HiveKnowledgeEntry;
		expect(hiveEntry.id).not.toBe(swarmEntry.id);
	});

	it('promoteFromSwarm returns confirmation message', async () => {
		const module = await import('../../../src/hooks/hive-promoter.js');

		const swarmEntry: SwarmKnowledgeEntry = {
			...baseSwarmEntry,
			id: 'test-lesson-id',
			lesson: 'Test lesson for return value',
		};

		mockReadKnowledge.mockResolvedValue([swarmEntry]);

		const result = await module.promoteFromSwarm('/test-dir', 'test-lesson-id');

		expect(result).toContain('Promoted lesson');
		expect(result).toContain('test-lesson-id');
		expect(result).toContain('from swarm to hive');
	});

	it('promoteFromSwarm returns near-duplicate message for duplicates', async () => {
		const module = await import('../../../src/hooks/hive-promoter.js');

		const swarmEntry: SwarmKnowledgeEntry = {
			...baseSwarmEntry,
			id: 'test-lesson-id',
			lesson: 'Test lesson for duplicate detection in promoteFromSwarm',
		};

		mockReadKnowledge.mockResolvedValue([swarmEntry]);
		mockFindNearDuplicate.mockReturnValue({} as HiveKnowledgeEntry);

		const result = await module.promoteFromSwarm('/test-dir', 'test-lesson-id');

		expect(result).toContain('already exists');
		expect(result).toContain('near-duplicate');
		expect(mockAppendKnowledge).not.toHaveBeenCalled();
	});
});

describe('Hive promoter module exports', () => {
	it('src/hooks/hive-promoter.ts exports both functions', async () => {
		const module = await import('../../../src/hooks/hive-promoter.js');

		expect(typeof module.promoteToHive).toBe('function');
		expect(typeof module.promoteFromSwarm).toBe('function');
	});
});

// ============================================================================
// R5 Cross-Platform source_project basename Fix Verification
// ============================================================================

describe('R5: promoteToHive source_project cross-platform fix', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockReadKnowledge.mockResolvedValue([]);
		mockFindNearDuplicate.mockReturnValue(undefined);
		mockValidateLesson.mockReturnValue({
			valid: true,
			layer: 0,
			reason: '',
			severity: undefined,
		});
	});

	it('promoteToHive uses path.basename(directory) for source_project', async () => {
		const module = await import('../../../src/hooks/hive-promoter.js');
		const testLesson =
			'Test lesson for source_project path basename verification';

		// Use a directory with a clear basename
		await module.promoteToHive(
			'/Users/testuser/my-project',
			testLesson,
			'process',
		);

		const hiveEntry = mockAppendKnowledge.mock
			.calls[0][1] as HiveKnowledgeEntry;
		// path.basename on Unix extracts 'my-project' from '/Users/testuser/my-project'
		expect(hiveEntry.source_project).toBe('my-project');
	});

	it.skipIf(process.platform !== 'win32')(
		'promoteToHive handles Windows-style paths correctly',
		async () => {
			const module = await import('../../../src/hooks/hive-promoter.js');
			const testLesson = 'Test lesson for Windows path verification';

			// Use a Windows-style path
			await module.promoteToHive(
				'C:\\Users\\testuser\\my-project',
				testLesson,
				'process',
			);

			const hiveEntry = mockAppendKnowledge.mock
				.calls[0][1] as HiveKnowledgeEntry;
			// path.basename on Windows extracts 'my-project' from 'C:\Users\testuser\my-project'
			expect(hiveEntry.source_project).toBe('my-project');
		},
	);

	it('promoteToHive falls back to "unknown" when path.basename returns empty', async () => {
		const module = await import('../../../src/hooks/hive-promoter.js');
		const testLesson = 'Test lesson for empty basename fallback verification';

		// Empty directory path should result in empty basename
		await module.promoteToHive('', testLesson, 'process');

		const hiveEntry = mockAppendKnowledge.mock
			.calls[0][1] as HiveKnowledgeEntry;
		// path.basename('') returns '' which is falsy, so should fallback to 'unknown'
		expect(hiveEntry.source_project).toBe('unknown');
	});

	it('promoteToHive falls back to "unknown" for root path', async () => {
		const module = await import('../../../src/hooks/hive-promoter.js');
		const testLesson = 'Test lesson for root path fallback verification';

		// Root path - basename may be empty string on some platforms
		await module.promoteToHive('/', testLesson, 'process');

		const hiveEntry = mockAppendKnowledge.mock
			.calls[0][1] as HiveKnowledgeEntry;
		// path.basename('/') returns '' on Unix, should fallback to 'unknown'
		expect(hiveEntry.source_project).toBe('unknown');
	});

	it('promoteToHive correctly extracts basename from nested paths', async () => {
		const module = await import('../../../src/hooks/hive-promoter.js');
		const testLesson = 'Test lesson for nested path basename';

		// Deeply nested path
		await module.promoteToHive(
			'/home/user/projects/my-awesome-app/src',
			testLesson,
			'process',
		);

		const hiveEntry = mockAppendKnowledge.mock
			.calls[0][1] as HiveKnowledgeEntry;
		// Should get 'src' (the last component)
		expect(hiveEntry.source_project).toBe('src');
	});
});

// ============================================================================
// Task 3.3 & 3.4: Weighted Advancement Tests
// ============================================================================

describe('Task 3.3: weighted advancement behavior', () => {
	let mockConfig: KnowledgeConfig;
	let baseSwarmEntry: SwarmKnowledgeEntry;

	beforeEach(() => {
		vi.clearAllMocks();
		mockReadKnowledge.mockResolvedValue([]);
		mockFindNearDuplicate.mockReturnValue(undefined);
		mockValidateLesson.mockReturnValue({
			valid: true,
			layer: 0,
			reason: '',
			severity: undefined,
		});

		// Base swarm entry for these tests
		baseSwarmEntry = {
			id: 'swarm-base',
			tier: 'swarm',
			lesson: 'Use bun for testing',
			category: 'process',
			tags: ['testing', 'performance'],
			scope: 'global',
			confidence: 0.7,
			status: 'promoted',
			confirmed_by: [
				{
					phase_number: 1,
					confirmed_at: '2026-01-01T00:00:00Z',
					project_name: 'projectA',
				},
			],
			retrieval_outcomes: {
				applied_count: 5,
				succeeded_after_count: 4,
				failed_after_count: 0,
			},
			schema_version: 1,
			created_at: new Date(Date.now() - 50 * 86400000).toISOString(),
			updated_at: new Date().toISOString(),
			hive_eligible: true,
			project_name: 'projectA',
		};

		// Config with weighted scoring enabled
		mockConfig = {
			hive_enabled: true,
			auto_promote_days: 90,
			dedup_threshold: 0.8,
			schema_version: 1,
			validation_enabled: true,
			rejected_max_entries: 20,
			enabled: true,
			swarm_max_entries: 100,
			hive_max_entries: 200,
			max_inject_count: 5,
			scope_filter: ['global'],
			evergreen_confidence: 0.9,
			evergreen_utility: 0.8,
			low_utility_threshold: 0.3,
			min_retrievals_for_utility: 3,
			same_project_weight: 0.5,
			cross_project_weight: 1.0,
			encounter_increment: 0.1,
			min_encounter_score: 0.0,
			max_encounter_score: 5.0,
			initial_encounter_score: 1.0,
		};
	});

	it('cross-project encounter increments encounter_score by encounter_increment * cross_project_weight', async () => {
		// Arrange: existing hive entry with initial encounter_score
		const existingHiveEntry: HiveKnowledgeEntry = {
			id: 'hive-1',
			tier: 'hive',
			lesson: 'Use bun for testing',
			category: 'process',
			tags: ['testing'],
			scope: 'global',
			confidence: 0.5,
			status: 'candidate',
			confirmed_by: [
				{ project_name: 'projectA', confirmed_at: '2026-01-01T00:00:00Z' },
			],
			retrieval_outcomes: {
				applied_count: 5,
				succeeded_after_count: 4,
				failed_after_count: 0,
			},
			schema_version: 1,
			created_at: '2026-01-01T00:00:00Z',
			updated_at: '2026-01-01T00:00:00Z',
			source_project: 'projectA',
			encounter_score: 1.0, // initial score
		};

		// Swarm entry from a DIFFERENT project (cross-project)
		const swarmEntries: SwarmKnowledgeEntry[] = [
			{
				...baseSwarmEntry,
				id: 'swarm-1',
				project_name: 'projectB', // different from source_project
				lesson: 'Use bun for testing', // near-duplicate
			},
		];

		mockReadKnowledge.mockResolvedValue([existingHiveEntry]);
		mockFindNearDuplicate.mockReturnValue(swarmEntries[0]);

		// Act
		const result = await checkHivePromotions(swarmEntries, mockConfig);

		// Assert: cross-project weight (1.0) * increment (0.1) = 0.1 added
		expect(result.encounters_incremented).toBe(1);
		expect(mockRewriteKnowledge).toHaveBeenCalledTimes(1);

		const updatedHive = mockRewriteKnowledge.mock
			.calls[0][1] as HiveKnowledgeEntry[];
		const updatedEntry = updatedHive.find((e) => e.id === 'hive-1');
		expect(updatedEntry!.encounter_score).toBe(1.1); // 1.0 + 0.1
	});

	it('same-project encounter increments encounter_score by encounter_increment * same_project_weight', async () => {
		// Arrange: existing hive entry with no prior confirmations (to test weighting without double-count prevention)
		const existingHiveEntry: HiveKnowledgeEntry = {
			id: 'hive-1',
			tier: 'hive',
			lesson: 'Use bun for testing',
			category: 'process',
			tags: ['testing'],
			scope: 'global',
			confidence: 0.5,
			status: 'candidate',
			confirmed_by: [], // Empty to avoid double-count prevention
			retrieval_outcomes: {
				applied_count: 5,
				succeeded_after_count: 4,
				failed_after_count: 0,
			},
			schema_version: 1,
			created_at: '2026-01-01T00:00:00Z',
			updated_at: '2026-01-01T00:00:00Z',
			source_project: 'projectA',
			encounter_score: 1.0,
		};

		// Swarm entry from SAME project (same-project)
		const swarmEntries: SwarmKnowledgeEntry[] = [
			{
				...baseSwarmEntry,
				id: 'swarm-1',
				project_name: 'projectA', // SAME as source_project - tests same-project weighting
				lesson: 'Use bun for testing',
			},
		];

		mockReadKnowledge.mockResolvedValue([existingHiveEntry]);
		mockFindNearDuplicate.mockReturnValue(swarmEntries[0]);

		// Act
		const result = await checkHivePromotions(swarmEntries, mockConfig);

		// Assert: same-project weight (0.5) * increment (0.1) = 0.05 added
		expect(result.encounters_incremented).toBe(1);
		expect(mockRewriteKnowledge).toHaveBeenCalledTimes(1);

		const updatedHive = mockRewriteKnowledge.mock
			.calls[0][1] as HiveKnowledgeEntry[];
		const updatedEntry = updatedHive.find((e) => e.id === 'hive-1');
		expect(updatedEntry!.encounter_score).toBe(1.05); // 1.0 + (0.1 * 0.5)
	});

	it('same-project encounters result in slower progression than cross-project', async () => {
		// This test verifies that multiple same-project confirmations take longer to advance
		// than cross-project confirmations due to weighted scoring

		// Setup: candidate with 2 existing project confirmations
		const existingHiveEntry: HiveKnowledgeEntry = {
			id: 'hive-1',
			tier: 'hive',
			lesson: 'Use bun for testing',
			category: 'process',
			tags: ['testing'],
			scope: 'global',
			confidence: 0.5,
			status: 'candidate',
			confirmed_by: [
				{ project_name: 'projectA', confirmed_at: '2026-01-01T00:00:00Z' },
				{ project_name: 'projectB', confirmed_at: '2026-01-02T00:00:00Z' },
			],
			retrieval_outcomes: {
				applied_count: 5,
				succeeded_after_count: 4,
				failed_after_count: 0,
			},
			schema_version: 1,
			created_at: '2026-01-01T00:00:00Z',
			updated_at: '2026-01-01T00:00:00Z',
			source_project: 'projectA',
			encounter_score: 1.0,
		};

		// Need projectC confirmation to reach 3 distinct projects for advancement
		// Using cross-project (projectC) should advance
		const swarmEntries: SwarmKnowledgeEntry[] = [
			{
				...baseSwarmEntry,
				id: 'swarm-1',
				project_name: 'projectC', // cross-project from projectA
				lesson: 'Use bun for testing',
			},
		];

		mockReadKnowledge.mockResolvedValue([existingHiveEntry]);
		mockFindNearDuplicate.mockReturnValue(swarmEntries[0]);

		// Act
		const result = await checkHivePromotions(swarmEntries, mockConfig);

		// Assert: cross-project should advance to established (3 distinct projects)
		expect(result.advancements).toBe(1);

		const updatedHive = mockRewriteKnowledge.mock
			.calls[0][1] as HiveKnowledgeEntry[];
		const updatedEntry = updatedHive.find((e) => e.id === 'hive-1');
		expect(updatedEntry!.status).toBe('established');
		expect(updatedEntry!.confirmed_by).toHaveLength(3);
	});

	it('encounter_score respects min_encounter_score boundary', async () => {
		const existingHiveEntry: HiveKnowledgeEntry = {
			id: 'hive-1',
			tier: 'hive',
			lesson: 'Use bun for testing',
			category: 'process',
			tags: ['testing'],
			scope: 'global',
			confidence: 0.5,
			status: 'candidate',
			confirmed_by: [],
			retrieval_outcomes: {
				applied_count: 5,
				succeeded_after_count: 4,
				failed_after_count: 0,
			},
			schema_version: 1,
			created_at: '2026-01-01T00:00:00Z',
			updated_at: '2026-01-01T00:00:00Z',
			source_project: 'projectA',
			encounter_score: 0.05, // very low
		};

		const swarmEntries: SwarmKnowledgeEntry[] = [
			{
				...baseSwarmEntry,
				id: 'swarm-1',
				project_name: 'projectB',
				lesson: 'Use bun for testing',
			},
		];

		// Set min_encounter_score to 0.1
		mockConfig.min_encounter_score = 0.1;

		mockReadKnowledge.mockResolvedValue([existingHiveEntry]);
		mockFindNearDuplicate.mockReturnValue(swarmEntries[0]);

		// Act
		await checkHivePromotions(swarmEntries, mockConfig);

		const updatedHive = mockRewriteKnowledge.mock
			.calls[0][1] as HiveKnowledgeEntry[];
		const updatedEntry = updatedHive.find((e) => e.id === 'hive-1');
		// Score should be clamped to min_encounter_score (0.1), not go below
		expect(updatedEntry!.encounter_score).toBeGreaterThanOrEqual(0.1);
	});

	it('encounter_score respects max_encounter_score boundary', async () => {
		const existingHiveEntry: HiveKnowledgeEntry = {
			id: 'hive-1',
			tier: 'hive',
			lesson: 'Use bun for testing',
			category: 'process',
			tags: ['testing'],
			scope: 'global',
			confidence: 0.5,
			status: 'candidate',
			confirmed_by: [],
			retrieval_outcomes: {
				applied_count: 5,
				succeeded_after_count: 4,
				failed_after_count: 0,
			},
			schema_version: 1,
			created_at: '2026-01-01T00:00:00Z',
			updated_at: '2026-01-01T00:00:00Z',
			source_project: 'projectA',
			encounter_score: 4.95, // near max
		};

		const swarmEntries: SwarmKnowledgeEntry[] = [
			{
				...baseSwarmEntry,
				id: 'swarm-1',
				project_name: 'projectB',
				lesson: 'Use bun for testing',
			},
		];

		// Set max_encounter_score to 5.0
		mockConfig.max_encounter_score = 5.0;

		mockReadKnowledge.mockResolvedValue([existingHiveEntry]);
		mockFindNearDuplicate.mockReturnValue(swarmEntries[0]);

		// Act
		await checkHivePromotions(swarmEntries, mockConfig);

		const updatedHive = mockRewriteKnowledge.mock
			.calls[0][1] as HiveKnowledgeEntry[];
		const updatedEntry = updatedHive.find((e) => e.id === 'hive-1');
		// Score should be clamped to max_encounter_score (5.0)
		expect(updatedEntry!.encounter_score).toBeLessThanOrEqual(5.0);
	});
});

describe('Task 3.3: same-run double-count prevention', () => {
	let mockConfig: KnowledgeConfig;
	let baseSwarmEntry: SwarmKnowledgeEntry;

	beforeEach(() => {
		vi.clearAllMocks();
		mockReadKnowledge.mockResolvedValue([]);
		mockFindNearDuplicate.mockReturnValue(undefined);
		mockValidateLesson.mockReturnValue({
			valid: true,
			layer: 0,
			reason: '',
			severity: undefined,
		});

		// Base swarm entry for these tests
		baseSwarmEntry = {
			id: 'swarm-base',
			tier: 'swarm',
			lesson: 'Use bun for testing',
			category: 'process',
			tags: ['testing', 'performance'],
			scope: 'global',
			confidence: 0.7,
			status: 'promoted',
			confirmed_by: [
				{
					phase_number: 1,
					confirmed_at: '2026-01-01T00:00:00Z',
					project_name: 'projectA',
				},
			],
			retrieval_outcomes: {
				applied_count: 5,
				succeeded_after_count: 4,
				failed_after_count: 0,
			},
			schema_version: 1,
			created_at: new Date(Date.now() - 50 * 86400000).toISOString(),
			updated_at: new Date().toISOString(),
			hive_eligible: true,
			project_name: 'projectA',
		};

		mockConfig = {
			hive_enabled: true,
			auto_promote_days: 90,
			dedup_threshold: 0.8,
			schema_version: 1,
			validation_enabled: true,
			rejected_max_entries: 20,
			enabled: true,
			swarm_max_entries: 100,
			hive_max_entries: 200,
			max_inject_count: 5,
			scope_filter: ['global'],
			evergreen_confidence: 0.9,
			evergreen_utility: 0.8,
			low_utility_threshold: 0.3,
			min_retrievals_for_utility: 3,
			same_project_weight: 0.5,
			cross_project_weight: 1.0,
			encounter_increment: 0.1,
			min_encounter_score: 0.0,
			max_encounter_score: 5.0,
			initial_encounter_score: 1.0,
		};
	});

	it('skips same project confirmation that already exists in confirmed_by', async () => {
		// This is the key same-run double-count prevention test
		// The hive entry already has projectB in confirmed_by
		const existingHiveEntry: HiveKnowledgeEntry = {
			id: 'hive-1',
			tier: 'hive',
			lesson: 'Use bun for testing',
			category: 'process',
			tags: ['testing'],
			scope: 'global',
			confidence: 0.5,
			status: 'candidate',
			confirmed_by: [
				{ project_name: 'projectA', confirmed_at: '2026-01-01T00:00:00Z' },
				{ project_name: 'projectB', confirmed_at: '2026-01-02T00:00:00Z' }, // already confirmed
			],
			retrieval_outcomes: {
				applied_count: 5,
				succeeded_after_count: 4,
				failed_after_count: 0,
			},
			schema_version: 1,
			created_at: '2026-01-01T00:00:00Z',
			updated_at: '2026-01-01T00:00:00Z',
			source_project: 'projectA',
			encounter_score: 1.0,
		};

		// Swarm entry from projectB (same as existing confirmation)
		const swarmEntries: SwarmKnowledgeEntry[] = [
			{
				...baseSwarmEntry,
				id: 'swarm-1',
				project_name: 'projectB', // same as existing confirmed_by entry
				lesson: 'Use bun for testing',
			},
		];

		mockReadKnowledge.mockResolvedValue([existingHiveEntry]);
		// findNearDuplicate returns the swarm entry (near-duplicate found)
		mockFindNearDuplicate.mockReturnValue(swarmEntries[0]);

		// Act
		const result = await checkHivePromotions(swarmEntries, mockConfig);

		// Assert: no modification should occur - same project already confirmed
		expect(result.encounters_incremented).toBe(0); // NOT incremented
		expect(result.advancements).toBe(0);
		expect(mockRewriteKnowledge).not.toHaveBeenCalled(); // No rewrite needed
	});

	it('does not add duplicate project confirmation to confirmed_by array', async () => {
		const existingHiveEntry: HiveKnowledgeEntry = {
			id: 'hive-1',
			tier: 'hive',
			lesson: 'Use bun for testing',
			category: 'process',
			tags: ['testing'],
			scope: 'global',
			confidence: 0.5,
			status: 'candidate',
			confirmed_by: [
				{ project_name: 'projectB', confirmed_at: '2026-01-02T00:00:00Z' },
			],
			retrieval_outcomes: {
				applied_count: 5,
				succeeded_after_count: 4,
				failed_after_count: 0,
			},
			schema_version: 1,
			created_at: '2026-01-01T00:00:00Z',
			updated_at: '2026-01-01T00:00:00Z',
			source_project: 'projectA',
			encounter_score: 1.0,
		};

		const swarmEntries: SwarmKnowledgeEntry[] = [
			{
				...baseSwarmEntry,
				id: 'swarm-1',
				project_name: 'projectB', // duplicate
				lesson: 'Use bun for testing',
			},
		];

		mockReadKnowledge.mockResolvedValue([existingHiveEntry]);
		mockFindNearDuplicate.mockReturnValue(swarmEntries[0]);

		// Act
		await checkHivePromotions(swarmEntries, mockConfig);

		// Assert: confirmed_by should still have only 1 entry
		const rewriteCalls = mockRewriteKnowledge.mock.calls;
		if (rewriteCalls.length > 0) {
			const updatedHive = rewriteCalls[0][1] as HiveKnowledgeEntry[];
			const updatedEntry = updatedHive.find((e) => e.id === 'hive-1');
			expect(updatedEntry!.confirmed_by).toHaveLength(1);
		}
		// Most importantly: rewrite should NOT be called when no change is needed
		expect(mockRewriteKnowledge).not.toHaveBeenCalled();
	});
});

// Mock curator module for curator-summary tests
const mockReadCuratorSummary = vi.fn();
const mockWriteCuratorSummary = vi.fn();

vi.mock('../../../src/hooks/curator.js', () => ({
	readCuratorSummary: (...args: unknown[]) => mockReadCuratorSummary(...args),
	writeCuratorSummary: (...args: unknown[]) => mockWriteCuratorSummary(...args),
}));

describe('Task 3.4: curator-summary feedback integration', () => {
	let mockConfig: KnowledgeConfig;
	let baseSwarmEntry: SwarmKnowledgeEntry;

	beforeEach(() => {
		vi.clearAllMocks();
		mockReadKnowledge.mockResolvedValue([]);
		mockFindNearDuplicate.mockReturnValue(undefined);
		mockValidateLesson.mockReturnValue({
			valid: true,
			layer: 0,
			reason: '',
			severity: undefined,
		});
		mockReadCuratorSummary.mockResolvedValue(null);
		mockWriteCuratorSummary.mockResolvedValue(undefined);

		// Base swarm entry for these tests
		baseSwarmEntry = {
			id: 'swarm-base',
			tier: 'swarm',
			lesson: 'Use bun for testing',
			category: 'process',
			tags: ['testing', 'performance'],
			scope: 'global',
			confidence: 0.7,
			status: 'promoted',
			confirmed_by: [
				{
					phase_number: 1,
					confirmed_at: '2026-01-01T00:00:00Z',
					project_name: 'projectA',
				},
			],
			retrieval_outcomes: {
				applied_count: 5,
				succeeded_after_count: 4,
				failed_after_count: 0,
			},
			schema_version: 1,
			created_at: new Date(Date.now() - 50 * 86400000).toISOString(),
			updated_at: new Date().toISOString(),
			hive_eligible: true,
			project_name: 'projectA',
		};

		mockConfig = {
			hive_enabled: true,
			auto_promote_days: 90,
			dedup_threshold: 0.8,
			schema_version: 1,
			validation_enabled: true,
			rejected_max_entries: 20,
			enabled: true,
			swarm_max_entries: 100,
			hive_max_entries: 200,
			max_inject_count: 5,
			scope_filter: ['global'],
			evergreen_confidence: 0.9,
			evergreen_utility: 0.8,
			low_utility_threshold: 0.3,
			min_retrievals_for_utility: 3,
			same_project_weight: 0.5,
			cross_project_weight: 1.0,
			encounter_increment: 0.1,
			min_encounter_score: 0.0,
			max_encounter_score: 5.0,
			initial_encounter_score: 1.0,
		};
	});

	it('createHivePromoterHook adds knowledge recommendation with promotion summary', async () => {
		// Arrange: existing curator summary
		const curatorSummary = {
			schema_version: 1,
			session_id: 'test-session',
			last_updated: '2024-01-01T00:00:00Z',
			last_phase_covered: 1,
			digest: 'Test digest',
			phase_digests: [],
			compliance_observations: [],
			knowledge_recommendations: [] as unknown[],
		};

		mockReadCuratorSummary.mockResolvedValue(curatorSummary);

		// Swarm entry that will be promoted
		const swarmEntries: SwarmKnowledgeEntry[] = [
			{
				...baseSwarmEntry,
				id: 'swarm-1',
				hive_eligible: true,
				confirmed_by: [
					{
						phase_number: 1,
						confirmed_at: '2026-01-01T00:00:00Z',
						project_name: 'projectA',
					},
					{
						phase_number: 2,
						confirmed_at: '2026-01-02T00:00:00Z',
						project_name: 'projectA',
					},
					{
						phase_number: 3,
						confirmed_at: '2026-01-03T00:00:00Z',
						project_name: 'projectA',
					},
				],
			},
		];

		mockReadKnowledge.mockResolvedValueOnce(swarmEntries); // swarm entries
		mockReadKnowledge.mockResolvedValueOnce([]); // hive entries

		// Act
		const hook = createHivePromoterHook('/test-project', mockConfig);
		await hook({}, {});

		// Assert: writeCuratorSummary should be called with updated recommendations
		expect(mockWriteCuratorSummary).toHaveBeenCalledTimes(1);

		const writtenSummary = mockWriteCuratorSummary.mock.calls[0][1];
		expect(writtenSummary.knowledge_recommendations).toBeDefined();
		expect(Array.isArray(writtenSummary.knowledge_recommendations)).toBe(true);
		expect(writtenSummary.knowledge_recommendations.length).toBeGreaterThan(0);

		// Verify the recommendation contains promotion summary
		const lastRecommendation = writtenSummary.knowledge_recommendations[
			writtenSummary.knowledge_recommendations.length - 1
		] as { action: string; lesson: string; reason: string };
		expect(lastRecommendation.action).toBe('promote');
		expect(lastRecommendation.lesson).toContain('Hive promotion');
		expect(lastRecommendation.lesson).toContain('new');
		expect(lastRecommendation.lesson).toContain('encounters');
		expect(lastRecommendation.lesson).toContain('advancements');
	});

	it('createHivePromoterHook includes all summary fields in reason JSON', async () => {
		// Arrange
		const curatorSummary = {
			schema_version: 1,
			session_id: 'test-session',
			last_updated: '2024-01-01T00:00:00Z',
			last_phase_covered: 1,
			digest: 'Test digest',
			phase_digests: [],
			compliance_observations: [],
			knowledge_recommendations: [] as unknown[],
		};

		mockReadCuratorSummary.mockResolvedValue(curatorSummary);

		// Swarm entry that will be promoted
		const swarmEntries: SwarmKnowledgeEntry[] = [
			{
				...baseSwarmEntry,
				id: 'swarm-1',
				hive_eligible: true,
				confirmed_by: [
					{
						phase_number: 1,
						confirmed_at: '2026-01-01T00:00:00Z',
						project_name: 'projectA',
					},
					{
						phase_number: 2,
						confirmed_at: '2026-01-02T00:00:00Z',
						project_name: 'projectA',
					},
					{
						phase_number: 3,
						confirmed_at: '2026-01-03T00:00:00Z',
						project_name: 'projectA',
					},
				],
			},
		];

		mockReadKnowledge.mockResolvedValueOnce(swarmEntries);
		mockReadKnowledge.mockResolvedValueOnce([]);

		// Act
		const hook = createHivePromoterHook('/test-project', mockConfig);
		await hook({}, {});

		// Assert
		const writtenSummary = mockWriteCuratorSummary.mock.calls[0][1];
		const lastRecommendation = writtenSummary.knowledge_recommendations[
			writtenSummary.knowledge_recommendations.length - 1
		] as { action: string; lesson: string; reason: string };

		// Parse the reason JSON
		const reason = JSON.parse(lastRecommendation.reason);
		expect(reason).toHaveProperty('timestamp');
		expect(reason).toHaveProperty('new_promotions');
		expect(reason).toHaveProperty('encounters_incremented');
		expect(reason).toHaveProperty('advancements');
		expect(reason).toHaveProperty('total_hive_entries');
	});

	it('createHivePromoterHook does not write when curator summary is null', async () => {
		// Arrange: no curator summary exists
		mockReadCuratorSummary.mockResolvedValue(null);

		const swarmEntries: SwarmKnowledgeEntry[] = [baseSwarmEntry];
		mockReadKnowledge.mockResolvedValueOnce(swarmEntries);
		mockReadKnowledge.mockResolvedValueOnce([]);

		// Act
		const hook = createHivePromoterHook('/test-project', mockConfig);
		await hook({}, {});

		// Assert: should NOT write curator summary when it doesn't exist
		expect(mockWriteCuratorSummary).not.toHaveBeenCalled();
	});

	it('createHivePromoterHook updates last_updated timestamp', async () => {
		// Arrange
		const oldTimestamp = '2024-01-01T00:00:00Z';
		const curatorSummary = {
			schema_version: 1,
			session_id: 'test-session',
			last_updated: oldTimestamp,
			last_phase_covered: 1,
			digest: 'Test digest',
			phase_digests: [],
			compliance_observations: [],
			knowledge_recommendations: [] as unknown[],
		};

		mockReadCuratorSummary.mockResolvedValue(curatorSummary);

		const swarmEntries: SwarmKnowledgeEntry[] = [
			{
				...baseSwarmEntry,
				id: 'swarm-1',
				hive_eligible: true,
				confirmed_by: [
					{
						phase_number: 1,
						confirmed_at: '2026-01-01T00:00:00Z',
						project_name: 'projectA',
					},
					{
						phase_number: 2,
						confirmed_at: '2026-01-02T00:00:00Z',
						project_name: 'projectA',
					},
					{
						phase_number: 3,
						confirmed_at: '2026-01-03T00:00:00Z',
						project_name: 'projectA',
					},
				],
			},
		];

		mockReadKnowledge.mockResolvedValueOnce(swarmEntries);
		mockReadKnowledge.mockResolvedValueOnce([]);

		// Act
		const hook = createHivePromoterHook('/test-project', mockConfig);
		await hook({}, {});

		// Assert
		const writtenSummary = mockWriteCuratorSummary.mock.calls[0][1];
		expect(writtenSummary.last_updated).not.toBe(oldTimestamp);
		// Should be a recent timestamp
		const writtenTime = new Date(writtenSummary.last_updated).getTime();
		const now = Date.now();
		expect(writtenTime).toBeLessThanOrEqual(now);
		expect(now - writtenTime).toBeLessThan(5000); // within 5 seconds
	});

	it('createHivePromoterHook preserves existing knowledge_recommendations', async () => {
		// Arrange: curator summary with existing recommendations
		const existingRecommendation = {
			action: 'test' as const,
			lesson: 'Existing lesson',
			reason: '{}',
		};

		const curatorSummary = {
			schema_version: 1,
			session_id: 'test-session',
			last_updated: '2024-01-01T00:00:00Z',
			last_phase_covered: 1,
			digest: 'Test digest',
			phase_digests: [],
			compliance_observations: [],
			knowledge_recommendations: [existingRecommendation],
		};

		mockReadCuratorSummary.mockResolvedValue(curatorSummary);

		const swarmEntries: SwarmKnowledgeEntry[] = [
			{
				...baseSwarmEntry,
				id: 'swarm-1',
				hive_eligible: true,
				confirmed_by: [
					{
						phase_number: 1,
						confirmed_at: '2026-01-01T00:00:00Z',
						project_name: 'projectA',
					},
					{
						phase_number: 2,
						confirmed_at: '2026-01-02T00:00:00Z',
						project_name: 'projectA',
					},
					{
						phase_number: 3,
						confirmed_at: '2026-01-03T00:00:00Z',
						project_name: 'projectA',
					},
				],
			},
		];

		mockReadKnowledge.mockResolvedValueOnce(swarmEntries);
		mockReadKnowledge.mockResolvedValueOnce([]);

		// Act
		const hook = createHivePromoterHook('/test-project', mockConfig);
		await hook({}, {});

		// Assert: existing recommendation should be preserved
		const writtenSummary = mockWriteCuratorSummary.mock.calls[0][1];
		expect(writtenSummary.knowledge_recommendations.length).toBe(2);
		expect(writtenSummary.knowledge_recommendations[0]).toEqual(
			existingRecommendation,
		);
	});
});

// ===========================================================================
// Canonical hive path and schema field verification (issue #633 tests 1-4)
// ===========================================================================

describe('promoteToHive - canonical hive path and field names', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockReadKnowledge.mockResolvedValue([]);
		mockFindNearDuplicate.mockReturnValue(undefined);
		mockValidateLesson.mockReturnValue({
			valid: true,
			layer: 0,
			reason: '',
			severity: undefined,
		});
	});

	it('writes to the path returned by resolveHiveKnowledgePath, not to any hardcoded path', async () => {
		const module = await import('../../../src/hooks/hive-promoter.js');
		await module.promoteToHive(
			'/test-dir',
			'A lesson long enough to pass validation checks',
			'process',
		);

		expect(mockAppendKnowledge).toHaveBeenCalledTimes(1);
		const writtenPath = mockAppendKnowledge.mock.calls[0][0] as string;
		expect(writtenPath).toBe('/hive/shared-learnings.jsonl');
		expect(writtenPath).not.toContain('hive-knowledge.jsonl');
	});

	it('entry uses canonical field name scope (not scope_tag)', async () => {
		const module = await import('../../../src/hooks/hive-promoter.js');
		await module.promoteToHive(
			'/test-dir',
			'A lesson long enough to pass validation checks',
			'process',
		);

		const entry = mockAppendKnowledge.mock.calls[0][1] as Record<
			string,
			unknown
		>;
		expect(entry).toHaveProperty('scope');
		expect(entry).not.toHaveProperty('scope_tag');
	});

	it('entry uses canonical field name retrieval_outcomes (not retrievalOutcomes)', async () => {
		const module = await import('../../../src/hooks/hive-promoter.js');
		await module.promoteToHive(
			'/test-dir',
			'A lesson long enough to pass validation checks',
			'process',
		);

		const entry = mockAppendKnowledge.mock.calls[0][1] as Record<
			string,
			unknown
		>;
		expect(entry).toHaveProperty('retrieval_outcomes');
		expect(entry).not.toHaveProperty('retrievalOutcomes');
	});

	it('entry does not include promotedAt (not in HiveKnowledgeEntry schema)', async () => {
		const module = await import('../../../src/hooks/hive-promoter.js');
		await module.promoteToHive(
			'/test-dir',
			'A lesson long enough to pass validation checks',
			'process',
		);

		const entry = mockAppendKnowledge.mock.calls[0][1] as Record<
			string,
			unknown
		>;
		expect(entry).not.toHaveProperty('promotedAt');
	});
});

describe('promoteFromSwarm - canonical hive path', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFindNearDuplicate.mockReturnValue(undefined);
		mockValidateLesson.mockReturnValue({
			valid: true,
			layer: 0,
			reason: '',
			severity: undefined,
		});
	});

	it('writes promoted entry to the path returned by resolveHiveKnowledgePath', async () => {
		const module = await import('../../../src/hooks/hive-promoter.js');
		const swarmEntry = {
			id: 'swarm-promote-test',
			tier: 'swarm' as const,
			lesson: 'A lesson long enough to pass validation and be promoted to hive',
			category: 'process' as const,
			tags: ['testing'],
			scope: 'global',
			confidence: 0.8,
			status: 'promoted' as const,
			confirmed_by: [
				{ project_name: 'proj', confirmed_at: '2026-01-01T00:00:00Z' },
			],
			retrieval_outcomes: {
				applied_count: 3,
				succeeded_after_count: 3,
				failed_after_count: 0,
			},
			schema_version: 1,
			created_at: '2026-01-01T00:00:00Z',
			updated_at: '2026-01-01T00:00:00Z',
			project_name: 'proj',
			hive_eligible: true,
		};

		mockReadKnowledge
			.mockResolvedValueOnce([swarmEntry])
			.mockResolvedValueOnce([]);

		await module.promoteFromSwarm('/test-dir', 'swarm-promote-test');

		const hiveWriteCall = mockAppendKnowledge.mock.calls.find((call) =>
			(call[0] as string).includes('shared-learnings'),
		);
		expect(hiveWriteCall).toBeDefined();
		const writtenPath = hiveWriteCall![0] as string;
		expect(writtenPath).toBe('/hive/shared-learnings.jsonl');
		expect(writtenPath).not.toContain('hive-knowledge.jsonl');
	});

	it('no write call targets hive-knowledge.jsonl across both promote paths', async () => {
		const module = await import('../../../src/hooks/hive-promoter.js');
		const swarmEntry = {
			id: 'no-orphan-test',
			tier: 'swarm' as const,
			lesson:
				'A lesson verifying no orphaned file is written under any code path',
			category: 'architecture' as const,
			tags: [],
			scope: 'global',
			confidence: 0.9,
			status: 'promoted' as const,
			confirmed_by: [
				{ project_name: 'proj', confirmed_at: '2026-01-01T00:00:00Z' },
			],
			retrieval_outcomes: {
				applied_count: 1,
				succeeded_after_count: 1,
				failed_after_count: 0,
			},
			schema_version: 1,
			created_at: '2026-01-01T00:00:00Z',
			updated_at: '2026-01-01T00:00:00Z',
			project_name: 'proj',
			hive_eligible: true,
		};

		mockReadKnowledge
			.mockResolvedValueOnce([swarmEntry])
			.mockResolvedValueOnce([]);

		await module.promoteFromSwarm('/test-dir', 'no-orphan-test');

		for (const call of mockAppendKnowledge.mock.calls) {
			expect(call[0] as string).not.toContain('hive-knowledge.jsonl');
		}
		for (const call of mockRewriteKnowledge.mock.calls) {
			expect(call[0] as string).not.toContain('hive-knowledge.jsonl');
		}
	});
});
